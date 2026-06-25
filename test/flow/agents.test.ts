import { describe, it, expect } from 'vitest';
import { FlowRunner } from '../../src/flow/runner.js';
import { TaskRegistry } from '../../src/task/registry.js';
import { BaseTask, type TaskResult } from '../../src/task/base-task.js';
import type { LLMProvider } from '../../src/task/llm-provider.js';
import type { AgentDefinition } from '../../src/config/schema.js';

class EchoTask extends BaseTask<Record<string, unknown>> {
  get taskName() { return 'echo'; }
  async execute(): Promise<TaskResult> {
    return { success: true, data: { echoed: this.options } };
  }
}

/** Provider that routes by the system prompt so multiple agents share one stub. */
function branchingProvider(): LLMProvider {
  const counts: Record<string, number> = {};
  return {
    async complete(req) {
      const sys = req.system ?? '';
      counts[sys] = (counts[sys] ?? 0) + 1;
      const n = counts[sys];
      if (sys.includes('WORKER')) return { text: 'worker-done', finishReason: 'stop' };
      if (sys.includes('COORD')) {
        return n === 1
          ? { text: '', finishReason: 'tool_use', toolCalls: [{ id: '1', name: 'worker', arguments: { prompt: 'sub' } }] }
          : { text: 'coord-done', finishReason: 'stop' };
      }
      if (sys.includes('BUILDER')) {
        return n === 1
          ? { text: '', finishReason: 'tool_use', toolCalls: [{ id: '1', name: 'ci', arguments: {} }] }
          : { text: 'built', finishReason: 'stop' };
      }
      return { text: 'noop', finishReason: 'stop' };
    },
  };
}

function runner(
  agents: Record<string, AgentDefinition>,
  flows: Record<string, unknown>,
  tasks: Record<string, unknown> = {},
) {
  const registry = new TaskRegistry().register('echo', EchoTask as never);
  return new FlowRunner({
    tasks: tasks as never,
    flows: flows as never,
    agents,
    registry,
    context: { llm: branchingProvider() },
  });
}

describe('FlowRunner agents', () => {
  it('runs an agent as a flow step', async () => {
    const r = runner(
      { builder: { system: 'BUILDER', tools: [] } as never },
      { main: { steps: { 1: { task: 'builder', options: { prompt: 'go' } } } } },
    );
    const res = await r.run({ flowName: 'main' });
    expect(res.success).toBe(true);
    expect(res.steps[0]?.result?.data?.text).toBe('built');
  });

  it('lets an agent call a flow as a tool', async () => {
    const r = runner(
      { builder: { system: 'BUILDER', tools: [{ flow: 'ci' }] } as never },
      {
        ci: { steps: { 1: { task: 'echo', options: { n: 1 } } } },
        main: { steps: { 1: { task: 'builder', options: { prompt: 'go' } } } },
      },
    );
    const res = await r.run({ flowName: 'main' });
    expect(res.success).toBe(true);
    const data = res.steps[0]?.result?.data as { text: string; toolCalls: Array<{ name: string; ok: boolean; result: string }> };
    expect(data.text).toBe('built');
    expect(data.toolCalls[0]).toMatchObject({ name: 'ci', ok: true });
    expect(data.toolCalls[0]?.result).toContain('echoed');
  });

  it('lets an agent call a sub-agent as a tool', async () => {
    const r = runner(
      {
        coord: { system: 'COORD', tools: [{ agent: 'worker' }] } as never,
        worker: { system: 'WORKER', tools: [] } as never,
      },
      { main: { steps: { 1: { task: 'coord', options: { prompt: 'delegate' } } } } },
    );
    const res = await r.run({ flowName: 'main' });
    expect(res.success).toBe(true);
    const data = res.steps[0]?.result?.data as { text: string; toolCalls: Array<{ name: string; ok: boolean; result: string }> };
    expect(data.text).toBe('coord-done');
    expect(data.toolCalls[0]).toMatchObject({ name: 'worker', ok: true });
    expect(data.toolCalls[0]?.result).toContain('worker-done');
  });
});
