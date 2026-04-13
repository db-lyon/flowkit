import { execSync } from 'node:child_process';
import { BaseTask, type TaskResult } from './base-task.js';

export interface ShellTaskOptions {
  command: string;
  cwd?: string;
  timeout?: number;
}

/**
 * Task that executes a shell command via execSync.
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

    try {
      const output = execSync(command, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        timeout,
      });
      return { success: true, data: { output: output.trimEnd() } };
    } catch (error) {
      const err = error as { status?: number; stderr?: string; stdout?: string };
      return {
        success: false,
        error: new Error(`Shell command failed (exit ${err.status}): ${(err.stderr ?? err.stdout ?? '').trimEnd()}`),
        data: { exitCode: err.status, stderr: err.stderr, stdout: err.stdout },
      };
    }
  }
}
