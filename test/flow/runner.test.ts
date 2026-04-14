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

// ---------------------------------------------------------------------------
// Phase 1 — flow hooks + retry
// ---------------------------------------------------------------------------

describe('FlowRunner — flow-level hooks', () => {
  it('runs on_start before steps and on_success after', async () => {
    const log: string[] = [];
    class LogTask extends BaseTask<{ label: string }> {
      get taskName() { return 'log'; }
      async execute(): Promise<TaskResult> {
        log.push(this.options.label);
        return { success: true, data: { label: this.options.label } };
      }
    }
    const registry = new TaskRegistry().registerClassPath(
      'test.Log',
      LogTask as unknown as TaskConstructor,
    );
    const runner = new FlowRunner({
      tasks: { log: { class_path: 'test.Log', options: {} } },
      flows: {
        f: {
          description: 'hook flow',
          on_start: [{ task: 'log', options: { label: 'start' } }],
          on_success: [{ task: 'log', options: { label: 'success' } }],
          finally: [{ task: 'log', options: { label: 'finally' } }],
          steps: {
            '1': { task: 'log', options: { label: 'step1' } },
            '2': { task: 'log', options: { label: 'step2' } },
          },
        },
      },
      registry,
      context: {},
    });
    const result = await runner.run({ flowName: 'f' });
    expect(result.success).toBe(true);
    expect(log).toEqual(['start', 'step1', 'step2', 'success', 'finally']);
  });

  it('runs on_failure instead of on_success when a step fails', async () => {
    const log: string[] = [];
    class LogTask extends BaseTask<{ label: string }> {
      get taskName() { return 'log'; }
      async execute(): Promise<TaskResult> {
        log.push(this.options.label);
        return { success: true };
      }
    }
    const registry = new TaskRegistry()
      .registerClassPath('test.Log', LogTask as unknown as TaskConstructor)
      .registerClassPath('test.Fail', FailTask as unknown as TaskConstructor);
    const runner = new FlowRunner({
      tasks: {
        log: { class_path: 'test.Log', options: {} },
        fail: { class_path: 'test.Fail', options: {} },
      },
      flows: {
        f: {
          description: 'failure flow',
          on_success: [{ task: 'log', options: { label: 'success' } }],
          on_failure: [{ task: 'log', options: { label: 'failure' } }],
          finally: [{ task: 'log', options: { label: 'finally' } }],
          steps: {
            '1': { task: 'fail' },
          },
        },
      },
      registry,
      context: {},
    });
    const result = await runner.run({ flowName: 'f' });
    expect(result.success).toBe(false);
    expect(log).toEqual(['failure', 'finally']);
  });

  it('exposes ${error.message} inside on_failure steps', async () => {
    let captured: unknown;
    class CaptureTask extends BaseTask<{ msg: string }> {
      get taskName() { return 'capture'; }
      async execute(): Promise<TaskResult> {
        captured = this.options.msg;
        return { success: true };
      }
    }
    const registry = new TaskRegistry()
      .registerClassPath('test.Fail', FailTask as unknown as TaskConstructor)
      .registerClassPath('test.Capture', CaptureTask as unknown as TaskConstructor);
    const runner = new FlowRunner({
      tasks: {
        fail: { class_path: 'test.Fail', options: {} },
        capture: { class_path: 'test.Capture', options: {} },
      },
      flows: {
        f: {
          description: 'error ref',
          on_failure: [{ task: 'capture', options: { msg: 'got: ${error.message}' } }],
          steps: { '1': { task: 'fail' } },
        },
      },
      registry,
      context: {},
    });
    const result = await runner.run({ flowName: 'f' });
    expect(result.success).toBe(false);
    expect(captured).toBe('got: intentional');
  });

  it('captures hook failures in hookErrors without changing primary outcome', async () => {
    const runner = makeRunner(
      {
        pass: { class_path: 'test.Pass', options: {} },
        fail: { class_path: 'test.Fail', options: {} },
      },
      {
        f: {
          description: 'hook fail',
          on_success: [{ task: 'fail' }],
          finally: [{ task: 'fail' }],
          steps: { '1': { task: 'pass' } },
        },
      },
    );
    const result = await runner.run({ flowName: 'f' });
    expect(result.success).toBe(true);
    expect(result.hookErrors).toHaveLength(2);
    expect(result.hookErrors![0]!.phase).toBe('on_success');
    expect(result.hookErrors![1]!.phase).toBe('finally');
  });

  it('on_start failure aborts the flow before steps run', async () => {
    const log: string[] = [];
    class LogTask extends BaseTask<{ label: string }> {
      get taskName() { return 'log'; }
      async execute(): Promise<TaskResult> {
        log.push(this.options.label);
        return { success: true };
      }
    }
    const registry = new TaskRegistry()
      .registerClassPath('test.Log', LogTask as unknown as TaskConstructor)
      .registerClassPath('test.Fail', FailTask as unknown as TaskConstructor);
    const runner = new FlowRunner({
      tasks: {
        log: { class_path: 'test.Log', options: {} },
        fail: { class_path: 'test.Fail', options: {} },
      },
      flows: {
        f: {
          description: 'on_start failure',
          on_start: [{ task: 'fail' }],
          on_failure: [{ task: 'log', options: { label: 'failure' } }],
          steps: { '1': { task: 'log', options: { label: 'step' } } },
        },
      },
      registry,
      context: {},
    });
    const result = await runner.run({ flowName: 'f' });
    expect(result.success).toBe(false);
    expect(log).toEqual(['failure']); // step1 never ran
  });
});

