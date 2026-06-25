/**
 * LLM provider contract. Flowkit itself has no SDK dependencies — the consumer
 * wires a concrete provider (Anthropic, OpenAI, local, a stub for tests) into
 * the task context under the `llm` key. The provider's only job is to translate
 * this neutral request/response shape to and from its own SDK, which keeps the
 * engine model-agnostic.
 *
 * The contract is intentionally additive: a provider may ignore any field it
 * does not support (`tools`, `schema`, `signal`, …) and a request that only
 * sets `prompt` behaves exactly as it did before tool-calling existed.
 */

export type LLMRole = 'system' | 'user' | 'assistant' | 'tool';

/** A tool invocation the model asked for, surfaced on an assistant turn. */
export interface LLMToolCall {
  /** Provider-assigned id, echoed back on the matching tool-result message. */
  id: string;
  /** Name of the tool the model wants to run. */
  name: string;
  /** Arguments the model produced, already parsed from JSON. */
  arguments: Record<string, unknown>;
}

export interface LLMMessage {
  role: LLMRole;
  /** Text content. Empty string is valid (e.g. an assistant turn that is purely tool calls). */
  content: string;
  /** Present on assistant turns that request tools. */
  toolCalls?: LLMToolCall[];
  /** On a `tool` message: the id of the tool call this result answers. */
  toolCallId?: string;
  /** On a `tool` message: the tool's name (some providers key results by name). */
  name?: string;
}

/** A tool the model is allowed to call, described to the provider. */
export interface LLMToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

/** How the model may use tools on a given turn. */
export type LLMToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface LLMCompletionRequest {
  /** System prompt / instructions. */
  system?: string;
  /**
   * Convenience single user message. When `messages` is set it takes
   * precedence and `prompt` is ignored.
   */
  prompt?: string;
  /** Full conversation. Overrides `prompt` when present. */
  messages?: LLMMessage[];
  /** Model identifier — provider-specific. */
  model?: string;
  /** Max output tokens. */
  maxTokens?: number;
  /** Sampling temperature, when the provider supports it. */
  temperature?: number;
  /** Stop sequences, when the provider supports them. */
  stop?: string[];
  /**
   * Optional JSON Schema. When provided, the provider should attempt to return
   * output that parses against the schema and populate `parsed`. Flowkit
   * validates and repairs structured output on top of this (see llm-runner).
   */
  schema?: Record<string, unknown>;
  /** Tools the model may call this turn. */
  tools?: LLMToolDefinition[];
  /** Constrains tool use this turn. */
  toolChoice?: LLMToolChoice;
  /**
   * Cancellation signal. Flowkit aborts this on timeout; well-behaved providers
   * should pass it to their HTTP client so in-flight calls are cancelled.
   */
  signal?: AbortSignal;
}

export interface LLMCompletionResponse {
  /** Raw text returned by the model. */
  text: string;
  /** When a schema was provided and the output parsed, the structured value. */
  parsed?: unknown;
  /** Tool calls the model requested, if any. */
  toolCalls?: LLMToolCall[];
  /**
   * Why the model stopped: `'stop'` (natural end), `'tool_use'` (wants tools),
   * `'length'` (hit token cap), or any provider-specific string. Absent is
   * treated as a natural stop.
   */
  finishReason?: 'stop' | 'tool_use' | 'length' | (string & {});
  /** Token usage, if the provider reports it. */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** The model that actually served the request, if the provider reports it. */
  model?: string;
}

export interface LLMProvider {
  complete(req: LLMCompletionRequest): Promise<LLMCompletionResponse>;
}

/**
 * A programmatic agent tool: a host-supplied function the model can call.
 * Registered on the task context under `agentTools`, keyed by tool name, for
 * tools that are not flowkit tasks. Receives the model's parsed arguments and
 * returns any JSON-serializable result.
 */
export type LLMToolHandler = (
  args: Record<string, unknown>,
) => unknown | Promise<unknown>;
