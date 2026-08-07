/**
 * Task-backed guards: turn registered tasks into pipeline guards by name.
 *
 * A host that already loads tasks from config or from plugins gets guards for
 * free. Declaring a task named `guard.<name>.<phase>` registers it as a guard;
 * no separate activation concept, manifest key, or loader is needed, because
 * the task registry is already the list of everything the host was given.
 *
 * `<phase>` is `before` or `after`, optionally suffixed with a scope the host
 * declared:
 *
 *   guard.audit.after         runs after every operation
 *   guard.p4.beforeWrite      runs before an operation the `write` scope claims
 *
 * A `before` guard denies the operation by returning `success: false` or by
 * throwing. An `after` guard observes the result: it cannot replace it (a task
 * returns a `TaskResult`, not the host's result type) and a failure is reported
 * through `onAfterFailure` rather than failing an operation that already
 * happened.
 */
import type { TaskContext } from '../task/base-task.js';
import type { TaskRegistry } from '../task/registry.js';
import type { Logger } from '../logger.js';
import { noopLogger } from '../logger.js';
import type { Guard, GuardContext } from './types.js';

/** `guard.<name>.<before|after><Scope?>` */
const GUARD_TASK_RE = /^guard\.(.+)\.(before|after)([A-Za-z][A-Za-z0-9]*)?$/;

/** Predicate deciding whether a scoped guard participates in an operation. */
export type GuardScope<Ctx extends GuardContext> = (ctx: Ctx) => boolean | Promise<boolean>;

/** Passed to the host's error factories so it can shape its own message. */
export interface GuardTaskFailure<Ctx extends GuardContext> {
  /** The guard's bare name: `p4` for `guard.p4.beforeWrite`. */
  readonly guard: string;
  /** The full phase as declared: `beforeWrite`. */
  readonly phase: string;
  /** The task name the guard was discovered from. */
  readonly taskName: string;
  readonly ctx: Ctx;
  /** Why it failed: the task's own error, or the exception it threw. */
  readonly reason: string;
  /** Present when the guard task threw rather than returning `success: false`. */
  readonly cause?: Error;
}

export interface DiscoverTaskGuardsOptions<Ctx extends GuardContext, TResult = unknown> {
  /**
   * Named scope predicates. A task named `guard.x.beforeWrite` resolves against
   * the `write` key (the suffix's first letter is lowercased). An unknown scope
   * is an error at discovery time, not a guard that silently runs on
   * everything.
   */
  scopes?: Record<string, GuardScope<Ctx>>;
  /**
   * Build the task context for one guard invocation. Called per operation, so
   * the host can bind the guard to whatever the operation belongs to rather
   * than to a single ambient target.
   */
  contextFor(ctx: Ctx): TaskContext;
  /**
   * Build the options handed to the guard task. `result` is present only for
   * `after` guards.
   */
  optionsFor(ctx: Ctx, result?: TResult): Record<string, unknown>;
  /**
   * Error thrown when a `before` guard denies.
   *
   * This covers a guard task that throws as well as one that returns
   * `success: false`, because `BaseTask.run` turns an exception into a failed
   * result. A guard that crashes therefore denies the operation rather than
   * waving it through, which is the safe direction for the thing standing
   * between a caller and a mutation. Default: a plain `Error`.
   */
  onDeny?(info: GuardTaskFailure<Ctx>): Error;
  /**
   * Error thrown when the guard task cannot be constructed at all: an
   * unresolvable class path, a module that fails to import. Distinct from a
   * denial, because nothing about the operation was actually evaluated.
   * Default: a plain `Error`.
   */
  onError?(info: GuardTaskFailure<Ctx>): Error;
  /** Called when an `after` guard reports failure. Default: log at debug. */
  onAfterFailure?(info: GuardTaskFailure<Ctx>): void;
  logger?: Logger;
}

/** Turn `beforeWrite` into the `write` scope key. */
function scopeKey(suffix: string): string {
  return suffix.charAt(0).toLowerCase() + suffix.slice(1);
}

