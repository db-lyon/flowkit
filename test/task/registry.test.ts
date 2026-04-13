import { describe, it, expect } from 'vitest';
import { TaskRegistry } from '../../src/task/registry.js';
import { BaseTask, type TaskResult, type TaskContext } from '../../src/task/base-task.js';
import type { TaskConstructor } from '../../src/task/registry.js';

class StubTask extends BaseTask {
  get taskName() {
    return 'stub';
  }
  async execute(): Promise<TaskResult> {
    return { success: true, data: { ran: true } };
  }
}

const Stub = StubTask as unknown as TaskConstructor;

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
