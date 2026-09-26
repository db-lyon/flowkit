import { describe, it, expect } from 'vitest';
import { FlowRunner, type PlanStep, type FlowStepResult } from '../../src/flow/runner.js';
import { BaseTask, type TaskResult } from '../../src/task/base-task.js';
import { TaskRegistry, type TaskConstructor } from '../../src/task/registry.js';
import { collectRollbackRecords, type ChildPlanEntry } from '../../src/task/composite.js';
import type { FlowDefinition, TaskDefinition, OptionSpecs } from '../../src/config/schema.js';

type Log = string[];
const logOf = (ctx: unknown) => (ctx as Record<string, unknown>).__log as Log;

class ItemTask extends BaseTask<{ id: string; fail?: boolean }> {
  static optionsSchema: OptionSpecs = { id: { type: 'string', required: true } };
  get taskName() {
    return 'item';
  }
  async execute(): Promise<TaskResult> {
    logOf(this.ctx).push(`item:${this.options.id}`);
    if (this.options.fail) return { success: false, error: new Error(`item ${this.options.id} failed`) };
    return {
      success: true,
      data: { id: this.options.id },
      rollback: { taskName: 'undo', payload: { id: this.options.id } },
    };
  }
}

class UndoTask extends BaseTask<{ id: string }> {
  get taskName() {
    return 'undo';
  }
  async execute(): Promise<TaskResult> {
    logOf(this.ctx).push(`undo:${this.options.id}`);
    return { success: true };
  }
}

let flaky = 0;
class FlakyTask extends BaseTask {
  get taskName() {
    return 'flaky';
  }
  async execute(): Promise<TaskResult> {
    flaky++;
    return flaky < 3 ? { success: false, error: new Error('transient') } : { success: true, data: { flaky } };
  }
}

/** Fans out over `ids`, one child per id; best effort, reports what it did. */
class BatchTask extends BaseTask<{ ids: string[]; failFast?: boolean }> {
  static expand(options: Record<string, unknown>): ChildPlanEntry[] | null {
    const ids = options.ids;
    if (!Array.isArray(ids)) return null;
    return ids.map((id) => ({ task: 'item', options: { id } }));
  }
  get taskName() {
    return 'batch';
  }
  async execute(): Promise<TaskResult> {
    const results: unknown[] = [];
    for (const id of this.options.ids) {
      const r = await this.step('item', { id, fail: id === 'bad' });
      results.push({ id, ok: r.success });
      if (!r.success && this.options.failFast) {
        return { success: false, error: r.error, data: { results, stoppedAt: id } };
      }
    }
    return { success: true, data: { results } };
  }
}

/** Keeps calling a child until the data says stop: children depend on results. */
class PagerTask extends BaseTask<{ cap: number }> {
  static expand(): null {
    return null;
  }
  get taskName() {
    return 'pager';
  }
  async execute(): Promise<TaskResult> {
    let page = 0;
    while (page < this.options.cap) {
      page++;
      const r = await this.step({ task: 'item' }, { id: `p${page}` });
      if (!r.success) return r;
    }
    const f = await this.step({ flow: 'tail' }, {});
    return { success: f.success, data: { pages: page } };
  }
}

class RetryingComposite extends BaseTask {
  get taskName() {
    return 'retrying';
  }
  async execute(): Promise<TaskResult> {
    const r = await this.step('flaky', {}, { retries: 3 });
    return { success: r.success, data: { child: r.data } };
  }
}

class FailTask extends BaseTask {
  get taskName() {
    return 'fail';
  }
  async execute(): Promise<TaskResult> {
    return { success: false, error: new Error('boom') };
  }
}

