import { describe, it, expect } from 'vitest';
import { FlowRunner } from '../../src/flow/runner.js';
import { BaseTask, type TaskResult } from '../../src/task/base-task.js';
import { TaskRegistry, type TaskConstructor } from '../../src/task/registry.js';
import { FlowDefinitionSchema, TaskDefinitionSchema } from '../../src/config/schema.js';
import { deprecationWarning, mergeWarnings } from '../../src/task/warnings.js';

class PassTask extends BaseTask {
  get taskName() {
    return 'pass';
  }
  async execute(): Promise<TaskResult> {
    return { success: true };
  }
}

class OldTask extends BaseTask {
  static deprecated = 'the class is going away';
  static replacedBy = 'pass';
  get taskName() {
    return 'old';
  }
  async execute(): Promise<TaskResult> {
    return { success: true, warnings: [{ code: 'check', name: 'self', message: 'own' }] };
  }
}

function runner() {
  const registry = new TaskRegistry()
    .registerClassPath('t.Pass', PassTask as unknown as TaskConstructor)
    .registerClassPath('t.Old', OldTask as unknown as TaskConstructor);
  return new FlowRunner({
    registry,
    context: {},
    tasks: {
      legacy: TaskDefinitionSchema.parse({ class_path: 't.Pass', deprecated: true, replaced_by: 'modern' }),
      modern: TaskDefinitionSchema.parse({ class_path: 't.Pass' }),
      classy: TaskDefinitionSchema.parse({ class_path: 't.Old' }),
      revived: TaskDefinitionSchema.parse({ class_path: 't.Old', deprecated: false }),
    },
    flows: {
      old_flow: FlowDefinitionSchema.parse({
        description: 'old',
        deprecated: 'merged into main',
        replaced_by: 'main',
        steps: { 1: { task: 'legacy' } },
      }),
      main: FlowDefinitionSchema.parse({
        description: 'main',
        steps: { 1: { task: 'legacy' }, 2: { task: 'legacy' }, 3: { flow: 'old_flow' }, 4: { task: 'modern' } },
        finally: [{ task: 'classy' }],
      }),
    },
  });
}

describe('deprecation', () => {
  it('formats a structured warning', () => {
    expect(deprecationWarning('task', 'a', true, undefined)).toEqual({
      code: 'deprecated',
      kind: 'task',
      name: 'a',
      message: 'Task "a" is deprecated',
    });
    expect(deprecationWarning('flow', 'f', 'Gone soon.', 'g')?.message).toBe(
      'Flow "f" is deprecated: Gone soon. Use "g" instead.',
    );
    expect(deprecationWarning('task', 'a', false, 'b')).toBeUndefined();
    const w = deprecationWarning('task', 'a', true, undefined)!;
    expect(mergeWarnings([w], [w], undefined)).toEqual([w]);
  });

  it('runs a deprecated task and reports it on the step and the run', async () => {
    const res = await runner().run({ flowName: 'main' });
    expect(res.success).toBe(true);
    expect(res.steps[0]!.result!.warnings).toEqual([
      { code: 'deprecated', kind: 'task', name: 'legacy', replacedBy: 'modern', message: 'Task "legacy" is deprecated. Use "modern" instead.' },
    ]);
    // Repeats (step 2, and legacy again inside old_flow) are folded; hook
    // warnings, including one the task added itself, come last.
    expect(res.warnings!.map((w) => [w.code, w.name])).toEqual([
      ['deprecated', 'legacy'],
      ['deprecated', 'old_flow'],
      ['check', 'self'],
      ['deprecated', 'classy'],
    ]);
  });

  it('reads class-level deprecation, and a definition can clear it', async () => {
    const r = runner();
    const classy = await r.runTask('classy');
    expect(classy.warnings).toEqual([
      { code: 'check', name: 'self', message: 'own' },
      {
        code: 'deprecated',
        kind: 'task',
        name: 'classy',
        replacedBy: 'pass',
        message: 'Task "classy" is deprecated: the class is going away. Use "pass" instead.',
      },
    ]);
    const revived = await r.runTask('revived');
    expect(revived.warnings).toEqual([{ code: 'check', name: 'self', message: 'own' }]);
  });

  it('reports deprecation in the plan without running anything', async () => {
    const plan = await runner().run({ flowName: 'old_flow', plan: true });
    expect(plan.steps[0]).toMatchObject({ name: 'legacy', deprecated: true, replaced_by: 'modern' });
    expect(plan.warnings!.map((w) => w.name)).toEqual(['old_flow', 'legacy']);

    const main = await runner().run({ flowName: 'main', plan: true });
    expect(main.steps.find((s) => s.name === 'old_flow')).toMatchObject({
      deprecated: 'merged into main',
      replaced_by: 'main',
    });
    expect(main.steps.find((s) => s.name === 'modern')).not.toHaveProperty('deprecated');
  });

  it('exposes deprecation through describe', async () => {
    const r = runner();
    expect(await r.describeTask('legacy')).toMatchObject({ deprecated: true, replaced_by: 'modern' });
    expect(await r.describeTask('classy')).toMatchObject({
      deprecated: 'the class is going away',
      replaced_by: 'pass',
    });
    expect(await r.describeTask('modern')).not.toHaveProperty('deprecated');
    expect(r.describeFlow('old_flow')).toMatchObject({
      name: 'old_flow',
      description: 'old',
      deprecated: 'merged into main',
      replaced_by: 'main',
      steps: [{ stepNumber: 1, name: 'legacy', type: 'task' }],
    });
  });

  it('does not warn about skipped steps, and adds no warnings key when there is nothing to say', async () => {
    const res = await runner().run({ flowName: 'main', skip: ['1', '2', '3'] });
    expect(res.warnings!.map((w) => w.name)).toEqual(['self', 'classy']);
    const modern = await runner().runTask('modern');
    expect(modern).not.toHaveProperty('warnings');
  });
});
