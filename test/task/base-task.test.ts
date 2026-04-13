import { describe, it, expect } from 'vitest';
import { BaseTask, type TaskResult } from '../../src/task/base-task.js';

class SuccessTask extends BaseTask {
  get taskName() {
    return 'success';
  }
  async execute(): Promise<TaskResult> {
    return { success: true, data: { value: 42 } };
  }
}

class ThrowingTask extends BaseTask {
  get taskName() {
    return 'throwing';
  }
  async execute(): Promise<TaskResult> {
    throw new Error('boom');
  }
}

class ValidatingTask extends BaseTask<{ required: string }> {
  get taskName() {
    return 'validating';
  }
  protected validate(): void {
    if (!this.options.required) throw new Error('missing required option');
  }
  async execute(): Promise<TaskResult> {
    return { success: true };
  }
}

describe('BaseTask', () => {
  it('wraps execute() with timing', async () => {
    const task = new SuccessTask({}, {});
    const result = await task.run();
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ value: 42 });
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('catches thrown exceptions and returns failure', async () => {
    const task = new ThrowingTask({}, {});
    const result = await task.run();
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('boom');
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('runs validate() before execute()', async () => {
    const task = new ValidatingTask({}, { required: '' });
    const result = await task.run();
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('missing required option');
  });

  it('passes through valid options', async () => {
    const task = new ValidatingTask({}, { required: 'yes' });
    const result = await task.run();
    expect(result.success).toBe(true);
  });

  it('works with a provided logger', async () => {
    const messages: string[] = [];
    const logger = {
      debug(...args: unknown[]) {
        messages.push(String(args[args.length - 1]));
      },
      info() {},
      warn() {},
      error() {},
      child() {
        return logger;
      },
    };
    const task = new SuccessTask({ logger }, {});
    await task.run();
    expect(messages.some((m) => m.includes('Starting task'))).toBe(true);
    expect(messages.some((m) => m.includes('Completed task'))).toBe(true);
  });
});
