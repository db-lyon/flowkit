import { describe, it, expect } from 'vitest';
import { TaskRegistry } from '../../src/task/registry.js';
import {
  BaseTask,
  type TaskResult,
  type TaskContext,
  type ExecutionPhase,
} from '../../src/task/base-task.js';
import type { TaskConstructor } from '../../src/task/registry.js';

class StubTask extends BaseTask {
  get taskName() {
    return 'stub';
  }
  async execute(): Promise<TaskResult> {
    return {
      success: true,
      data: { ran: true, executionPhase: this.ctx.executionPhase },
    };
  }
}

const Stub = StubTask as unknown as TaskConstructor;

class ExplicitContextTask extends BaseTask {
  private readonly observedPhase: ExecutionPhase;

  constructor(ctx: TaskContext, options: Record<string, unknown>) {
    const observedPhase = ctx.executionPhase;
    super(ctx, options);
    this.observedPhase = observedPhase;
  }

  get taskName() {
    return 'explicit';
  }

  async execute(): Promise<TaskResult> {
    return { success: true, data: { observedPhase: this.observedPhase } };
  }
}

describe('TaskRegistry', () => {
  it('registers and resolves by name', async () => {
    const reg = new TaskRegistry();
    reg.register('my_task', Stub);
    expect(await reg.resolve('my_task')).toBe(StubTask);
  });

  it('registers and resolves by class_path', async () => {
    const reg = new TaskRegistry();
    reg.registerClassPath('my.tasks.Stub', Stub);
    expect(await reg.resolve('my.tasks.Stub')).toBe(StubTask);
  });

  it('creates a task instance', async () => {
    const reg = new TaskRegistry();
    reg.register('my_task', Stub);
    const task = await reg.create('my_task', {}, { foo: 'bar' });
    expect(task).toBeInstanceOf(StubTask);
    const result = await task.run();
    expect(result.success).toBe(true);
    expect(result.data?.executionPhase).toBe('task');
  });

  it('requires callers of resolved public constructors to pass a complete context', async () => {
    const reg = new TaskRegistry().register('my_task', Stub);
    const TaskClass = await reg.resolve('my_task');

    const result = await new TaskClass({ executionPhase: 'task' }, {}).run();

    expect(result.data?.executionPhase).toBe('task');
  });

  it('normalizes omitted phase in create before invoking explicit TaskContext constructors', async () => {
    const reg = new TaskRegistry().register('explicit', ExplicitContextTask);

    const task = await reg.create('explicit', {}, {});
    const result = await task.run();

    expect(task).toBeInstanceOf(ExplicitContextTask);
    expect(result.data?.observedPhase).toBe('task');
  });

  it('normalizes omitted phase in create for dynamic class-path constructors', async () => {
    const reg = new TaskRegistry();

    const task = await reg.create('test.fixtures.dynamic-explicit-task', {}, {});
    const result = await task.run();

    expect(task.taskName).toBe('dynamic-explicit');
    expect(result.data?.observedPhase).toBe('task');
  });

  it('preserves documented class-extends-Original wrap decorators', async () => {
    const reg = new TaskRegistry().register('explicit', ExplicitContextTask);
    reg.wrap('explicit', (Original) => {
      const ExplicitOriginal = Original as unknown as typeof ExplicitContextTask;
      return class Wrapped extends ExplicitOriginal {
        get taskName() {
          return 'wrapped';
        }

        async execute(): Promise<TaskResult> {
          const result = await super.execute();
          return {
            ...result,
            data: { ...result.data, wrapped: true },
          };
        }
      };
    });

    const task = await reg.create('explicit', {}, {});
    const result = await task.run();

    expect(task.taskName).toBe('wrapped');
    expect(result.data?.observedPhase).toBe('task');
    expect(result.data?.wrapped).toBe(true);
  });

  it('preserves a supplied execution phase without mutating the input context', async () => {
    const reg = new TaskRegistry();
    reg.register('my_task', Stub);
    const ctx = { executionPhase: 'rollback' as const };

    const task = await reg.create('my_task', ctx, {});
    const result = await task.run();

    expect(result.data?.executionPhase).toBe('rollback');
    expect(ctx).toEqual({ executionPhase: 'rollback' });
  });

  it('lists all registered names and class paths', () => {
    const reg = new TaskRegistry();
    reg.register('a', Stub);
    reg.register('b', Stub);
    reg.registerClassPath('x.y.Z', Stub);
    const list = reg.listRegistered();
    expect(list).toContain('a');
    expect(list).toContain('b');
    expect(list).toContain('x.y.Z');
  });

  it('throws for unknown task', async () => {
    const reg = new TaskRegistry();
    await expect(reg.resolve('nonexistent')).rejects.toThrow('Cannot resolve task');
  });

  it('registerAll bulk-registers by name', async () => {
    const reg = new TaskRegistry();
    reg.registerAll({ a: Stub, b: Stub });
    expect(await reg.resolve('a')).toBe(StubTask);
    expect(await reg.resolve('b')).toBe(StubTask);
  });

  it('registerClassPaths bulk-registers by class path', async () => {
    const reg = new TaskRegistry();
    reg.registerClassPaths({ 'x.A': Stub, 'x.B': Stub });
    expect(await reg.resolve('x.A')).toBe(StubTask);
    expect(await reg.resolve('x.B')).toBe(StubTask);
  });

  it('register returns this for chaining', () => {
    const reg = new TaskRegistry();
    const result = reg.register('a', Stub).register('b', Stub);
    expect(result).toBe(reg);
  });

  it('prefers class_path over name when both match', async () => {
    class OtherTask extends BaseTask {
      get taskName() {
        return 'other';
      }
      async execute(): Promise<TaskResult> {
        return { success: true };
      }
    }
    const Other = OtherTask as unknown as TaskConstructor;

    const reg = new TaskRegistry();
    reg.registerClassPath('ambiguous', Stub);
    reg.register('ambiguous', Other);
    // class_path map is checked first
    expect(await reg.resolve('ambiguous')).toBe(StubTask);
  });
});
