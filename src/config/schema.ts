import { z } from 'zod';

export const TaskOptionsSchema = z.record(z.unknown());

export const TaskDefinitionSchema = z.object({
  /**
   * The task's implementation. Optional: an option-only entry (no class_path)
   * is a valid override that layers `options` onto a same-named base definition
   * (e.g. a universal task or a config merged on top). When no base supplies a
   * class_path, the runner falls back to the task name.
   */
  class_path: z.string().min(1).optional(),
  description: z.string().optional(),
  group: z.string().optional(),
  options: TaskOptionsSchema.optional().default({}),
  /** Declarative hints surfaced in listings; not used by the runner. */
  idempotent: z.boolean().optional(),
  reversible: z.boolean().optional(),
});

export const FlowStepSchema = z
  .object({
    task: z.string().optional(),
    flow: z.string().optional(),
    options: TaskOptionsSchema.optional(),
    /** Retry the step up to N additional times on failure. */
    retries: z.number().int().nonnegative().optional(),
    /** Delay between retries, in milliseconds. */
    retryDelay: z.number().int().nonnegative().optional(),
    /** Only retry when the error message contains this substring. */
    retryOn: z.string().optional(),
    /**
     * Conditional execution. A boolean runs/skips the step directly; a string is
     * an expression evaluated at runtime by the runner's `conditionEvaluator`
     * (or the built-in `${...}`-reference truthiness check if none is set). A
     * falsy result skips the step without failing the flow.
     */
    when: z.union([z.string(), z.boolean()]).optional(),
    /** If true, a failure of this step is recorded but does not abort the flow. */
    ignore_failure: z.boolean().optional(),
  })
  .refine(
    (data) => {
      if (data.task === 'None') return true;
      return (data.task && !data.flow) || (!data.task && data.flow);
    },
    { message: 'Step must have exactly one of task or flow (or task: None to skip)' },
  );

export const FlowDefinitionSchema = z.object({
  /**
   * Optional: a flow override (one that layers steps/hooks onto a same-named
   * base) need not restate the description. Tolerates an explicit null.
   */
  description: z.string().nullish(),
  /** Optional/defaulted so an override that only adjusts hooks/options is valid. */
  steps: z.record(z.coerce.string(), FlowStepSchema).default({}),
  /** Runs before the first step. Failure fails the flow before steps execute. */
  on_start: z.array(FlowStepSchema).optional(),
  /** Runs after all steps succeed. */
  on_success: z.array(FlowStepSchema).optional(),
  /** Runs on any step failure. */
  on_failure: z.array(FlowStepSchema).optional(),
  /** Runs after success or failure, after on_success/on_failure. */
  finally: z.array(FlowStepSchema).optional(),
  /** If true, invoke rollback records from completed steps in reverse order on failure. */
  rollback_on_failure: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Agents — the AI-native layer. Additive: CumulusCI never had an `agents:` key,
// so adding one leaves `tasks:`/`flows:` byte-identical to a cumulusci.yml.
// ---------------------------------------------------------------------------

/**
 * A tool an agent may call. References an existing flowkit primitive — a `task`,
 * a `flow`, or another `agent` — so tool dispatch reuses the registry, options,
 * and `${...}` reference machinery rather than inventing a parallel concept.
 * `name` (defaulted from the reference) is what the model sees.
 */
export const AgentToolSchema = z
  .object({
    name: z.string().optional(),
    task: z.string().optional(),
    flow: z.string().optional(),
    agent: z.string().optional(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
  })
  .refine((t) => !!(t.task || t.flow || t.agent || t.name), {
    message: 'agent tool must reference a task, flow, or agent, or declare a name',
  });

/**
 * Hard bounds on an agent run. A tool-using agent with no caps is unbounded
 * spend, so a budget is the intended companion to every agent definition.
 */
export const AgentBudgetSchema = z.object({
  /** Max model turns. */
  maxIterations: z.number().int().positive().optional(),
  /** Aggregate input+output token cap across the whole loop (incl. sub-agents). */
  tokenBudget: z.number().int().positive().optional(),
  /** Cap on a single tool result's serialized size, in chars. */
  maxToolResultChars: z.number().int().positive().optional(),
  /** Cap on a sub-agent result's serialized size, in chars (0 = unbounded). */
  maxAgentResultChars: z.number().int().nonnegative().optional(),
  /** Max tool calls run concurrently within a turn. */
  maxConcurrency: z.number().int().positive().optional(),
  /** Max depth of agent-calls-agent recursion. */
  maxAgentDepth: z.number().int().positive().optional(),
});

export const AgentDefinitionSchema = z.object({
  description: z.string().optional(),
  /** Model identifier — provider-specific. */
  model: z.string().optional(),
  /** System prompt / rules. */
  system: z.string().optional(),
  /** Tools the agent may call (its allowlist). */
  tools: z.array(AgentToolSchema).default([]),
  /** JSON Schema for the agent's final answer. */
  schema: z.record(z.unknown()).optional(),
  /** Hard run bounds. */
  budget: AgentBudgetSchema.optional(),
  /** Sampling temperature. */
  temperature: z.number().optional(),
  /** Per-call max output tokens. */
  maxTokens: z.number().int().positive().optional(),
  /** Per-call timeout in ms. */
  timeout: z.number().int().nonnegative().optional(),
  /** Transport retries per call. */
  retries: z.number().int().nonnegative().optional(),
});

/** Minimal config shape the engine requires. Consumers extend with their own sections. */
export const EngineConfigSchema = z.object({
  tasks: z.record(TaskDefinitionSchema).default({}),
  flows: z.record(FlowDefinitionSchema).default({}),
  agents: z.record(AgentDefinitionSchema).default({}),
});

export type TaskOptions = z.infer<typeof TaskOptionsSchema>;
export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>;
export type FlowStep = z.infer<typeof FlowStepSchema>;
export type FlowDefinition = z.infer<typeof FlowDefinitionSchema>;
export type AgentTool = z.infer<typeof AgentToolSchema>;
export type AgentBudget = z.infer<typeof AgentBudgetSchema>;
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
export type EngineConfig = z.infer<typeof EngineConfigSchema>;
