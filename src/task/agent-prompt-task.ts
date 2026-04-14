import { BaseTask, type TaskResult } from './base-task.js';
import type { LLMProvider } from './llm-provider.js';

export interface AgentPromptOptions {
  prompt: string;
  system?: string;
  model?: string;
  maxTokens?: number;
  schema?: Record<string, unknown>;
}

/**
 * Calls the configured LLM provider and returns its response as the step's
 * data. The provider must be registered on the task context as `ctx.llm`.
 *
 * Output shape:
 *   - `text` — raw model output (always)
 *   - `parsed` — structured value when `schema` was provided and parsing succeeded
 *   - `usage` — token usage if reported
 */
export class AgentPromptTask extends BaseTask<AgentPromptOptions> {
  get taskName() {
    return 'agent_prompt';
  }

  protected validate(): void {
    if (!this.options?.prompt || typeof this.options.prompt !== 'string') {
      throw new Error('agent_prompt requires a `prompt` string option');
    }
  }

  async execute(): Promise<TaskResult> {
    const provider = this.ctx.llm as LLMProvider | undefined;
    if (!provider || typeof provider.complete !== 'function') {
      return {
        success: false,
        error: new Error(
          'agent_prompt: no LLM provider configured. Attach one to ctx.llm before running.',
        ),
      };
    }

    const response = await provider.complete({
      prompt: this.options.prompt,
      system: this.options.system,
      model: this.options.model,
      maxTokens: this.options.maxTokens,
      schema: this.options.schema,
    });

    const data: Record<string, unknown> = { text: response.text };
    if (response.parsed !== undefined) data.parsed = response.parsed;
    if (response.usage) data.usage = response.usage;

    return { success: true, data };
  }
}
