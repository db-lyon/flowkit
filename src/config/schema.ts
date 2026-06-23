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

/** Minimal config shape the engine requires. Consumers extend with their own sections. */
export const EngineConfigSchema = z.object({
  tasks: z.record(TaskDefinitionSchema).default({}),
  flows: z.record(FlowDefinitionSchema).default({}),
});

export type TaskOptions = z.infer<typeof TaskOptionsSchema>;
export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>;
export type FlowStep = z.infer<typeof FlowStepSchema>;
export type FlowDefinition = z.infer<typeof FlowDefinitionSchema>;
export type EngineConfig = z.infer<typeof EngineConfigSchema>;
