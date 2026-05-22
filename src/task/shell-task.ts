import { spawn } from 'node:child_process';
import { BaseTask, type TaskResult } from './base-task.js';

export interface ShellTaskOptions {
  command: string;
  cwd?: string;
  timeout?: number;
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
  }

  async execute(): Promise<TaskResult> {
    const { command, cwd, timeout = 300_000 } = this.options;

    return new Promise<TaskResult>((resolve) => {
      // Cross-platform: route through the platform shell so command strings
      // like "npm run build" or "echo $HOME && ls" work the same way they
      // did under execSync.
      const child = spawn(command, {
        cwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutBuf = '';
      let stderrBuf = '';
      let stdoutTail = '';
      let stderrTail = '';
      let timedOut = false;

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

      const timer = setTimeout(() => {
        timedOut = true;
        // SIGKILL on Windows is mapped to TerminateProcess by libuv.
        child.kill('SIGKILL');
      }, timeout);

      const flushTails = () => {
        if (stdoutTail.length > 0) {
          this.logger.info({ stream: 'stdout' }, stdoutTail);
          stdoutBuf += stdoutTail;
          stdoutTail = '';
        }
        if (stderrTail.length > 0) {
          this.logger.warn({ stream: 'stderr' }, stderrTail);
          stderrBuf += stderrTail;
          stderrTail = '';
        }
      };

      child.on('error', (err) => {
        clearTimeout(timer);
        flushTails();
        resolve({
          success: false,
          error: err instanceof Error ? err : new Error(String(err)),
          data: { exitCode: null, stderr: stderrBuf.trimEnd(), stdout: stdoutBuf.trimEnd() },
        });
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        flushTails();
        const trimmedOut = stdoutBuf.trimEnd();
        const trimmedErr = stderrBuf.trimEnd();
        if (timedOut) {
          resolve({
            success: false,
            error: new Error(`Shell command timed out after ${timeout}ms`),
            data: { exitCode: code, signal, stderr: trimmedErr, stdout: trimmedOut },
          });
          return;
        }
        if (code === 0) {
          resolve({ success: true, data: { output: trimmedOut } });
          return;
        }
        resolve({
          success: false,
          error: new Error(
            `Shell command failed (exit ${code}): ${(trimmedErr || trimmedOut).trimEnd()}`,
          ),
          data: { exitCode: code, signal, stderr: trimmedErr, stdout: trimmedOut },
        });
      });
    });
  }
}
