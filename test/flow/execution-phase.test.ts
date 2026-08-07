import { describe, expect, it, vi } from 'vitest';
import { FlowRunner } from '../../src/flow/runner.js';
import { AgentTask } from '../../src/task/agent-task.js';
import {
  BaseTask,
  type ExecutionPhase,
  type TaskContext,
  type ResolvedTaskContext,
  type TaskResult,
} from '../../src/task/base-task.js';
import type { LLMProvider } from '../../src/task/llm-provider.js';
import { TaskRegistry, type TaskConstructor } from '../../src/task/registry.js';

interface Observation {
  label: string;
  phase: ExecutionPhase;
  context: TaskContext;
}

interface PhaseOptions {
  label: string;
  fail?: boolean;
  signal?: AbortSignal;
  mutatePhase?: ExecutionPhase;
  rollback?: { taskName: string; payload: Record<string, unknown> };
  gate?: Promise<void>;
}

class PhaseTask extends BaseTask<PhaseOptions> {
  get taskName() { return 'phase'; }

  async execute(): Promise<TaskResult> {
    const observations = this.ctx.observations as Observation[];
    observations.push({
      label: this.options.label,
      phase: this.executionPhase,
      context: this.ctx,
    });
    if (this.options.mutatePhase) {
      (this.ctx as { executionPhase: ExecutionPhase }).executionPhase =
        this.options.mutatePhase;
    }
    await this.options.gate;
    if (this.options.signal?.aborted) {
      return { success: false, error: new Error('cancelled') };
    }
    if (this.options.fail) {
      return { success: false, error: new Error('failed') };
    }
    return { success: true, rollback: this.options.rollback };
  }
}

class CallingTask extends BaseTask<{ label: string }> {
  get taskName() { return 'calling'; }

  async execute(): Promise<TaskResult> {
    (this.ctx.observations as Observation[]).push({
      label: this.options.label,
      phase: this.executionPhase,
      context: this.ctx,
    });
    return this.call('phase', { label: `${this.options.label}:child` });
  }
}

function createRunner(
  observations: Observation[],
  flows: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): FlowRunner {
  const registry = new TaskRegistry()
    .register('phase', PhaseTask as unknown as TaskConstructor)
    .register('calling', CallingTask as unknown as TaskConstructor);
  return new FlowRunner({
    tasks: {
      phase: { class_path: 'phase', options: {} },
      calling: { class_path: 'calling', options: {} },
    },
    flows: flows as never,
    registry,
    context: { observations, ...extra },
  });
}