function setup(
  flows: Record<string, FlowDefinition> = {},
  tasks: Record<string, TaskDefinition> = {},
  hooks?: ConstructorParameters<typeof FlowRunner>[0]['hooks'],
) {
  const log: Log = [];
  const registry = new TaskRegistry().registerAll({
    item: ItemTask as unknown as TaskConstructor,
    undo: UndoTask as unknown as TaskConstructor,
    batch: BatchTask as unknown as TaskConstructor,
    pager: PagerTask as unknown as TaskConstructor,
    flaky: FlakyTask as unknown as TaskConstructor,
    retrying: RetryingComposite as unknown as TaskConstructor,
    fail: FailTask as unknown as TaskConstructor,
  });
  const runner = new FlowRunner({
    tasks,
    flows: { tail: { description: 't', steps: { 1: { task: 'item', options: { id: 'tail' } } } }, ...flows },
    registry,
    context: { __log: log },
    hooks,
  });
  return { runner, log };
}

describe('composite child steps', () => {
  it('records each child under the parent step, with paths, and fires step hooks', async () => {
    const seen: string[] = [];
    const { runner, log } = setup(
      { f: { description: 'f', steps: { 1: { task: 'item', options: { id: 'first' } }, 2: { task: 'batch', options: { ids: ['a', 'b'] } } } } },
      {},
      {
        beforeStep: async (s: PlanStep) => void seen.push(`before ${s.path ?? s.stepNumber} ${s.name}`),
        afterStep: async (s: PlanStep, r: FlowStepResult) =>
          void seen.push(`after ${s.path ?? s.stepNumber} ${s.name} ${r.result?.success}`),
      },
    );
    const res = await runner.run({ flowName: 'f' });
    expect(res.success).toBe(true);
    expect(log).toEqual(['item:first', 'item:a', 'item:b']);
    const children = res.steps[1]!.result!.children!;
    expect(children.map((c) => [c.stepNumber, c.path, c.name, c.result?.data])).toEqual([
      [1, '2/1', 'item', { id: 'a' }],
      [2, '2/2', 'item', { id: 'b' }],
    ]);
    expect(seen).toEqual([
      'before 1 item',
      'after 1 item true',
      'before 2 batch',
      'before 2/1 item',
      'after 2/1 item true',
      'before 2/2 item',
      'after 2/2 item true',
      'after 2 batch true',
    ]);
  });

  it('returns a failed child to the composite, which decides', async () => {
    const { runner, log } = setup();
    const best = await runner.runTask('batch', { ids: ['a', 'bad', 'c'] });
    expect(best.success).toBe(true);
    expect(log).toEqual(['item:a', 'item:bad', 'item:c']);
    expect(best.children!.map((c) => c.result!.success)).toEqual([true, false, true]);

    const fast = await runner.runTask('batch', { ids: ['a', 'bad', 'c'], failFast: true });
    expect(fast.success).toBe(false);
    expect(fast.data).toMatchObject({ stoppedAt: 'bad' });
    expect(fast.children).toHaveLength(2);
  });

  it('applies the step retry policy and option schemas to children', async () => {
    flaky = 0;
    const { runner } = setup();
    const r = await runner.runTask('retrying');
    expect(r.success).toBe(true);
    expect(r.children![0]).toMatchObject({ name: 'flaky', attempts: 3 });

    const bad = await runner.runTask('batch', { ids: [7] as unknown as string[] });
    expect(bad.children![0]!.result!.error!.message).toBe('Task "item": option "id" expected type string but got number');
  });

  it('runs a child flow, and works standalone under runTask', async () => {
    const { runner, log } = setup();
    const r = await runner.runTask('pager', { cap: 2 });
    expect(r.success).toBe(true);
    expect(log).toEqual(['item:p1', 'item:p2', 'item:tail']);
    expect(r.children!.map((c) => [c.type, c.name, c.path])).toEqual([
      ['task', 'item', '1'],
      ['task', 'item', '2'],
      ['flow', 'tail', '3'],
    ]);
    expect(r.children![2]!.nestedSteps![0]!.result!.data).toEqual({ id: 'tail' });
    expect(collectRollbackRecords(r).map((x) => x.payload.id)).toEqual(['p1', 'p2', 'tail']);
  });

  it('harvests children rollback records inside a flow and unwinds them in reverse', async () => {
    const { runner, log } = setup({
      f: {
        description: 'f',
        rollback_on_failure: true,
        steps: { 1: { task: 'batch', options: { ids: ['a', 'b'] } }, 2: { task: 'fail' } },
      },
    });
    const res = await runner.run({ flowName: 'f' });
    expect(res.success).toBe(false);
    expect(log).toEqual(['item:a', 'item:b', 'undo:b', 'undo:a']);
    expect(res.rollback).toMatchObject({ attempted: 2, succeeded: 2 });
  });

  it('surfaces a deprecated child on the parent and the run', async () => {
    const { runner } = setup(
      { f: { description: 'f', steps: { 1: { task: 'batch', options: { ids: ['a'] } } } } },
      { item: { class_path: 'item', options: {}, deprecated: 'use item2' } },
    );
    const res = await runner.run({ flowName: 'f' });
    expect(res.warnings).toEqual([expect.objectContaining({ code: 'deprecated', name: 'item' })]);
  });

  it('falls back to call() when constructed outside a runner', async () => {
    const log: Log = [];
    const registry = new TaskRegistry().registerAll({ item: ItemTask as unknown as TaskConstructor });
    const task = new BatchTask({ __log: log, registry }, { ids: ['x'] });
    const r = await task.run();
    expect(r.success).toBe(true);
    expect(log).toEqual(['item:x']);
    expect(r.children).toBeUndefined();
  });
});

