import { describe, it, expect } from 'vitest';
import { ShellTask } from '../../src/task/shell-task.js';
import type { Logger } from '../../src/logger.js';

interface CapturedLog {
  level: 'debug' | 'info' | 'warn' | 'error';
  args: unknown[];
}

function makeCapturingLogger(): { logger: Logger; captured: CapturedLog[] } {
  const captured: CapturedLog[] = [];
  const logger: Logger = {
    debug: (...args) => captured.push({ level: 'debug', args }),
    info: (...args) => captured.push({ level: 'info', args }),
    warn: (...args) => captured.push({ level: 'warn', args }),
    error: (...args) => captured.push({ level: 'error', args }),
    child: () => logger,
  };
  return { logger, captured };
}

function linesFor(captured: CapturedLog[], stream: 'stdout' | 'stderr'): string[] {
  const level = stream === 'stdout' ? 'info' : 'warn';
  const out: string[] = [];
  for (const entry of captured) {
    if (entry.level !== level) continue;
    const [bindings, msg] = entry.args;
    if (
      bindings &&
      typeof bindings === 'object' &&
      (bindings as { stream?: string }).stream === stream &&
      typeof msg === 'string'
    ) {
      out.push(msg);
    }
  }
  return out;
}

describe('ShellTask', () => {
  it('streams stdout line-by-line through the logger', async () => {
    const { logger, captured } = makeCapturingLogger();
    const command =
      process.platform === 'win32'
        ? 'echo first&& echo second&& echo third'
        : 'printf "first\\nsecond\\nthird\\n"';
    const task = new ShellTask({ logger }, { command });
    const result = await task.run();
    expect(result.success, JSON.stringify(result)).toBe(true);
    const stdoutLines = linesFor(captured, 'stdout');
    // On Windows the echo&& chain emits trailing spaces; trim before compare.
    expect(stdoutLines.map((l) => l.trim())).toEqual(['first', 'second', 'third']);
    expect((result.data as { output: string }).output.replace(/\r/g, '')).toContain('first');
  });

  it('streams stderr line-by-line through the logger as warnings', async () => {
    const { logger, captured } = makeCapturingLogger();
    // Cross-platform stderr echo: redirect from a process that writes to it.
    const command =
      process.platform === 'win32'
        ? 'echo oops 1>&2'
        : 'printf "oops\\n" 1>&2';
    const task = new ShellTask({ logger }, { command });
    const result = await task.run();
    expect(result.success).toBe(true);
    const stderrLines = linesFor(captured, 'stderr');
    expect(stderrLines.map((l) => l.trim())).toContain('oops');
  });

  it('returns failure with captured stderr when the command exits non-zero', async () => {
    const command =
      process.platform === 'win32'
        ? 'echo failing 1>&2 && exit 1'
        : 'printf "failing\\n" 1>&2 && exit 1';
    const task = new ShellTask({}, { command });
    const result = await task.run();
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/exit 1/);
    expect((result.data as { exitCode: number }).exitCode).toBe(1);
  });

  it('requires a command option', async () => {
    const task = new ShellTask({}, { command: '' });
    const result = await task.run();
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/command/);
  });
});
