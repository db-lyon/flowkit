/**
 * Guards - a before/after pipeline around an arbitrary host operation.
 *
 * A guard sits on a seam the host already has (an RPC call, a write, a command
 * dispatch) and may veto it, act on it, or observe its result. The pipeline
 * knows nothing about what any guard does: access policy, source control,
 * audit, rate limiting and approval gating are all just guards.
 *
 * Guards are generic over the host's per-call context. Flowkit requires only a
 * `meta` scratch map; everything else (method name, params, connection handles,
 * lazily computed enrichment) belongs to the host's own context type.
 *
 * These are distinct from `FlowRunnerHooks`, which fire around flow steps.
 * A guard wraps one host operation and can deny it; a hook observes a step.
 */

/** The minimum a host context must provide. Extend it with whatever the host needs. */
export interface GuardContext {
  /** Scratch space shared across guards for the life of one operation. */
  readonly meta: Map<string, unknown>;
}

/**
 * A guard on the pipeline. Every hook is optional; a guard with neither
 * `before` nor `after` is inert but still legal (useful while wiring one up).
 */
export interface Guard<Ctx extends GuardContext = GuardContext, TResult = unknown> {
  /** Stable identifier, used for logging and to break ordering ties. */
  readonly name: string;
  /** Lower runs first in `before` and last in `after`. Default 0. */
  readonly order?: number;
  /** Whether this guard participates in a given operation. Default: always. */
  appliesTo?(ctx: Ctx): boolean | Promise<boolean>;
  /** Runs before the operation. Throw to DENY it; side effects are allowed. */
  before?(ctx: Ctx): Promise<void>;
  /** Runs after a successful operation. Return a value to replace the result. */
  after?(ctx: Ctx, result: TResult): Promise<TResult | void>;
}

/** Create the base context fields. Spread the result into the host's own context object. */
export function guardContextBase(): GuardContext {
  return { meta: new Map<string, unknown>() };
}

/**
 * Wrap a pure computation so it runs at most once per operation, caching into
 * the context's `meta` map under `key`.
 *
 * Guard contexts commonly carry enrichment that is expensive to compute and
 * that most guards never look at (which files a call touches, who the caller
 * is). Deferring it means a guard that ignores the enrichment pays nothing,
 * and a pipeline of guards that all consult it pays once.
 */
export function lazy<T>(ctx: GuardContext, key: string, compute: () => T): () => T {
  return () => {
    if (ctx.meta.has(key)) return ctx.meta.get(key) as T;
    const value = compute();
    ctx.meta.set(key, value);
    return value;
  };
}