describe('composite expand in plans', () => {
  const flows: Record<string, FlowDefinition> = {
    f: {
      description: 'f',
      steps: {
        1: { task: 'batch', options: { ids: ['a', 'b'] } },
        2: { task: 'pager', options: { cap: 3 } },
        3: { task: 'item', options: { id: 'z' } },
      },
    },
  };

  it('lists a composite children under it, and marks one that cannot say as opaque', async () => {
    const { runner, log } = setup(flows);
    const plan = await runner.run({ flowName: 'f', plan: true, expandComposites: true });
    expect(log).toEqual([]);
    expect(plan.steps.map((s) => [(s as unknown as PlanStep).path, s.name, (s as unknown as PlanStep).composite])).toEqual([
      ['1', 'batch', 'expanded'],
      ['1/1', 'item', undefined],
      ['1/2', 'item', undefined],
      [undefined, 'pager', 'opaque'],
      [undefined, 'item', undefined],
    ]);
  });

  it('leaves the plan unchanged without expandComposites', async () => {
    const { runner } = setup(flows);
    const plan = await runner.run({ flowName: 'f', plan: true });
    expect(plan.steps.map((s) => s.name)).toEqual(['batch', 'pager', 'item']);
    expect(plan.steps[0]).not.toHaveProperty('composite');
  });

  it('uses runtime params and composes with expandNestedFlows', async () => {
    const { runner } = setup({
      outer: { description: 'o', steps: { 1: { flow: 'inner' } } },
      inner: { description: 'i', steps: { 1: { task: 'batch' } } },
    });
    const plan = await runner.run({
      flowName: 'outer',
      plan: true,
      expandNestedFlows: true,
      expandComposites: true,
      params: { ids: ['q'] },
    });
    expect(plan.steps.map((s) => (s as unknown as PlanStep).path)).toEqual(['1', '1/1', '1/1/1']);
  });

  it('expandTask reports the child plan for describe', async () => {
    const { runner } = setup({}, { batch3: { class_path: 'batch', options: { ids: ['a', 'b', 'c'] } } });
    expect(await runner.expandTask('batch3')).toEqual([
      { task: 'item', options: { id: 'a' } },
      { task: 'item', options: { id: 'b' } },
      { task: 'item', options: { id: 'c' } },
    ]);
    expect(await runner.expandTask('batch3', { ids: ['x'] })).toEqual([{ task: 'item', options: { id: 'x' } }]);
    expect(await runner.expandTask('pager')).toBeNull();
    expect(await runner.expandTask('item')).toBeNull();
  });
});
