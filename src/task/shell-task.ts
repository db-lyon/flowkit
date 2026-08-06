import { spawn } from 'node:child_process';
import { BaseTask, type TaskResult } from './base-task.js';
import {
  beginShellTermination,
  POSIX_SIGTERM_GRACE_MS,
  terminationGraceMs,
  type ShellTerminationHandle,
} from './shell-termination.js';

export interface ShellTaskOptions {
  command: string;
  cwd?: string;
  timeout?: number;
  /** Cancels this individual shell invocation when aborted. */
  signal?: AbortSignal;
}

/** Stable internal error text returned when a shell invocation is cancelled. */
const SHELL_TASK_CANCELLED_MESSAGE = 'Shell command cancelled';

function isAbortSignal(value: unknown): value is AbortSignal {
  // A structural check can admit a lookalike whose addEventListener throws
  // after spawn, recreating the detached-child leak this validation prevents.
  return value instanceof AbortSignal;
}

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
    if (this.options.signal !== undefined && !isAbortSignal(this.options.signal)) {
      throw new Error('ShellTask "signal" must be an AbortSignal');
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
      let escalationTimer: ReturnType<typeof setTimeout> | undefined;
      let terminator: ShellTerminationHandle | undefined;
      let terminationEscalated = false;
      let pendingTerminalClose:
        | { exitCode: number | null; exitSignal: NodeJS.Signals | null }
        | undefined;
      const onStdoutData = (chunk: string) => {
        stdoutBuf += chunk;
        emitLines(chunk, 'stdout', (line) => {
          this.logger.info({ stream: 'stdout' }, line);
        });
      };
      const onStderrData = (chunk: string) => {
        stderrBuf += chunk;
        emitLines(chunk, 'stderr', (line) => {
          this.logger.warn({ stream: 'stderr' }, line);
        });
      };

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

      child.stdout?.on('data', onStdoutData);
      child.stderr?.on('data', onStderrData);

      const flushTails = () => {
        if (stdoutTail.length > 0) {
          this.logger.info({ stream: 'stdout' }, stdoutTail);
          stdoutTail = '';
        }
        if (stderrTail.length > 0) {
          this.logger.warn({ stream: 'stderr' }, stderrTail);
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
        if (escalationTimer) clearTimeout(escalationTimer);
        removeAbortListener();
        // A bounded fallback may settle before a misbehaving child closes.
        // Stop capturing output then, while retaining the child error handler
        // until Node finishes closing it.
        child.stdout?.removeListener('data', onStdoutData);
        child.stderr?.removeListener('data', onStderrData);
        terminator?.dispose();
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
        try {
          terminator = beginShellTermination(child);
          terminator.onTreeKillComplete(() => {
            if (!pendingTerminalClose || settled || terminalCause === 'running') return;
            const pending = pendingTerminalClose;
            pendingTerminalClose = undefined;
            settleTerminal(pending.exitCode, pending.exitSignal);
          });
          if (terminator.platform !== 'win32') {
            escalationTimer = setTimeout(() => {
              terminationEscalated = true;
              terminator?.escalate();
              if (pendingTerminalClose) {
                const pending = pendingTerminalClose;
                pendingTerminalClose = undefined;
                settleTerminal(pending.exitCode, pending.exitSignal);
              }
            }, POSIX_SIGTERM_GRACE_MS);
          }
          terminationTimer = setTimeout(() => {
            terminator?.release();
            settleTerminal(null, null);
          }, terminationGraceMs(terminator.platform));
        } catch {
          // `close` or the bounded fallback below will settle the terminal
          // result; a kill race must not escape as an unhandled exception.
        }
      };

      const onAbort = () => requestTermination('cancelled');

      timeoutTimer = setTimeout(() => requestTermination('timedOut'), timeout);

      signal?.addEventListener('abort', onAbort, { once: true });
      abortListenerRegistered = Boolean(signal);

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

      child.on('close', (code, exitSignal) => {
        if (settled) return;
        if (terminalCause !== 'running') {
          const waitsForPosixEscalation =
            terminator !== undefined &&
            terminator.platform !== 'win32' &&
            !terminationEscalated;
          const waitsForWindowsTree =
            terminator?.platform === 'win32' && !terminator.isTreeKillComplete();
          if (waitsForPosixEscalation || waitsForWindowsTree) {
            // A root shell may close before its descendants are finished.
            // Keep the POSIX escalation or Windows taskkill operation owned
            // until it finishes or reaches the bounded terminal deadline.
            pendingTerminalClose = { exitCode: code, exitSignal };
            return;
          }
          settleTerminal(code, exitSignal);
          return;
        }
        const data = resultData(code, exitSignal);
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