describe('FlowRunner — per-step retry', () => {
  it('retries a failing step up to retries+1 attempts', async () => {
    let calls = 0;
    class FlakyTask extends BaseTask {
      get taskName() { return 'flaky'; }
      async execute(): Promise<TaskResult> {
        calls++;
        if (calls < 3) return { success: false, error: new Error('transient') };
        return { success: true, data: { ok: true } };
      }
    }
    const registry = new TaskRegistry().registerClassPath(
      'test.Flaky',
      FlakyTask as unknown as TaskConstructor,
    );
    const runner = new FlowRunner({
      tasks: { flaky: { class_path: 'test.Flaky', options: {} } },
      flows: {
        f: {
          description: 'retry',
          steps: { '1': { task: 'flaky', retries: 2 } },
        },
      },
      registry,
      context: {},
    });
    const result = await runner.run({ flowName: 'f' });
    expect(result.success).toBe(true);
    expect(calls).toBe(3);
    expect(result.steps[0]!.attempts).toBe(3);
  });

  it('honors retryOn substring match', async () => {
    let calls = 0;
    class TypedFailTask extends BaseTask {
      get taskName() { return 'tf'; }
      async execute(): Promise<TaskResult> {
        calls++;
        return { success: false, error: new Error('permanent auth denied') };
      }
    }
    const registry = new TaskRegistry().registerClassPath(
      'test.TF',
      TypedFailTask as unknown as TaskConstructor,
    );
    const runner = new FlowRunner({
      tasks: { tf: { class_path: 'test.TF', options: {} } },
      flows: {
        f: {
          description: 'retryOn',
          steps: { '1': { task: 'tf', retries: 5, retryOn: 'transient' } },
        },
      },
      registry,
      context: {},
    });
    const result = await runner.run({ flowName: 'f' });
    expect(result.success).toBe(false);
    expect(calls).toBe(1); // retryOn doesn't match, no retry
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — rollback
// ---------------------------------------------------------------------------

describe('FlowRunner — rollback on failure', () => {
  it('invokes rollback records in reverse order when a later step fails', async () => {
    const log: string[] = [];
    class CreateTask extends BaseTask<{ label: string }> {
      get taskName() { return 'create'; }
      async execute(): Promise<TaskResult> {
        log.push(`create:${this.options.label}`);
        return {
          success: true,
          data: { label: this.options.label },
          rollback: {
            taskName: 'remove',
            payload: { label: this.options.label },
          },
        };
      }
    }
    class RemoveTask extends BaseTask<{ label: string }> {
      get taskName() { return 'remove'; }
      async execute(): Promise<TaskResult> {
        log.push(`remove:${this.options.label}`);
        return { success: true };
      }
    }
    const registry = new TaskRegistry()
      .registerClassPath('test.Create', CreateTask as unknown as TaskConstructor)
      .registerClassPath('test.Remove', RemoveTask as unknown as TaskConstructor)
      .registerClassPath('test.Fail', FailTask as unknown as TaskConstructor);
    const runner = new FlowRunner({
      tasks: {
        create: { class_path: 'test.Create', options: {} },
        remove: { class_path: 'test.Remove', options: {} },
        fail: { class_path: 'test.Fail', options: {} },
      },
      flows: {
        f: {
          description: 'rollback',
          rollback_on_failure: true,
          steps: {
            '1': { task: 'create', options: { label: 'a' } },
            '2': { task: 'create', options: { label: 'b' } },
            '3': { task: 'fail' },
          },
        },
      },
      registry,
      context: {},
    });
    const result = await runner.run({ flowName: 'f' });
    expect(result.success).toBe(false);
    expect(log).toEqual(['create:a', 'create:b', 'remove:b', 'remove:a']);
    expect(result.rollback).toEqual({ attempted: 2, succeeded: 2, errors: [] });
  });

  it('continues rollback past individual inverse failures', async () => {
    const log: string[] = [];
    class CreateTask extends BaseTask<{ label: string }> {
      get taskName() { return 'create'; }
      async execute(): Promise<TaskResult> {
        log.push(`create:${this.options.label}`);
        return {
          success: true,
          rollback: {
            taskName: this.options.label === 'b' ? 'bad_remove' : 'remove',
            payload: { label: this.options.label },
          },
        };
      }
    }
    class RemoveTask extends BaseTask<{ label: string }> {
      get taskName() { return 'remove'; }
      async execute(): Promise<TaskResult> {
        log.push(`remove:${this.options.label}`);
        return { success: true };
      }
    }
    class BadRemoveTask extends BaseTask {
      get taskName() { return 'bad_remove'; }
      async execute(): Promise<TaskResult> {
        log.push('bad_remove');
        return { success: false, error: new Error('cannot undo') };
      }
    }
    const registry = new TaskRegistry()
      .registerClassPath('test.Create', CreateTask as unknown as TaskConstructor)
      .registerClassPath('test.Remove', RemoveTask as unknown as TaskConstructor)
      .registerClassPath('test.BadRemove', BadRemoveTask as unknown as TaskConstructor)
      .registerClassPath('test.Fail', FailTask as unknown as TaskConstructor);
    const runner = new FlowRunner({
      tasks: {
        create: { class_path: 'test.Create', options: {} },
        remove: { class_path: 'test.Remove', options: {} },
        bad_remove: { class_path: 'test.BadRemove', options: {} },
        fail: { class_path: 'test.Fail', options: {} },
      },
      flows: {
        f: {
          description: 'rollback-with-errors',
          rollback_on_failure: true,
          steps: {
            '1': { task: 'create', options: { label: 'a' } },
            '2': { task: 'create', options: { label: 'b' } },
            '3': { task: 'fail' },
          },
        },
      },
      registry,
      context: {},
    });
    const result = await runner.run({ flowName: 'f' });
    expect(result.success).toBe(false);
    expect(log).toEqual(['create:a', 'create:b', 'bad_remove', 'remove:a']);
    expect(result.rollback!.attempted).toBe(2);
    expect(result.rollback!.succeeded).toBe(1);
    expect(result.rollback!.errors).toHaveLength(1);
  });

  it('does not roll back when rollback_on_failure is false', async () => {
    const log: string[] = [];
    class CreateTask extends BaseTask<{ label: string }> {
      get taskName() { return 'create'; }
      async execute(): Promise<TaskResult> {
        log.push(`create:${this.options.label}`);
        return {
          success: true,
          rollback: { taskName: 'remove', payload: { label: this.options.label } },
        };
      }
    }
    class RemoveTask extends BaseTask {
      get taskName() { return 'remove'; }
      async execute(): Promise<TaskResult> {
        log.push('remove'); // should never fire
        return { success: true };
      }
    }
    const registry = new TaskRegistry()
      .registerClassPath('test.Create', CreateTask as unknown as TaskConstructor)
      .registerClassPath('test.Remove', RemoveTask as unknown as TaskConstructor)
      .registerClassPath('test.Fail', FailTask as unknown as TaskConstructor);
    const runner = new FlowRunner({
      tasks: {
        create: { class_path: 'test.Create', options: {} },
        remove: { class_path: 'test.Remove', options: {} },
        fail: { class_path: 'test.Fail', options: {} },
      },
      flows: {
        f: {
          description: 'no-rollback',
          steps: {
            '1': { task: 'create', options: { label: 'a' } },
            '2': { task: 'fail' },
          },
        },
      },
      registry,
      context: {},
    });
    const result = await runner.run({ flowName: 'f' });
    expect(result.success).toBe(false);
    expect(log).toEqual(['create:a']);
    expect(result.rollback).toBeUndefined();
  });

  it('finally runs after rollback', async () => {
    const log: string[] = [];
    class CreateTask extends BaseTask<{ label: string }> {
      get taskName() { return 'create'; }
      async execute(): Promise<TaskResult> {
        log.push(`create:${this.options.label}`);
        return {
          success: true,
          rollback: { taskName: 'remove', payload: { label: this.options.label } },
        };
      }
    }
    class RemoveTask extends BaseTask<{ label: string }> {
      get taskName() { return 'remove'; }
      async execute(): Promise<TaskResult> {
        log.push(`remove:${this.options.label}`);
        return { success: true };
      }
    }
    class TickTask extends BaseTask<{ label: string }> {
      get taskName() { return 'tick'; }
      async execute(): Promise<TaskResult> {
        log.push(`tick:${this.options.label}`);
        return { success: true };
      }
    }
    const registry = new TaskRegistry()
      .registerClassPath('test.Create', CreateTask as unknown as TaskConstructor)
      .registerClassPath('test.Remove', RemoveTask as unknown as TaskConstructor)
      .registerClassPath('test.Tick', TickTask as unknown as TaskConstructor)
      .registerClassPath('test.Fail', FailTask as unknown as TaskConstructor);
    const runner = new FlowRunner({
      tasks: {
        create: { class_path: 'test.Create', options: {} },
        remove: { class_path: 'test.Remove', options: {} },
        tick: { class_path: 'test.Tick', options: {} },
        fail: { class_path: 'test.Fail', options: {} },
      },
      flows: {
        f: {
          description: 'rollback-then-finally',
          rollback_on_failure: true,
          finally: [{ task: 'tick', options: { label: 'final' } }],
          steps: {
            '1': { task: 'create', options: { label: 'a' } },
            '2': { task: 'fail' },
          },
        },
      },
      registry,
      context: {},
    });
    const result = await runner.run({ flowName: 'f' });
    expect(result.success).toBe(false);
    expect(log).toEqual(['create:a', 'remove:a', 'tick:final']);
  });
});
