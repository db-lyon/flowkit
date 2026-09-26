import { describe, it, expect } from 'vitest';
import { FlowRunner } from '../../src/flow/runner.js';
import { BaseTask, type TaskResult } from '../../src/task/base-task.js';
import { TaskRegistry, type TaskConstructor } from '../../src/task/registry.js';
import type { FlowDefinition } from '../../src/config/schema.js';

class EchoTask extends BaseTask<{ v?: unknown }> {
  get taskName() {
    return 'echo';
  }
  async execute(): Promise<TaskResult> {
    return { success: true, data: { v: this.options.v } };
  }
}

function setup(flows: Record<string, FlowDefinition>, strict = false) {
  return new FlowRunner({
    tasks: {
      echo: { class_path: 't.Echo', options: {} },
      'asset.list': { class_path: 't.Echo', options: {} },
    },
    flows,
    registry: new TaskRegistry().registerClassPath('t.Echo', EchoTask as unknown as TaskConstructor),
    context: {},
    strictStepReferences: strict,
  });
}

const dup: Record<string, FlowDefinition> = {
  f: {
    description: 'f',
    steps: {
      1: { task: 'echo', options: { v: 'first' } },
      2: { task: 'echo', options: { v: 'second' } },
      3: { task: 'asset.list', options: { v: '${steps.echo.v}' } },
      4: { task: 'asset.list', options: { v: '${steps.1.v}' } },
    },
  },
};

describe('step references by identity', () => {
  it('by default a duplicated name binds to the most recent completed step', async () => {
    const res = await setup(dup).run({ flowName: 'f' });
    expect(res.success).toBe(true);
    expect(res.steps[2]!.result!.data).toEqual({ v: 'second' });
    expect(res.steps[3]!.result!.data).toEqual({ v: 'first' });
  });

  it('dotted task names bind by the longest matching prefix', async () => {
    const res = await setup({
      f: {
        description: 'f',
        steps: {
          1: { task: 'asset.list', options: { v: { items: [1, 2] } } },
          2: { task: 'echo', options: { v: '${steps.asset.list.v.items}' } },
        },
      },
    }).run({ flowName: 'f' });
    expect(res.steps[1]!.result!.data).toEqual({ v: [1, 2] });
  });

  it('checkStepReferences reports ambiguous, unknown and forward references', () => {
    const runner = setup({
      inner: { description: 'i', steps: { 1: { task: 'echo', options: { v: '${steps.nope.x}' } } } },
      f: {
        description: 'f',
        steps: {
          1: { task: 'echo', options: { v: '${steps.3.v}' } },
          2: { task: 'echo' },
          3: { task: 'asset.list', options: { v: 'x ${steps.echo.v} ${steps.9.v}' }, when: '${steps.1.v}' },
          4: { flow: 'inner', options: { echo: { v: '${steps.1.v}' } } },
        },
        finally: [{ task: 'echo', checks: [{ when: '${steps.asset.list.v}', action: 'warn' }] }],
      },
    });
    expect(runner.checkStepReferences('f')).toEqual([
      expect.objectContaining({ flowName: 'f', stepNumber: 1, kind: 'forward', reference: '${steps.3.v}' }),
      expect.objectContaining({ flowName: 'f', stepNumber: 3, kind: 'ambiguous', reference: '${steps.echo.v}' }),
      expect.objectContaining({ flowName: 'f', stepNumber: 3, kind: 'unknown', reference: '${steps.9.v}' }),
      expect.objectContaining({ flowName: 'inner', stepNumber: 1, kind: 'unknown', reference: '${steps.nope.x}' }),
    ]);
    const ambiguous = runner.checkStepReferences('f')[1]!;
    expect(ambiguous.message).toBe('${steps.echo.v}: "echo" is the name of steps 1, 2; reference one by number');
    expect(setup(dup).checkStepReferences('f').map((i) => i.kind)).toEqual(['ambiguous']);
  });

  it('strictStepReferences refuses to run or plan a flow with an unbindable reference', async () => {
    const runner = setup(dup, true);
    const res = await runner.run({ flowName: 'f' });
    expect(res.success).toBe(false);
    expect(res.steps).toEqual([]);
    expect(res.error?.message).toBe(
      'Unbindable step references: f step 3: ${steps.echo.v}: "echo" is the name of steps 1, 2; reference one by number',
    );
    const plan = await runner.run({ flowName: 'f', plan: true });
    expect(plan.success).toBe(false);

    const clean = setup(
      { f: { description: 'f', steps: { 1: { task: 'echo', options: { v: 1 } }, 2: { task: 'echo', options: { v: '${steps.1.v}' } } } } },
      true,
    );
    expect((await clean.run({ flowName: 'f' })).success).toBe(true);
  });
});
