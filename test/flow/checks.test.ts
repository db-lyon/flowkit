import { describe, it, expect } from 'vitest';
import {
  FlowRunner,
  CheckFailedError,
  type ConditionContext,
  type FlowRunnerConfig,
} from '../../src/flow/runner.js';
import { BaseTask, type TaskResult } from '../../src/task/base-task.js';
import { TaskRegistry, type TaskConstructor } from '../../src/task/registry.js';
import { FlowDefinitionSchema, FlowStepSchema } from '../../src/config/schema.js';
import type { FlowDefinition } from '../../src/config/schema.js';

class RecordTask extends BaseTask<{ label?: string }> {
  get taskName() {
    return 'record';
  }
  async execute(): Promise<TaskResult> {
    ((this.ctx as Record<string, unknown>).__log as string[]).push(this.options.label ?? '?');
    return { success: true, data: { label: this.options.label } };
  }
}

function setup(flows: Record<string, FlowDefinition>, extra: Partial<FlowRunnerConfig> = {}) {
  const log: string[] = [];
  const runner = new FlowRunner({
    tasks: { rec: { class_path: 't.Rec', options: {} } },
    flows,
    registry: new TaskRegistry().registerClassPath('t.Rec', RecordTask as unknown as TaskConstructor),
    context: { __log: log },
    ...extra,
  });
  return { runner, log };
}

const step = (label: string, checks?: FlowDefinition['steps'][string]['checks']) => ({
  task: 'rec',
  options: { label },
  ...(checks ? { checks } : {}),
});

