/**
 * LLM provider interface. Flowkit itself has no SDK dependencies — the
 * consumer wires a concrete provider (Anthropic, OpenAI, local, a stub for
 * tests) into the task context under the `llm` key.
 */

export interface LLMCompletionRequest {
  /** System prompt / instructions. */
  system?: string;
  /** User prompt. */
  prompt: string;
  /** Model identifier — provider-specific. */
  model?: string;
  /** Max output tokens. */
  maxTokens?: number;
  /**
   * Optional JSON Schema. When provided, the provider should attempt to
   * return a response that parses against the schema, populating `parsed`
   * in the response.
   */
  schema?: Record<string, unknown>;
}

export interface LLMCompletionResponse {
  /** Raw text returned by the model. */
  text: string;
  /** When a schema was provided and the output parsed, the structured value. */
  parsed?: unknown;
  /** Token usage, if the provider reports it. */
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LLMProvider {
  complete(req: LLMCompletionRequest): Promise<LLMCompletionResponse>;
}
