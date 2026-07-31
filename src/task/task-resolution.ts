import type { TaskDefinition } from '../config/schema.js';
import { resolveReferences, type ReferenceContext } from '../flow/references.js';

export interface ResolvedTaskDefinition {
  classPath: string;
  options: Record<string, unknown>;
}

export function resolveTaskDefinition(
  taskName: string,
  taskDefinitions?: Record<string, TaskDefinition>,
): ResolvedTaskDefinition {
  const taskDef = taskDefinitions?.[taskName];
  if (taskDef) {
    return {
      classPath: taskDef.class_path ?? taskName,
      options: taskDef.options ?? {},
    };
  }
  return { classPath: taskName, options: {} };
}

export function resolveTaskOptions(
  taskName: string,
  taskDefinitions: Record<string, TaskDefinition> | undefined,
  options: Record<string, unknown> = {},
  references?: ReferenceContext,
): ResolvedTaskDefinition {
  const taskDef = resolveTaskDefinition(taskName, taskDefinitions);
  const merged = { ...taskDef.options, ...options };
  return {
    classPath: taskDef.classPath,
    options: references ? resolveReferences(merged, references) : merged,
  };
}
