import { describe, it, expect } from 'vitest';
import { FlowRunner, type PlanStep } from '../../src/flow/runner.js';
import { BaseTask, type TaskResult, type TaskContext } from '../../src/task/base-task.js';
import { TaskRegistry, type TaskConstructor } from '../../src/task/registry.js';
import type { TaskDefinition, FlowDefinition } from '../../src/config/schema.js';

// ---------------------------------------------------------------------------
// Stub tasks
// ---------------------------------------------------------------------------

class PassTask extends BaseTask {
  get taskName() {
    return 'pass';
  }
  async execute(): Promise<TaskResult> {
    return { success: true, data: { task: 'pass' } };
  }
}

class FailTask extends BaseTask {
  get taskName() {
    return 'fail';
  }
  async execute(): Promise<TaskResult> {
    return { success: false, error: new Error('intentional') };
  }
}

class RecordTask extends BaseTask<{ label?: string }> {
  get taskName() {
    return 'record';
  }
  async execute(): Promise<TaskResult> {
    const log = (this.ctx as Record<string, unknown>).__log as string[];
    log.push(this.options.label ?? 'record');
    return { success: true, data: { label: this.options.label } };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRegistry(): TaskRegistry {
  return new TaskRegistry()
    .registerClassPath('test.Pass', PassTask as unknown as TaskConstructor)
    .registerClassPath('test.Fail', FailTask as unknown as TaskConstructor)
    .registerClassPath('test.Record', RecordTask as unknown as TaskConstructor);
}

function makeRunner(
  tasks: Record<string, TaskDefinition>,
  flows: Record<string, FlowDefinition>,
  ctxExtra?: Record<string, unknown>,
  hooks?: Parameters<typeof FlowRunner.prototype.run extends (...a: never[]) => unknown
    ? never
    : never> extends never
    ? Record<string, unknown>
    : never,
): FlowRunner {
  return new FlowRunner({
    tasks,
    flows,
    registry: createRegistry(),
    context: { ...ctxExtra },
    hooks: hooks as any,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FlowRunner', () => {
  it('runs a single-step flow', async () => {
    const runner = makeRunner(
      { my_task: { class_path: 'test.Pass', options: {} } },
      { simple: { description: 'Simple', steps: { '1': { task: 'my_task' } } } },
    );
    const result = await runner.run({ flowName: 'simple' });
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].type).toBe('task');
    expect(result.steps[0].name).toBe('my_task');
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('executes steps in numeric order', async () => {
    const log: string[] = [];
    const runner = makeRunner(
      { rec: { class_path: 'test.Record', options: {} } },
      {
        ordered: {
          description: 'Ordered',
          steps: {
            '3': { task: 'rec', options: { label: 'third' } },
            '1': { task: 'rec', options: { label: 'first' } },
            '2': { task: 'rec', options: { label: 'second' } },
          },
        },
      },
      { __log: log },
    );
    await runner.run({ flowName: 'ordered' });
    expect(log).toEqual(['first', 'second', 'third']);
  });

  it('merges step options over task definition defaults', async () => {
    const log: string[] = [];
    const runner = makeRunner(
      { rec: { class_path: 'test.Record', options: { label: 'default' } } },
      {
        test: {
          description: 'Merge test',
          steps: {
            '1': { task: 'rec' },
            '2': { task: 'rec', options: { label: 'override' } },
          },
        },
      },
      { __log: log },
    );
    await runner.run({ flowName: 'test' });
    expect(log).toEqual(['default', 'override']);
  });

  it('runs nested flows', async () => {
    const log: string[] = [];
    const runner = makeRunner(
      { rec: { class_path: 'test.Record', options: {} } },
      {
        inner: {
          description: 'Inner',
          steps: {
            '1': { task: 'rec', options: { label: 'inner-1' } },
            '2': { task: 'rec', options: { label: 'inner-2' } },
          },
        },
        outer: {
          description: 'Outer',
          steps: {
            '1': { task: 'rec', options: { label: 'before' } },
            '2': { flow: 'inner' },
            '3': { task: 'rec', options: { label: 'after' } },
          },
        },
      },
      { __log: log },
    );
    const result = await runner.run({ flowName: 'outer' });
    expect(result.success).toBe(true);
    expect(log).toEqual(['before', 'inner-1', 'inner-2', 'after']);
  });

  it('skips steps by task name', async () => {
    const log: string[] = [];
    const runner = makeRunner(
      {
        a: { class_path: 'test.Record', options: { label: 'a' } },
        b: { class_path: 'test.Record', options: { label: 'b' } },
      },
      {
        test: {
          description: 'Skip test',
          steps: {
            '1': { task: 'a' },
            '2': { task: 'b' },
            '3': { task: 'a' },
          },
        },
      },
      { __log: log },
    );
    await runner.run({ flowName: 'test', skip: ['b'] });
    expect(log).toEqual(['a', 'a']);
  });

  it('skips steps by step number', async () => {
    const log: string[] = [];
    const runner = makeRunner(
      { rec: { class_path: 'test.Record', options: {} } },
      {
        test: {
          description: 'Skip number',
          steps: {
            '1': { task: 'rec', options: { label: 'a' } },
            '2': { task: 'rec', options: { label: 'b' } },
            '3': { task: 'rec', options: { label: 'c' } },
          },
        },
      },
      { __log: log },
    );
    await runner.run({ flowName: 'test', skip: ['2'] });
    expect(log).toEqual(['a', 'c']);
  });

  it('handles task: None as auto-skip', async () => {
    const log: string[] = [];
    const runner = makeRunner(
      { rec: { class_path: 'test.Record', options: {} } },
      {
        test: {
          description: 'None test',
          steps: {
            '1': { task: 'rec', options: { label: 'a' } },
            '2': { task: 'None' },
            '3': { task: 'rec', options: { label: 'c' } },
          },
        },
      },
      { __log: log },
    );
    const result = await runner.run({ flowName: 'test' });
    expect(result.success).toBe(true);
    expect(log).toEqual(['a', 'c']);
    expect(result.steps[1].skipped).toBe(true);
    expect(result.steps[1].name).toBe('None');
  });

  it('returns plan without executing', async () => {
    const log: string[] = [];
    const runner = makeRunner(
      { rec: { class_path: 'test.Record', options: {} } },
      {
        test: {
          description: 'Plan test',
          steps: {
            '1': { task: 'rec' },
            '2': { flow: 'inner' },
          },
        },
        inner: {
          description: 'Inner',
          steps: { '1': { task: 'rec' } },
        },
      },
      { __log: log },
    );
    const result = await runner.run({ flowName: 'test', plan: true });
    expect(result.success).toBe(true);
    expect(log).toEqual([]);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].type).toBe('task');
    expect(result.steps[1].type).toBe('flow');
  });

  it('stops on task failure and reports error', async () => {
    const log: string[] = [];
    const runner = makeRunner(
      {
        rec: { class_path: 'test.Record', options: {} },
        fail: { class_path: 'test.Fail', options: {} },
      },
      {
        test: {
          description: 'Failure test',
          steps: {
            '1': { task: 'rec', options: { label: 'before' } },
            '2': { task: 'fail' },
            '3': { task: 'rec', options: { label: 'after' } },
          },
        },
      },
      { __log: log },
    );
    const result = await runner.run({ flowName: 'test' });
    expect(result.success).toBe(false);
    expect(log).toEqual(['before']);
    expect(result.steps).toHaveLength(2);
    expect(result.error?.message).toBe('intentional');
  });

  it('throws on unknown flow name', async () => {
    const runner = makeRunner({}, {});
    await expect(runner.run({ flowName: 'nope' })).rejects.toThrow('not found');
  });

  it('allows class_path directly as task reference', async () => {
    const runner = makeRunner(
      {},
      {
        test: {
          description: 'Direct class_path',
          steps: { '1': { task: 'test.Pass' } },
        },
      },
    );
    const result = await runner.run({ flowName: 'test' });
    expect(result.success).toBe(true);
  });

  // ---- Hooks ----

  it('fires lifecycle hooks in order', async () => {
    const events: string[] = [];
    const hooks = {
      beforeRun: async () => {
        events.push('beforeRun');
      },
      afterRun: async () => {
        events.push('afterRun');
      },
      beforeStep: async (step: PlanStep) => {
        events.push(`before:${step.name}`);
      },
      afterStep: async (step: PlanStep) => {
        events.push(`after:${step.name}`);
      },
    };

    const runner = makeRunner(
      { pass: { class_path: 'test.Pass', options: {} } },
      { test: { description: 'Hook test', steps: { '1': { task: 'pass' } } } },
      {},
      hooks,
    );
    await runner.run({ flowName: 'test' });
    expect(events).toEqual(['beforeRun', 'before:pass', 'after:pass', 'afterRun']);
  });

  it('fires onStepError on failure', async () => {
    const events: string[] = [];
    const hooks = {
      onStepError: async (step: PlanStep, err: Error) => {
        events.push(`error:${step.name}:${err.message}`);
      },
      afterRun: async () => {
        events.push('afterRun');
      },
    };

    const runner = makeRunner(
      { fail: { class_path: 'test.Fail', options: {} } },
      { test: { description: 'Error hook', steps: { '1': { task: 'fail' } } } },
      {},
      hooks,
    );
    const result = await runner.run({ flowName: 'test' });
    expect(result.success).toBe(false);
    expect(events).toEqual(['error:fail:intentional', 'afterRun']);
  });

  it('beforeRun/afterRun fire only for top-level flow', async () => {
    const events: string[] = [];
    const hooks = {
      beforeRun: async () => {
        events.push('beforeRun');
      },
      afterRun: async () => {
        events.push('afterRun');
      },
      beforeStep: async (step: PlanStep) => {
        events.push(`before:${step.name}`);
      },
      afterStep: async (step: PlanStep) => {
        events.push(`after:${step.name}`);
      },
    };

    const runner = makeRunner(
      { pass: { class_path: 'test.Pass', options: {} } },
      {
        inner: { description: 'Inner', steps: { '1': { task: 'pass' } } },
        outer: {
          description: 'Outer',
          steps: {
            '1': { task: 'pass' },
            '2': { flow: 'inner' },
          },
        },
      },
      {},
      hooks,
    );
    await runner.run({ flowName: 'outer' });

    // beforeRun and afterRun appear exactly once (top-level only)
    expect(events.filter((e) => e === 'beforeRun')).toHaveLength(1);
    expect(events.filter((e) => e === 'afterRun')).toHaveLength(1);

    // beforeStep/afterStep fire for all steps including nested
    expect(events).toEqual([
      'beforeRun',
      'before:pass',
      'after:pass',
      'before:inner',
      'before:pass', // inner flow's step
      'after:pass',
      'after:inner',
      'afterRun',
    ]);
  });

  it('resolves ${steps.<id>.<path>} references in step options', async () => {
    class EchoTask extends BaseTask<{ input?: unknown }> {
      get taskName() {
        return 'echo';
      }
      async execute(): Promise<TaskResult> {
        return { success: true, data: { echoed: this.options.input } };
      }
    }

    const registry = new TaskRegistry()
      .registerClassPath('test.Record', RecordTask as unknown as TaskConstructor)
      .registerClassPath('test.Echo', EchoTask as unknown as TaskConstructor);

    const runner = new FlowRunner({
      tasks: {
        record: { class_path: 'test.Record', options: {} },
        echo: { class_path: 'test.Echo', options: {} },
      },
      flows: {
        chain: {
          description: 'Chain step outputs',
          steps: {
            '1': { task: 'record', options: { label: 'first' } },
            '2': { task: 'echo', options: { input: '${steps.1.label}' } },
            '3': { task: 'echo', options: { input: 'via ${steps.record.label}' } },
          },
        },
      },
      registry,
      context: { __log: [] },
    });

    const result = await runner.run({ flowName: 'chain' });

    expect(result.success).toBe(true);
    expect(result.steps[1]!.result?.data).toEqual({ echoed: 'first' });
    expect(result.steps[2]!.result?.data).toEqual({ echoed: 'via first' });
  });

  it('fails the step when a reference cannot be resolved', async () => {
    const runner = makeRunner(
      { echo: { class_path: 'test.Pass', options: {} } },
      {
        broken: {
          description: 'References a step that does not exist',
          steps: {
            '1': { task: 'echo', options: { input: '${steps.missing.x}' } },
          },
        },
      },
    );

    const result = await runner.run({ flowName: 'broken' });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/Unresolvable step reference/);
  });
});