describe('declared checks', () => {
  it('parses on steps and flows', () => {
    const s = FlowStepSchema.parse({ task: 'a', checks: [{ when: '${env.x}', action: 'warn' }] });
    expect(s.checks).toEqual([{ when: '${env.x}', action: 'warn' }]);
    expect(() => FlowStepSchema.parse({ task: 'a', checks: [{ when: true, action: 'explode' }] })).toThrow();
    const f = FlowDefinitionSchema.parse({ checks: [{ when: false, action: 'error', message: 'm' }] });
    expect(f.checks).toHaveLength(1);
  });

  it('error aborts before the step, even with ignore_failure', async () => {
    const { runner, log } = setup({
      f: {
        description: 'f',
        steps: {
          1: step('a'),
          2: { ...step('b', [{ when: true, action: 'error', message: 'editor is not connected' }]), ignore_failure: true },
          3: step('c'),
        },
      },
    });
    const res = await runner.run({ flowName: 'f' });
    expect(res.success).toBe(false);
    expect(log).toEqual(['a']);
    expect(res.error).toBeInstanceOf(CheckFailedError);
    expect(res.error?.message).toBe('editor is not connected');
    expect(res.steps[1]).toMatchObject({ name: 'rec', skipped: false, result: { success: false } });
    expect(res.steps[1]!.checks).toEqual([
      expect.objectContaining({ scope: 'step', stepNumber: 2, path: '2', action: 'error', triggered: true }),
    ]);
    expect(res.checks).toHaveLength(1);
  });

  it('skip skips the step, warn records a warning and runs it', async () => {
    const { runner, log } = setup({
      f: {
        description: 'f',
        steps: {
          1: step('a', [{ when: true, action: 'skip' }]),
          2: step('b', [
            { when: false, action: 'error' },
            { when: true, action: 'warn', message: 'python is disabled' },
          ]),
        },
      },
    });
    const res = await runner.run({ flowName: 'f' });
    expect(res.success).toBe(true);
    expect(log).toEqual(['b']);
    expect(res.steps[0]).toMatchObject({ skipped: true, skipReason: 'check' });
    expect(res.steps[1]!.checks!.map((c) => c.action)).toEqual(['warn']);
    expect(res.warnings).toEqual([{ code: 'check', name: 'rec', stepNumber: 2, message: 'python is disabled' }]);
    expect(res.checks!.map((c) => c.action)).toEqual(['skip', 'warn']);
  });

  it('runs checks only when `when:` lets the step run', async () => {
    const seen: string[] = [];
    const { runner } = setup(
      { f: { description: 'f', steps: { 1: { ...step('a', [{ when: 'chk', action: 'error' }]), when: 'gate' } } } },
      {
        conditionEvaluator: (expr) => {
          seen.push(expr);
          return false;
        },
      },
    );
    const res = await runner.run({ flowName: 'f' });
    expect(res.success).toBe(true);
    expect(seen).toEqual(['gate']);
  });

  it('hands the evaluator the check, the step, the flow and the host references', async () => {
    const calls: ConditionContext[] = [];
    const { runner } = setup(
      { f: { description: 'f', steps: { 1: step('a', [{ when: 'editor.connected == false', action: 'error' }]) } } },
      {
        references: { editor: { connected: true } },
        conditionEvaluator: (_expr, ctx) => {
          calls.push(ctx);
          return !(ctx.references!.editor as { connected: boolean }).connected;
        },
      },
    );
    const res = await runner.run({ flowName: 'f', params: { p: 1 } });
    expect(res.success).toBe(true);
    expect(calls[0]).toMatchObject({
      flowName: 'f',
      params: { p: 1 },
      references: { editor: { connected: true } },
      check: { action: 'error' },
      step: { stepNumber: 1, name: 'rec' },
    });
  });

  it('uses ${ns.path} truthiness without an evaluator', async () => {
    const { runner, log } = setup(
      { f: { description: 'f', steps: { 1: step('a', [{ when: '${editor.busy}', action: 'skip' }]), 2: step('b') } } },
      { references: { editor: { busy: 'true' } } },
    );
    await runner.run({ flowName: 'f' });
    expect(log).toEqual(['b']);
  });

  it('a check that cannot be evaluated fails the step like a throwing when:', async () => {
    const { runner, log } = setup({
      f: {
        description: 'f',
        steps: { 1: { ...step('a', [{ when: '${steps.9.x}', action: 'warn' }]), ignore_failure: true }, 2: step('b') },
      },
    });
    const res = await runner.run({ flowName: 'f' });
    expect(res.success).toBe(true);
    expect(res.steps[0]).toMatchObject({ ignoredFailure: true, result: { success: false } });
    expect(res.steps[0]!.result!.error!.message).toMatch(/could not be evaluated: Unresolvable step reference/);
    expect(log).toEqual(['b']);
  });

  it('flow-level checks gate the whole flow, hooks included, and nested flows report upward', async () => {
    const { runner, log } = setup({
      gated: {
        description: 'g',
        checks: [{ when: true, action: 'error', message: 'wrong project' }],
        steps: { 1: step('inner') },
        on_start: [step('start')],
      },
      skipped: { description: 's', checks: [{ when: true, action: 'skip' }], steps: { 1: step('never') } },
      outer: { description: 'o', steps: { 1: { flow: 'skipped' }, 2: step('x'), 3: { flow: 'gated' }, 4: step('y') } },
    });
    const direct = await runner.run({ flowName: 'gated' });
    expect(direct).toMatchObject({ success: false, steps: [] });
    expect(direct.error?.message).toBe('wrong project');
    expect(log).toEqual([]);

    const skippedRun = await runner.run({ flowName: 'skipped' });
    expect(skippedRun.success).toBe(true);
    expect(skippedRun.steps).toEqual([
      { stepNumber: 1, type: 'task', name: 'rec', skipped: true, duration: 0, skipReason: 'check' },
    ]);

    const res = await runner.run({ flowName: 'outer' });
    expect(res.success).toBe(false);
    expect(log).toEqual(['x']);
    expect(res.steps[2]!.checks).toEqual([
      expect.objectContaining({ scope: 'flow', flowName: 'gated', action: 'error', triggered: true }),
    ]);
    expect(res.checks!.map((c) => c.flowName)).toEqual(['skipped', 'gated']);
  });

  it('enforces checks on hook steps', async () => {
    const { runner, log } = setup({
      f: {
        description: 'f',
        steps: { 1: step('main') },
        on_success: [step('skipme', [{ when: true, action: 'skip' }])],
        finally: [step('blocked', [{ when: true, action: 'error', message: 'no' }])],
      },
    });
    const res = await runner.run({ flowName: 'f' });
    expect(log).toEqual(['main']);
    expect(res.hookErrors).toEqual([expect.objectContaining({ phase: 'finally', name: 'rec' })]);
    expect(res.hookErrors![0]!.error.message).toBe('no');
  });
});