describe('TaskContext.executionPhase', () => {
  it('marks a cancelled step as task and its failure hooks with their phases', async () => {
    const observations: Observation[] = [];
    const controller = new AbortController();
    controller.abort();
    const runner = createRunner(observations, {
      main: {
        steps: { 1: { task: 'phase', options: { label: 'cancelled', signal: controller.signal } } },
        on_failure: [{ task: 'phase', options: { label: 'failure-cleanup' } }],
        finally: [{ task: 'phase', options: { label: 'final-cleanup' } }],
      },
    });

    const result = await runner.run({ flowName: 'main' });

    expect(result.success).toBe(false);
    expect(observations.map(({ label, phase }) => [label, phase])).toEqual([
      ['cancelled', 'task'],
      ['failure-cleanup', 'on_failure'],
      ['final-cleanup', 'finally'],
    ]);
    expect(new Set(observations.map((entry) => entry.context)).size).toBe(3);
  });

  it('marks rollback-record invocations as rollback', async () => {
    const observations: Observation[] = [];
    const runner = createRunner(observations, {
      main: {
        rollback_on_failure: true,
        steps: {
          1: {
            task: 'phase',
            options: {
              label: 'create',
              rollback: { taskName: 'phase', payload: { label: 'undo' } },
            },
          },
          2: { task: 'phase', options: { label: 'fail', fail: true } },
        },
      },
    });

    const result = await runner.run({ flowName: 'main' });

    expect(result.rollback).toEqual({ attempted: 1, succeeded: 1, errors: [] });
    expect(observations.map(({ label, phase }) => [label, phase])).toEqual([
      ['create', 'task'],
      ['fail', 'task'],
      ['undo', 'rollback'],
    ]);
  });

  it('keeps ordinary tasks in nested flows at task', async () => {
    const observations: Observation[] = [];
    const runner = createRunner(observations, {
      outer: { steps: { 1: { flow: 'inner' } } },
      inner: { steps: { 1: { task: 'phase', options: { label: 'nested' } } } },
    });

    expect((await runner.run({ flowName: 'outer' })).success).toBe(true);
    expect(observations[0]?.phase).toBe('task');
  });

  it('marks success hooks and resets ordinary work inside a hook flow to task', async () => {
    const observations: Observation[] = [];
    const runner = createRunner(observations, {
      main: {
        on_start: [{ task: 'phase', options: { label: 'start' } }],
        steps: { 1: { task: 'phase', options: { label: 'main' } } },
        on_success: [
          { task: 'phase', options: { label: 'success' } },
          { flow: 'cleanup-flow' },
        ],
        finally: [{ task: 'phase', options: { label: 'finally' } }],
      },
      'cleanup-flow': {
        steps: { 1: { task: 'phase', options: { label: 'nested-cleanup-task' } } },
      },
    });

    expect((await runner.run({ flowName: 'main' })).success).toBe(true);
    expect(observations.map(({ label, phase }) => [label, phase])).toEqual([
      ['start', 'on_start'],
      ['main', 'task'],
      ['success', 'on_success'],
      ['nested-cleanup-task', 'task'],
      ['finally', 'finally'],
    ]);
  });

  it('uses task for direct calls and task-to-task calls, even from a hook', async () => {
    const observations: Observation[] = [];
    const runner = createRunner(observations, {
      main: {
        steps: { 1: { task: 'phase', options: { label: 'fail', fail: true } } },
        on_failure: [{ task: 'calling', options: { label: 'hook-caller' } }],
      },
    });

    await runner.runTask('phase', { label: 'direct' });
    await runner.run({ flowName: 'main' });

    expect(observations.map(({ label, phase }) => [label, phase])).toEqual([
      ['direct', 'task'],
      ['fail', 'task'],
      ['hook-caller', 'on_failure'],
      ['hook-caller:child', 'task'],
    ]);
  });

  it('uses task for agent, sub-agent, and task-backed tool execution', async () => {
    const observations: Observation[] = [];
    const turns: Record<string, number> = {};
    const provider: LLMProvider = {
      async complete(request) {
        const system = request.system ?? '';
        turns[system] = (turns[system] ?? 0) + 1;
        if (system === 'COORD' && turns[system] === 1) {
          return {
            text: '',
            finishReason: 'tool_use',
            toolCalls: [{ id: '1', name: 'worker', arguments: { prompt: 'work' } }],
          };
        }
        if (system === 'WORKER' && turns[system] === 1) {
          return {
            text: '',
            finishReason: 'tool_use',
            toolCalls: [{ id: '2', name: 'phase', arguments: { label: 'agent-tool' } }],
          };
        }
        return { text: 'done', finishReason: 'stop' };
      },
    };
    const originalAgentExecute = AgentTask.prototype.execute;
    const agentSpy = vi
      .spyOn(AgentTask.prototype, 'execute')
      .mockImplementation(async function (this: AgentTask) {
        const instance = this as unknown as {
          ctx: ResolvedTaskContext & { observations: Observation[] };
          options: { system?: string };
        };
        instance.ctx.observations.push({
          label: `agent:${instance.options.system}`,
          phase: instance.ctx.executionPhase,
          context: instance.ctx,
        });
        return originalAgentExecute.call(this);
      });
    const registry = new TaskRegistry().register(
      'phase',
      PhaseTask as unknown as TaskConstructor,
    );
    const runner = new FlowRunner({
      tasks: { phase: { class_path: 'phase', options: {} } },
      flows: {
        main: {
          steps: { 1: { task: 'phase', options: { label: 'failed-step', fail: true } } },
          on_failure: [{ task: 'coord', options: { prompt: 'go' } }],
        },
      },
      agents: {
        coord: {
          system: 'COORD',
          tools: [{ agent: 'worker' }],
          budget: { tokenBudget: 100_000 },
        },
        worker: { system: 'WORKER', tools: [{ task: 'phase' }] },
      },
      registry,
      context: { observations, llm: provider },
    });

    try {
      expect((await runner.run({ flowName: 'main' })).success).toBe(false);
      expect(observations.map(({ label, phase }) => [label, phase])).toEqual([
        ['failed-step', 'task'],
        ['agent:COORD', 'on_failure'],
        ['agent:WORKER', 'task'],
        ['agent-tool', 'task'],
      ]);
    } finally {
      agentSpy.mockRestore();
    }
  });

  it('does not bleed phase between concurrent runs on the same runner', async () => {
    const observations: Observation[] = [];
    let releaseFailureHook!: () => void;
    const failureHookGate = new Promise<void>((resolve) => { releaseFailureHook = resolve; });
    let failureHookStarted!: () => void;
    const started = new Promise<void>((resolve) => { failureHookStarted = resolve; });

    class GatedHookTask extends PhaseTask {
      async execute(): Promise<TaskResult> {
        failureHookStarted();
        return super.execute();
      }
    }

    const registry = new TaskRegistry()
      .register('phase', PhaseTask as unknown as TaskConstructor)
      .register('gated', GatedHookTask as unknown as TaskConstructor);
    const runner = new FlowRunner({
      tasks: {
        phase: { class_path: 'phase', options: {} },
        gated: { class_path: 'gated', options: {} },
      },
      flows: {
        failing: {
          steps: { 1: { task: 'phase', options: { label: 'fail', fail: true } } },
          on_failure: [{ task: 'gated', options: { label: 'blocked-hook', gate: failureHookGate } }],
        },
        successful: {
          steps: { 1: { task: 'phase', options: { label: 'concurrent-task' } } },
        },
      },
      registry,
      context: { observations },
    });

    const failing = runner.run({ flowName: 'failing' });
    await started;
    const successful = runner.run({ flowName: 'successful' });
    await successful;
    releaseFailureHook();
    await failing;

    expect(observations.map(({ label, phase }) => [label, phase])).toEqual([
      ['fail', 'task'],
      ['blocked-hook', 'on_failure'],
      ['concurrent-task', 'task'],
    ]);
  });

  it('ignores a host-supplied phase and isolates forced task-side mutation', async () => {
    const observations: Observation[] = [];
    const runner = createRunner(
      observations,
      {
        main: {
          steps: {
            1: {
              task: 'phase',
              options: { label: 'mutator', mutatePhase: 'rollback' },
            },
            2: { task: 'phase', options: { label: 'after-mutation' } },
          },
        },
      },
      { executionPhase: 'finally' },
    );

    expect((await runner.run({ flowName: 'main' })).success).toBe(true);
    expect(observations.map(({ label, phase }) => [label, phase])).toEqual([
      ['mutator', 'task'],
      ['after-mutation', 'task'],
    ]);
    expect(observations[0]?.context).not.toBe(observations[1]?.context);
  });

  it('derives a fresh task context for every retry attempt', async () => {
    const observations: Observation[] = [];
    const runner = createRunner(observations, {
      main: {
        steps: {
          1: { task: 'phase', retries: 1, options: { label: 'attempt', fail: true } },
        },
      },
    });

    expect((await runner.run({ flowName: 'main' })).success).toBe(false);
    expect(observations.map(({ phase }) => phase)).toEqual(['task', 'task']);
    expect(observations[0]?.context).not.toBe(observations[1]?.context);
  });
});

