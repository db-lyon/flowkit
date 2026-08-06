import { spawn } from 'node:child_process';
import { BaseTask, type TaskResult } from './base-task.js';

export interface ShellTaskOptions {
  command: string;
  cwd?: string;
  timeout?: number;
  /** Cancels this individual shell invocation when aborted. */
  signal?: AbortSignal;
}

/** Stable error text returned when a shell invocation is cancelled. */
export const SHELL_TASK_CANCELLED_MESSAGE = 'Shell command cancelled';

// A killed child should emit `close`; this only bounds a pathological case
// where the operating system never reports that closure.
const TERMINATION_GRACE_MS = 1_000;
const WINDOWS_TASKKILL_GRACE_MS = 50;

/**
 * Task that executes a shell command.
 *
 * Stdout and stderr stream line-by-line through `this.logger` as they
 * arrive, so observers (per-step hooks, log-shipping clients, live UIs)
 * see output in real time instead of waiting for the command to finish:
 *
 *   logger.info({ stream: 'stdout' }, line)
 *   logger.warn({ stream: 'stderr' }, line)
 *
 * The final `TaskResult.data.output` / `stderr` still contains the full
 * captured text for callers that just want the end result.
 *
 * Usage in YAML:
 *   steps:
 *     2:
 *       task: shell
 *       options:
 *         command: npm run build
 *         cwd: /path/to/project    # optional
 *         timeout: 300000           # optional, default 5 min
 */
export class ShellTask extends BaseTask<ShellTaskOptions> {
  get taskName() {
    return `shell:${this.options.command}`;
  }

  protected validate(): void {
    if (!this.options.command || typeof this.options.command !== 'string') {
      throw new Error('ShellTask requires a "command" option');
    }
  }

  async execute(): Promise<TaskResult> {
    const { command, cwd, timeout = 300_000, signal } = this.options;

    // Do this before creating the Promise (and, importantly, before spawn) so
    // an already-cancelled run cannot launch a process at all.
    if (signal?.aborted) {
      return {
        success: false,
        error: new Error(SHELL_TASK_CANCELLED_MESSAGE),
        data: { exitCode: null, signal: null, stderr: '', stdout: '' },
      };
    }

    return new Promise<TaskResult>((resolve) => {
      // Cross-platform: route through the platform shell so command strings
      // like "npm run build" or "echo $HOME && ls" work the same way they
      // did under execSync.
      const child = spawn(command, {
        cwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A signal-bearing POSIX invocation gets its own process group so its
        // shell and ordinary descendants can be terminated together. Keep the
        // legacy spawn behavior unchanged when no signal was supplied.
        ...(signal && process.platform !== 'win32' ? { detached: true } : {}),
      });

      let stdoutBuf = '';
      let stderrBuf = '';
      let stdoutTail = '';
      let stderrTail = '';
      let terminalCause: 'running' | 'cancelled' | 'timedOut' = 'running';
      let settled = false;
      let abortListenerRegistered = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let terminationTimer: ReturnType<typeof setTimeout> | undefined;
      let directKillTimer: ReturnType<typeof setTimeout> | undefined;

      const emitLines = (
        chunk: string,
        tailRef: 'stdout' | 'stderr',
        emit: (line: string) => void,
      ) => {
        // Maintain a small tail buffer so we never emit a partial line.
        // Each newline we see flushes everything before it as one line;
        // the remainder carries over to the next chunk.
        const combined = (tailRef === 'stdout' ? stdoutTail : stderrTail) + chunk;
        const parts = combined.split(/\r?\n/);
        const remainder = parts.pop() ?? '';
        if (tailRef === 'stdout') stdoutTail = remainder;
        else stderrTail = remainder;
        for (const line of parts) {
          if (line.length > 0) emit(line);
        }
      };

      child.stdout?.setEncoding('utf-8');
      child.stderr?.setEncoding('utf-8');

      child.stdout?.on('data', (chunk: string) => {
        stdoutBuf += chunk;
        emitLines(chunk, 'stdout', (line) => {
          this.logger.info({ stream: 'stdout' }, line);
        });
      });

      child.stderr?.on('data', (chunk: string) => {
        stderrBuf += chunk;
        emitLines(chunk, 'stderr', (line) => {
          this.logger.warn({ stream: 'stderr' }, line);
        });
      });

      const flushTails = () => {
        if (stdoutTail.length > 0) {
          this.logger.info({ stream: 'stdout' }, stdoutTail);
          // Keep the existing no-signal result behavior: captured partial
          // lines are represented both when read and when flushed at close.
          if (!signal) stdoutBuf += stdoutTail;
          stdoutTail = '';
        }
        if (stderrTail.length > 0) {
          this.logger.warn({ stream: 'stderr' }, stderrTail);
          if (!signal) stderrBuf += stderrTail;
          stderrTail = '';
        }
      };

      const removeAbortListener = () => {
        if (!abortListenerRegistered) return;
        abortListenerRegistered = false;
        signal?.removeEventListener('abort', onAbort);
      };

      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (terminationTimer) clearTimeout(terminationTimer);
        if (directKillTimer) clearTimeout(directKillTimer);
        removeAbortListener();
      };

      const resultData = (
        exitCode: number | null,
        exitSignal: NodeJS.Signals | null,
        includeSignal = true,
      ) => {
        flushTails();
        return {
          exitCode,
          ...(includeSignal ? { signal: exitSignal } : {}),
          stderr: stderrBuf.trimEnd(),
          stdout: stdoutBuf.trimEnd(),
        };
      };

      const settle = (result: TaskResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const terminateChild = () => {
        if (child.killed) return;
        const killDirectly = () => {
          if (child.killed) return;
          try {
            child.kill('SIGKILL');
          } catch {
            // A close/kill race is represented by the pending terminal result
            // or its bounded fallback.
          }
        };
        if (process.platform === 'win32' && child.pid !== undefined) {
          // `child.kill()` terminates cmd.exe, but does not reliably terminate
          // commands it has already launched. taskkill's /T is a best-effort
          // tree termination request for this invocation only. It is not a
          // guarantee for descendants that have escaped the process tree.
          try {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            });
            // Give taskkill a short opportunity to locate and terminate the
            // shell's tree. Any failure, non-zero exit, or short watchdog
            // expiry falls back to direct shell termination.
            const killOnFailure = () => {
              if (settled) return;
              if (directKillTimer) clearTimeout(directKillTimer);
              killDirectly();
            };
            killer.once('error', killOnFailure);
            killer.once('close', (code) => {
              if (settled) return;
              if (code === 0) {
                if (directKillTimer) clearTimeout(directKillTimer);
                return;
              }
              killOnFailure();
            });
            directKillTimer = setTimeout(killDirectly, WINDOWS_TASKKILL_GRACE_MS);
          } catch {
            // The direct kill below is still required when taskkill cannot be
            // launched synchronously.
            killDirectly();
          }
          return;
        }
        if (signal && child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
            return;
          } catch {
            // The shell may already have exited or the platform may reject a
            // process-group signal. Kill the direct child as a safe fallback.
          }
        }
        killDirectly();
      };