describe('preflight', () => {
  const flows: Record<string, FlowDefinition> = {
    inner: {
      description: 'inner',
      checks: [{ when: '${gate.warn}', action: 'warn', message: 'inner warns' }],
      steps: { 1: step('i1', [{ when: '${steps.1.label}', action: 'error' }]) },
    },
    main: {
      description: 'main',
      checks: [{ when: false, action: 'error' }],
      steps: {
        1: step('a', [{ when: true, action: 'skip' }]),
        2: { flow: 'inner' },
        3: step('c', [{ when: '${gate.closed}', action: 'error', message: 'gate closed' }]),
        4: { task: 'None' },
      },
      finally: [step('f')],
    },
  };

  it('reports every step without running anything', async () => {
    const { runner, log } = setup(flows, {
      references: { gate: { closed: true } },
      conditionEvaluator: undefined,
    });
    const pf = await runner.preflight('main');
    expect(log).toEqual([]);
    expect(pf.ok).toBe(false);
    expect(pf.checks).toEqual([expect.objectContaining({ scope: 'flow', triggered: false })]);
    expect(pf.steps.map((s) => [s.path, s.status, s.skipReason])).toEqual([
      ['1', 'skip', 'check'],
      ['2', 'run', undefined],
      ['2/1', 'unknown', undefined],
      ['3', 'error', undefined],
      ['4', 'skip', 'static'],
      ['finally/1', 'run', undefined],
    ]);
    expect(pf.steps[2]!.checks[0]!.error!.message).toMatch(/Unresolvable step reference/);
    expect(pf.steps[3]!.checks[0]).toMatchObject({ message: 'gate closed', triggered: true });
    expect(pf.warnings).toBeUndefined();
  });

  it('passes params to check expressions and reports warn checks as warnings', async () => {
    const { runner } = setup(flows, {
      references: { gate: { closed: false } },
      conditionEvaluator: (expr, ctx) => {
        if (expr === '${gate.warn}') return ctx.params?.x === 1;
        if (expr.includes('steps.')) throw new Error('needs a step result');
        return false;
      },
    });
    const pf = await runner.preflight('main', { x: 1 }, { skip: ['3'] });
    expect(pf.ok).toBe(true);
    expect(pf.steps.find((s) => s.path === '2')!.checks).toEqual([
      expect.objectContaining({ scope: 'flow', flowName: 'inner', action: 'warn', triggered: true }),
    ]);
    expect(pf.steps.find((s) => s.path === '3')).toMatchObject({ status: 'skip', skipReason: 'static' });
    expect(pf.warnings).toEqual([{ code: 'check', kind: 'flow', name: 'inner', message: 'inner warns' }]);
  });

  it('shows declared checks on plan rows and in describeFlow', async () => {
    const { runner } = setup(flows);
    expect(runner.describeFlow('main').checks).toEqual([{ when: false, action: 'error' }]);
    expect(runner.describeFlow('main').steps[0]!.checks).toEqual([{ when: true, action: 'skip' }]);
  });

  it('throws for an unknown flow', async () => {
    const { runner } = setup(flows);
    await expect(runner.preflight('nope')).rejects.toThrow(/not found/);
  });
});
