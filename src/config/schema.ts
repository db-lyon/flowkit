import { z } from 'zod';

export const TaskOptionsSchema = z.record(z.unknown());

export const TaskDefinitionSchema = z.object({
  class_path: z.string().min(1),
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
  })
  .refine(
    (data) => {
      if (data.task === 'None') return true;
      return (data.task && !data.flow) || (!data.task && data.flow);
    },
    { message: 'Step must have exactly one of task or flow (or task: None to skip)' },
  );

export const FlowDefinitionSchema = z.object({
  description: z.string(),
  steps: z.record(z.coerce.string(), FlowStepSchema),
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