      const settleTerminal = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
        const data = resultData(exitCode, exitSignal);
        settle({
          success: false,
          error: new Error(
            terminalCause === 'cancelled'
              ? SHELL_TASK_CANCELLED_MESSAGE
              : `Shell command timed out after ${timeout}ms`,
          ),
          data,
        });
      };

      const requestTermination = (cause: 'cancelled' | 'timedOut') => {
        if (settled || terminalCause !== 'running') return;
        terminalCause = cause;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        removeAbortListener();

        // Preserve the legacy no-signal timeout path exactly: kill the shell
        // and wait for close. The bounded cancellation contract applies only
        // when a caller supplied an AbortSignal.
        if (cause === 'timedOut' && !signal) {
          try {
            child.kill('SIGKILL');
          } catch {
            // The existing error/close handlers retain responsibility for the
            // final task result.
          }
          return;
        }
        terminationTimer = setTimeout(() => settleTerminal(null, null), TERMINATION_GRACE_MS);
        try {
          terminateChild();
        } catch {
          // `close` or the bounded fallback below will settle the terminal
          // result; a kill race must not escape as an unhandled exception.
        }
      };

      const onAbort = () => requestTermination('cancelled');

      timeoutTimer = setTimeout(() => requestTermination('timedOut'), timeout);

      signal?.addEventListener('abort', onAbort, { once: true });
      abortListenerRegistered = Boolean(signal);
      if (signal?.aborted) onAbort();

      child.on('error', (err) => {
        if (terminalCause !== 'running') {
          // Preserve the legacy no-signal timeout result if the kill itself
          // errors and no `close` follows. Without this, a timeout could leave
          // the task pending indefinitely; the original error and data shape
          // remain intact for compatibility.
          if (terminalCause === 'timedOut' && !signal) {
            settle({
              success: false,
              error: err instanceof Error ? err : new Error(String(err)),
              data: resultData(null, null, false),
            });
          }
          return;
        }
        settle({
          success: false,
          error: err instanceof Error ? err : new Error(String(err)),
          data: resultData(null, null, Boolean(signal)),
        });
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        if (terminalCause !== 'running') {
          settleTerminal(code, signal);
          return;
        }
        const data = resultData(code, signal);
        if (code === 0) {
          settle({ success: true, data: { output: data.stdout } });
          return;
        }
        settle({
          success: false,
          error: new Error(
            `Shell command failed (exit ${code}): ${(data.stderr || data.stdout).trimEnd()}`,
          ),
          data,
        });
      });
    });
  }
}
