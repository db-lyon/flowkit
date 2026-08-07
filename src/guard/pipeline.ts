import type { GuardRegistry } from './registry.js';
import type { Guard, GuardContext } from './types.js';

/**
 * Run one host operation through a guard pipeline.
 *
 * Applicability resolves once, up front, so `before` and `after` see the same
 * set of guards even if a guard's own side effects would change what
 * `appliesTo` answers (a source-control guard that checks a file out makes it
 * writable, and must still get its `after` half).
 *
 * `before` runs in registration order and any throw denies the operation:
 * `invoke` never happens and the error propagates unchanged, so the host's own
 * error type survives. `after` runs in reverse order, innermost guard first,
 * so a guard's two halves nest rather than interleave. An `after` hook that
 * returns a value replaces the result for every remaining hook and the caller;
 * returning nothing leaves it alone.
 *
 * With an empty registry this is exactly `invoke()`, so it is always safe to
 * install on a seam before any guard exists.
 */
export async function runGuarded<Ctx extends GuardContext, TResult>(
  ctx: Ctx,
  registry: GuardRegistry<Ctx, TResult>,
  invoke: () => Promise<TResult>,
): Promise<TResult> {
  if (registry.size === 0) return invoke();

  const applicable: Guard<Ctx, TResult>[] = [];
  for (const g of registry.list()) {
    if (!g.appliesTo || (await g.appliesTo(ctx))) applicable.push(g);
  }

  for (const g of applicable) {
    if (g.before) await g.before(ctx);
  }

  // `await` widens a generic TResult to Awaited<TResult>, which an `after`
  // hook's replacement value is not assignable to. The invoke contract already
  // fixes the type, so pin it back.
  let result = (await invoke()) as TResult;

  for (let i = applicable.length - 1; i >= 0; i--) {
    const after = applicable[i].after;
    if (!after) continue;
    const replaced = await after(ctx, result);
    if (replaced !== undefined) result = replaced as TResult;
  }

  return result;
}
