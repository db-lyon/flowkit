import { describe, it, expect } from 'vitest';
import { BaseTask, type TaskResult } from '../../src/task/base-task.js';
import { TaskRegistry } from '../../src/task/registry.js';

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

class ChildTask extends BaseTask<{ fromDefault?: string; fromCall?: string; ref?: string }> {
  get taskName() {
    return 'child';
  }
  async execute(): Promise<TaskResult> {
    return { success: true, data: this.options };
  }
}

class CallerTask extends BaseTask {
  get taskName() {
    return 'caller';
  }
  async execute(): Promise<TaskResult> {
    return this.call('configured_child', { fromCall: 'call' });
  }
}

class ResolveCallerTask extends BaseTask<{ target: string }> {
  get taskName() {
    return 'resolve_caller';
  }
  async execute(): Promise<TaskResult> {
    return this.call(this.options.target, { fromCall: 'call' });
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

  it('resolves configured task names through class_path and merges default options', async () => {
    const registry = new TaskRegistry().registerClassPath('consumer.tasks.Child', ChildTask);
    const task = new CallerTask({
      registry,
      taskDefinitions: {
        configured_child: {
          class_path: 'consumer.tasks.Child',
          options: { fromDefault: 'default', fromCall: 'default' },
        },
      },
    }, {});

    await expect(task.run()).resolves.toMatchObject({
      success: true,
      data: { fromDefault: 'default', fromCall: 'call' },
    });
  });

  it('resolves option-only task definitions by falling back to the task name', async () => {
    const registry = new TaskRegistry().registerClassPath('configured_child', ChildTask);
    const task = new ResolveCallerTask({
      registry,
      taskDefinitions: {
        configured_child: {
          options: { fromDefault: 'default', fromCall: 'default' },
        },
      },
    }, { target: 'configured_child' });

    await expect(task.run()).resolves.toMatchObject({
      success: true,
      data: { fromDefault: 'default', fromCall: 'call' },
    });
  });

  it('preserves direct task-name resolution when no definition exists', async () => {
    const registry = new TaskRegistry().registerClassPath('configured_child', ChildTask);
    const task = new ResolveCallerTask({ registry }, { target: 'configured_child' });

    await expect(task.run()).resolves.toMatchObject({
      success: true,
      data: { fromCall: 'call' },
    });
  });

  it('interpolates configured default references for task-to-task calls', async () => {
    const registry = new TaskRegistry().registerClassPath('consumer.tasks.Child', ChildTask);
    const task = new ResolveCallerTask({
      registry,
      taskDefinitions: {
        configured_child: {
          class_path: 'consumer.tasks.Child',
          options: { ref: '${project.name}' },
        },
      },
      taskReferenceContext: {
        steps: [],
        namespaces: { project: { name: 'Flowkit' } },
      },
    }, { target: 'configured_child' });

    await expect(task.run()).resolves.toMatchObject({
      success: true,
      data: { ref: 'Flowkit', fromCall: 'call' },
    });
  });
});
