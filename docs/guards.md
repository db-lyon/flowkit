# Guards

A guard is a `before`/`after` pipeline around one host operation. It sits on a seam the host already has (an RPC call, a write, a command dispatch) and may veto that operation, act on it, or observe its result.

The pipeline knows nothing about what any guard does. Access policy, source control checkout, audit logging, rate limiting and approval gating are all just guards.

Guards are distinct from [`FlowRunnerHooks`](api-reference.md#flow), which fire around flow steps. A hook observes a step; a guard wraps one host operation and can deny it.

```ts
import { GuardRegistry, runGuarded, guardContextBase, lazy } from '@db-lyon/flowkit/guard';
```

## The context

Flowkit requires only a scratch map. Everything else belongs to the host.

```ts
interface GuardContext {
  readonly meta: Map<string, unknown>;
}
```

Extend it with whatever your operation carries, and build it with `guardContextBase()`:

```ts
interface CallContext extends GuardContext {
  readonly method: string;
  readonly params: Record<string, unknown>;
  /** Files this call will modify. Computed on demand. */
  files(): string[];
}

function makeCallContext(method: string, params: Record<string, unknown>): CallContext {
  const ctx = { ...guardContextBase(), method, params } as CallContext;
  ctx.files = lazy(ctx, 'files', () => classify(method, params));
  return ctx;
}
```

`lazy(ctx, key, compute)` caches into `meta`, so enrichment that is expensive to compute and that most guards never consult costs nothing when it is ignored and is computed once when several guards want it.

`meta` is also how guards talk to each other. A `before` hook can stash what it did and the matching `after` hook, or a later guard, can read it back.

## Writing a guard

```ts
interface Guard<Ctx extends GuardContext, TResult> {
  readonly name: string;
  readonly order?: number;
  appliesTo?(ctx: Ctx): boolean | Promise<boolean>;
  before?(ctx: Ctx): Promise<void>;
  after?(ctx: Ctx, result: TResult): Promise<TResult | void>;
}
```

- **`before`** runs before the operation. Throw to deny it: the operation never happens and your error propagates unchanged, so the host's own error type survives.
- **`after`** runs after a successful operation. Return a value to replace the result; return nothing to leave it alone.
- **`appliesTo`** decides whether the guard participates at all. Default is always.
- **`order`** sorts the chain, lower first. Ties break by name, so a registry built from an unordered source still runs deterministically.

```ts
const sourceControl: Guard<CallContext, unknown> = {
  name: 'source-control',
  order: 10,
  appliesTo: (ctx) => ctx.files().length > 0,
  before: async (ctx) => {
    const denied = await checkout(ctx.files());
    if (denied.length) throw new Error(`locked by another user: ${denied.join(', ')}`);
  },
};
```

## Running the pipeline

```ts
const guards = new GuardRegistry<CallContext, Result>().registerAll([sourceControl, audit]);

async function call(method: string, params: Record<string, unknown>): Promise<Result> {
  return runGuarded(makeCallContext(method, params), guards, () => transport.send(method, params));
}
```

`before` hooks run in registration order, then `invoke`, then `after` hooks in reverse order, so a guard's two halves nest rather than interleave.

Applicability resolves once, up front. A guard whose `before` changes the answer to its own `appliesTo` (a source-control guard that checks a file out, making it writable) still gets its `after` half.

With an empty registry `runGuarded` is exactly `invoke()`, so it is safe to install on a seam before any guard exists.

## Guards from tasks

A host that already loads tasks from config or from plugins gets guards for free. Name a task `guard.<name>.<phase>` and `discoverTaskGuards` turns it into a guard. No separate activation concept is needed, because the task registry is already the list of everything the host was given.

```yaml
tasks:
  guard.p4.beforeWrite:
    class_path: ./guards/perforce.js
  guard.audit.after:
    class_path: ./guards/audit.js
```

`<phase>` is `before` or `after`, optionally suffixed with a scope the host declared:

| Task name | Runs |
| --- | --- |
| `guard.audit.before` | before every operation |
| `guard.audit.after` | after every successful operation |
| `guard.p4.beforeWrite` | before an operation the `write` scope claims |

```ts
const guards = discoverTaskGuards<CallContext, Result>(taskRegistry, {
  scopes: { write: (ctx) => ctx.files().length > 0 },
  contextFor: (ctx) => ({ logger, registry: taskRegistry, transport: ctx.transport }),
  optionsFor: (ctx, result) => ({
    method: ctx.method,
    params: ctx.params,
    paths: ctx.files(),
    ...(result !== undefined ? { result } : {}),
  }),
  onDeny: (info) => new PolicyError(`blocked (${info.ctx.method}): ${info.reason}`),
});
```

`contextFor` is called per operation, so a guard can be bound to whatever the operation belongs to rather than to a single ambient target. A host driving several connections should hand each guard the one serving the call it is guarding.

A scope named by a task but not registered by the host is an error at discovery time. A typo in a plugin's task name surfaces at startup rather than becoming a guard that silently runs on everything.

### Denial and failure

A `before` guard denies by returning `success: false` or by throwing. Both route to `onDeny`, because `BaseTask.run` turns an exception into a failed result: a guard that crashes denies the operation rather than waving it through, which is the safe direction for the thing standing between a caller and a mutation.

`onError` is separate and narrower. It fires only when the guard task cannot be constructed at all, an unresolvable class path or a module that fails to import, where nothing about the operation was evaluated.

An `after` guard observes the result and cannot replace it, since a task returns a `TaskResult` rather than the host's result type. A failure is reported through `onAfterFailure` instead of failing an operation that already happened. Reach for a hand-written `Guard` when you need an `after` hook that transforms the result.
