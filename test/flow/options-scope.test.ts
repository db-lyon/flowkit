import { describe, it, expect } from 'vitest';
import { FlowRunner, type FlowRunnerConfig } from '../../src/flow/runner.js';
import { BaseTask, type TaskResult } from '../../src/task/base-task.js';
import { TaskRegistry, type TaskConstructor } from '../../src/task/registry.js';
import type { FlowDefinition } from '../../src/config/schema.js';

class EchoTask extends BaseTask {
  get taskName() {
    return 'echo';
  }
  async execute(): Promise<TaskResult> {
    const log = (this.ctx as Record<string, unknown>).__log as Record<string, unknown>[];
    log.push({ ...this.options });
    return { success: true, data: { ...this.options } };
  }
}

function setup(
  flows: Record<string, FlowDefinition>,
  extra: Partial<FlowRunnerConfig> = {},
): { runner: FlowRunner; log: Record<string, unknown>[] } {
  const log: Record<string, unknown>[] = [];
  const runner = new FlowRunner({
    tasks: {
      a: { class_path: 't.Echo', options: { who: 'a' } },
      b: { class_path: 't.Echo', options: { who: 'b' } },
      'asset.list': { class_path: 't.Echo', options: { who: 'asset.list' } },
    },
    flows,
    registry: new TaskRegistry().registerClassPath('t.Echo', EchoTask as unknown as TaskConstructor),
    context: { __log: log },
    ...extra,
  });
  return { runner, log };
}

const inner: FlowDefinition = { description: 'inner', steps: { 1: { task: 'a' }, 2: { task: 'asset.list' } } };

describe('runtime options scope', () => {
  it('flat by default: every key reaches every step', async () => {
    const { runner, log } = setup({
      inner,
      main: { description: 'm', steps: { 1: { task: 'a' }, 2: { flow: 'inner' } } },
    });
    const res = await runner.run({ flowName: 'main', params: { x: 1 } });
    expect(res.success).toBe(true);
    expect(log).toEqual([
      { who: 'a', x: 1 },
      { who: 'a', x: 1 },
      { who: 'asset.list', x: 1 },
    ]);
  });

  it('step scope addresses by task name (dotted names too) and by path, path winning', async () => {
    const { runner, log } = setup({
      inner,
      main: {
        description: 'm',
        options_scope: 'step',
        steps: { 1: { task: 'a' }, 2: { flow: 'inner' }, 3: { task: 'b' } },
        finally: [{ task: 'b' }],
      },
    });
    const res = await runner.run({
      flowName: 'main',
      params: {
        a: { x: 'every a', y: 'name' },
        '2/1': { y: 'path' },
        'asset.list': { z: 1 },
        b: { w: true },
      },
    });
    expect(res.success).toBe(true);
    expect(log).toEqual([
      { who: 'a', x: 'every a', y: 'name' },
      { who: 'a', x: 'every a', y: 'path' },
      { who: 'asset.list', z: 1 },
      { who: 'b', w: true },
      { who: 'b', w: true }, // the finally hook, addressed by name
    ]);
  });

  it('a step path addresses only that step', async () => {
    const { runner, log } = setup(
      { main: { description: 'm', steps: { 1: { task: 'a' }, 2: { task: 'a' } } } },
      { optionsScope: 'step' },
    );
    await runner.run({ flowName: 'main', params: { 2: { only: 'second' } } });
    expect(log).toEqual([{ who: 'a' }, { who: 'a', only: 'second' }]);
  });

  it('keeps precedence below runtime params: task default, step options, then scoped params', async () => {
    const { runner, log } = setup({
      main: { description: 'm', steps: { 1: { task: 'a', options: { who: 'step', k: 1 } } } },
    });
    await runner.run({ flowName: 'main', optionsScope: 'step', params: { a: { k: 2 } } });
    expect(log).toEqual([{ who: 'step', k: 2 }]);
  });

  it('the run option beats the flow setting, which beats the runner default', async () => {
    const flows = { main: { description: 'm', options_scope: 'flat' as const, steps: { 1: { task: 'a' } } } };
    const { runner, log } = setup(flows, { optionsScope: 'step' });
    await runner.run({ flowName: 'main', params: { q: 1 } });
    expect(log).toEqual([{ who: 'a', q: 1 }]);
    await runner.run({ flowName: 'main', optionsScope: 'step', params: { a: { q: 2 } } });
    expect(log[1]).toEqual({ who: 'a', q: 2 });
  });

  it('rejects selectors that match nothing, and values that are not objects, before anything runs', async () => {
    const { runner, log } = setup({
      inner,
      main: { description: 'm', options_scope: 'step', steps: { 1: { task: 'a' }, 2: { flow: 'inner' } } },
    });
    const res = await runner.run({ flowName: 'main', params: { nope: {}, 2: { x: 1 }, a: 3 } });
    expect(res.success).toBe(false);
    expect(res.steps).toEqual([]);
    expect(res.error?.message).toBe(
      // Integer-like keys enumerate first, as JavaScript orders them.
      'Invalid step-scoped params: "2" matches no task name or step path in flow "main"; ' +
        '"nope" matches no task name or step path in flow "main"; "a" must map to an object of options',
    );
    expect(log).toEqual([]);

    const plan = await runner.run({ flowName: 'main', plan: true, params: { nope: {} } });
    expect(plan.success).toBe(false);
    expect(plan.error?.message).toMatch(/"nope" matches no task/);

    const ok = await runner.run({ flowName: 'main', plan: true, params: { '2/2': { z: 1 } } });
    expect(ok.success).toBe(true);
  });
});
