import type { Guard, GuardContext } from './types.js';

/**
 * An ordered set of guards.
 *
 * Order is recomputed on every registration rather than at read time, so the
 * sequence a caller observes never depends on when it asked. Ties on `order`
 * break by name, so a registry built from an unordered source (a directory
 * listing, a task registry) still runs its guards deterministically.
 */
export class GuardRegistry<Ctx extends GuardContext = GuardContext, TResult = unknown> {
  private guards: Guard<Ctx, TResult>[] = [];

  register(guard: Guard<Ctx, TResult>): this {
    this.guards.push(guard);
    this.guards.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
    return this;
  }

  /** Register several at once, in whatever order they arrive. */
  registerAll(guards: Iterable<Guard<Ctx, TResult>>): this {
    for (const g of guards) this.register(g);
    return this;
  }

  list(): readonly Guard<Ctx, TResult>[] {
    return this.guards;
  }

  /** Registered guard names, in run order. For startup logging. */
  names(): string[] {
    return this.guards.map((g) => g.name);
  }

  get size(): number {
    return this.guards.length;
  }
}
