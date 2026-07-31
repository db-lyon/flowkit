import type { TaskDefinition } from '../config/schema.js';
import { resolveReferences, type ReferenceContext } from '../references.js';

/**
 * A configured task name resolved to the class the registry loads and the
 * options it is instantiated with.
 */
export interface ResolvedTask {
  classPath: string;
  options: Record<string, unknown>;
}

/**
 * Resolve a configured task name to its class path and default options.
 *
 * An option-only entry (no `class_path`) layers options onto a base of the same
 * name; absent a base class_path, it resolves by the task name itself. A name
 * with no definition at all resolves to itself, so a bare class path still
 * works outside — or alongside — a configuration.
 */
export function resolveTaskDefinition(
  taskName: string,
  taskDefinitions?: Record<string, TaskDefinition>,
): ResolvedTask {
  const def = taskDefinitions?.[taskName];
  return {
    classPath: def?.class_path ?? taskName,
    options: def?.options ?? {},
  };
}

/**
 * Resolve a call to a configured task: its class path, plus call-time `options`
 * layered over the task's configured defaults.
 *
 * `references` interpolates `${ns.path}` in the **configured defaults only**.
 * `options` are runtime data — a rollback payload, an agent's tool arguments,
 * values one task computed for another — and are merged in verbatim, so a
 * literal `${steps.x}` in runtime data reaches the task unchanged rather than
 * being interpreted as configuration (or throwing, out of a step's scope).
 * Callers whose call-time options *are* configuration resolve them themselves
 * before calling; see `FlowRunner.runTask`.
 */
export function resolveTaskCall(
  taskName: string,
  taskDefinitions: Record<string, TaskDefinition> | undefined,
  options: Record<string, unknown> = {},
  references?: ReferenceContext,
): ResolvedTask {
  const def = resolveTaskDefinition(taskName, taskDefinitions);
  const defaults = references ? resolveReferences(def.options, references) : def.options;
  return { classPath: def.classPath, options: { ...defaults, ...options } };
}