describe('executionPhase in when: conditions', () => {
  it('hands a conditionEvaluator the phase the gated task will observe', async () => {
    const seen: Array<[string, unknown]> = [];
    const observations: Observation[] = [];
    const registry = new TaskRegistry().register(
      'phase',
      PhaseTask as unknown as TaskConstructor,
    );
    const runner = new FlowRunner({
      tasks: { phase: { class_path: 'phase', options: {} } },
      flows: {
        main: {
          steps: { 1: { task: 'phase', when: 'gate-step', options: { label: 'main' } } },
          on_success: [
            { task: 'phase', when: 'gate-success', options: { label: 'success' } },
          ],
          finally: [{ task: 'phase', when: 'gate-finally', options: { label: 'finally' } }],
        },
      } as never,
      registry,
      context: { observations },
      conditionEvaluator: (when, ctx) => {
        seen.push([String(when), ctx.context.executionPhase]);
        return true;
      },
    });

    expect((await runner.run({ flowName: 'main' })).success).toBe(true);

    // Each gate sees its own step's phase, matching what that step's task then
    // observes — not the runner-level 'task' seed.
    expect(seen).toEqual([
      ['gate-step', 'task'],
      ['gate-success', 'on_success'],
      ['gate-finally', 'finally'],
    ]);
    expect(observations.map(({ phase }) => phase)).toEqual(['task', 'on_success', 'finally']);
  });
});
