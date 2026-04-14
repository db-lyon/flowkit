import { describe, it, expect } from 'vitest';
import { AgentPromptTask } from '../../src/task/agent-prompt-task.js';
import type { LLMProvider } from '../../src/task/llm-provider.js';

function makeTask(opts: Record<string, unknown>, provider?: LLMProvider) {
  return new AgentPromptTask({ llm: provider } as unknown as never, opts as never);
}

describe('AgentPromptTask', () => {
  it('returns text in data when provider responds', async () => {
    const provider: LLMProvider = {
      async complete(req) {
        return { text: `echo: ${req.prompt}` };
      },
    };
    const task = makeTask({ prompt: 'hello' }, provider);
    const result = await task.run();
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ text: 'echo: hello' });
  });

  it('passes through parsed and usage when provider returns them', async () => {
    const provider: LLMProvider = {
      async complete() {
        return {
          text: '{"ok":true}',
          parsed: { ok: true },
          usage: { inputTokens: 12, outputTokens: 3 },
        };
      },
    };
    const task = makeTask({ prompt: 'x', schema: { type: 'object' } }, provider);
    const result = await task.run();
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      text: '{"ok":true}',
      parsed: { ok: true },
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it('fails cleanly when no provider is configured', async () => {
    const task = makeTask({ prompt: 'x' }, undefined);
    const result = await task.run();
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/no LLM provider configured/);
  });

  it('fails validation when prompt is missing', async () => {
    const provider: LLMProvider = { async complete() { return { text: '' }; } };
    const task = makeTask({}, provider);
    const result = await task.run();
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/requires a `prompt`/);
  });
});
