import type { FlowDefinition, TaskDefinition } from '../config/schema.js';
import type { RollbackRecord, TaskResult } from './base-task.js';
import type { FlowStepResult } from '../flow/runner.js';

/**
 * Composite tasks: a task whose children depend on its input (fan out over a
 * list, continue until a cap) runs each child through the runner with
 * `ctx.step`, so every child is recorded, retried, validated and rolled back
 * the way a flow step is. `expand` optionally states the children up front for
 * plans and docs.
 */

/** What a child step runs: a task by configured name (the string form), or a flow. */
export type ChildStepTarget = string | { task: string } | { flow: string };

/** Per-child step behaviour, the same fields a flow step has. Tasks only. */
export interface ChildStepSpec {
  /** Retry the child up to N additional times on failure. */
  retries?: number;
  /** Delay between retries, in milliseconds. */
  retryDelay?: number;
  /** Only retry when the error message contains this substring. */
  retryOn?: string;
}

/**
 * Run one child through the runner. Supplied on `TaskContext.step` by
 * `FlowRunner` for every task it runs (as a step, via `runTask`, as a hook or
 * a rollback). `options` are the child's runtime options: they are layered
 * over the child task's configured defaults verbatim, not interpolated. For a
 * flow child they are the flow's `params`.
 *
 * Never throws: a failed child comes back as a failed `TaskResult`, and the
 * composite decides whether to continue.
 */
export type ChildStepRunner = (
  target: ChildStepTarget,
  options?: Record<string, unknown>,
  spec?: ChildStepSpec,
) => Promise<TaskResult>;

/** One child a composite would run, as `expand` reports it. */
export type ChildPlanEntry =
  | { task: string; options?: Record<string, unknown> }
  | { flow: string; options?: Record<string, unknown> };

/** What `expand` is given besides the task's options. */
export interface ExpandContext {
  /** The configured name the composite runs under. */
  taskName: string;
  taskDefinitions: Record<string, TaskDefinition>;
  flows: Record<string, FlowDefinition>;
  /** The runner's host reference namespaces. */
  references?: Record<string, unknown>;
}

/**
 * Optional static on a task class: the children the task would run for
 * `options`, without running anything. Return `null` when the children depend
 * on runtime results; the plan then shows the composite as opaque.
 */
export type ExpandFunction = (
  options: Record<string, unknown>,
  ctx: ExpandContext,
) => ChildPlanEntry[] | null | Promise<ChildPlanEntry[] | null>;

/**
 * Every rollback record a result carries, its composite children's included,
 * in the order the work happened (children before the parent's own record).
 * Invoke them in reverse. `FlowRunner` harvests this way inside a flow; a host
 * that runs a composite with `runTask` and does its own rollback uses this.
 */
export function collectRollbackRecords(result: TaskResult): RollbackRecord[] {
  const out: RollbackRecord[] = [];
  for (const child of result.children ?? []) out.push(...fromStep(child));
  if (result.rollback) out.push(result.rollback);
  return out;
}

function fromStep(step: FlowStepResult): RollbackRecord[] {
  const out = step.result ? collectRollbackRecords(step.result) : [];
  for (const nested of step.nestedSteps ?? []) out.push(...fromStep(nested));
  return out;
}
