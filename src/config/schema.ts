import { z } from 'zod';

export const TaskOptionsSchema = z.record(z.unknown());

export const TaskDefinitionSchema = z.object({
  class_path: z.string().min(1),
  options: TaskOptionsSchema.optional().default({}),
});

export const FlowStepSchema = z
  .object({
    task: z.string().optional(),
    flow: z.string().optional(),
    options: TaskOptionsSchema.optional(),
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