/**
 * Build a `Guard` for every `guard.<name>.<phase>` task in `registry`.
 *
 * Throws if a task names a scope the host did not declare, so a typo in a
 * plugin's task name surfaces at startup instead of becoming a guard that runs
 * on every operation.
 */
export function discoverTaskGuards<Ctx extends GuardContext, TResult = unknown>(
  registry: TaskRegistry,
  options: DiscoverTaskGuardsOptions<Ctx, TResult>,
): Guard<Ctx, TResult>[] {
  const log = options.logger ?? noopLogger;
  const scopes = options.scopes ?? {};
  const guards: Guard<Ctx, TResult>[] = [];

  for (const taskName of registry.listRegistered()) {
    const match = GUARD_TASK_RE.exec(taskName);
    if (!match) continue;

    const [, name, phase, suffix] = match;
    const fullPhase = `${phase}${suffix ?? ''}`;

    let appliesTo: GuardScope<Ctx> | undefined;
    if (suffix) {
      const key = scopeKey(suffix);
      appliesTo = scopes[key];
      if (!appliesTo) {
        const known = Object.keys(scopes);
        throw new Error(
          `Task '${taskName}' declares guard scope '${key}', which is not registered. ` +
            (known.length ? `Known scopes: ${known.join(', ')}.` : 'No scopes are registered.'),
        );
      }
    }

    const fail = (ctx: Ctx, reason: string, cause?: Error): GuardTaskFailure<Ctx> => ({
      guard: name,
      phase: fullPhase,
      taskName,
      ctx,
      reason,
      cause,
    });

    const runTask = async (ctx: Ctx, result?: TResult) => {
      try {
        // A guard task deliberately runs as ordinary work: `contextFor` returns
        // a host context with no phase, so `registry.create` resolves
        // DEFAULT_EXECUTION_PHASE and the task sees `'task'`. That is a
        // decision, not an oversight — this is the seam where a `'guard'` phase
        // would be introduced.
        //
        // It is not introduced now because the right granularity is unknown: a
        // guard is `before` or `after` and may be scoped (`beforeWrite`), so a
        // single `'guard'` value could be the wrong shape, and `ExecutionPhase`
        // is a closed union whose members cannot be revised cheaply (adding one
        // breaks exhaustive switches and `Record<ExecutionPhase, T>` in
        // consumers). A host needing the distinction today can supply it
        // itself, e.g. `contextFor: (c) => ({ ...ctx, isGuard: true })`, or read
        // the task name, which is always `guard.<name>.<phase>`.
        const task = await registry.create(
          taskName,
          options.contextFor(ctx),
          options.optionsFor(ctx, result),
        );
        return await task.run();
      } catch (e) {
        const cause = e instanceof Error ? e : new Error(String(e));
        const info = fail(ctx, cause.message, cause);
        throw options.onError?.(info) ?? new Error(`guard '${name}' errored: ${cause.message}`);
      }
    };

    const guard: Guard<Ctx, TResult> = { name: `${name}.${fullPhase}`, appliesTo };

    if (phase === 'before') {
      guard.before = async (ctx) => {
        const r = await runTask(ctx);
        if (!r.success) {
          const reason = r.error?.message ?? `denied by guard '${name}'`;
          const info = fail(ctx, reason, r.error);
          throw options.onDeny?.(info) ?? new Error(`blocked by guard '${name}': ${reason}`);
        }
        log.debug(`guard '${name}' allowed the operation`);
      };
    } else {
      guard.after = async (ctx, result) => {
        const r = await runTask(ctx, result);
        if (r.success) return;
        const reason = r.error?.message ?? 'unknown failure';
        const info = fail(ctx, reason, r.error);
        if (options.onAfterFailure) options.onAfterFailure(info);
        else log.debug(`after-guard '${name}' reported failure: ${reason}`);
      };
    }

    guards.push(guard);
  }

  return guards;
}
