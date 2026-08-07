import { describe, it, expect, vi } from 'vitest';
import { GuardRegistry } from '../../src/guard/registry.js';
import { runGuarded } from '../../src/guard/pipeline.js';
import { guardContextBase, lazy, type Guard, type GuardContext } from '../../src/guard/types.js';

interface Ctx extends GuardContext {
  method: string;
  files(): string[];
}

function makeCtx(method: string, files: string[] = []): Ctx {
  const base = guardContextBase();
  const ctx = { ...base, method } as Ctx;
  ctx.files = lazy(ctx, 'files', () => files);
  return ctx;
}

function registryOf(...guards: Guard<Ctx, unknown>[]): GuardRegistry<Ctx, unknown> {
  return new GuardRegistry<Ctx, unknown>().registerAll(guards);
}

describe('runGuarded', () => {
  it('is a pass-through when the registry is empty', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const out = await runGuarded(makeCtx('save'), registryOf(), invoke);
    expect(out).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('runs before hooks with the host context', async () => {
    const before = vi.fn(async (_ctx: Ctx) => {});
    const ctx = makeCtx('save', ['/a.uasset']);
    await runGuarded(ctx, registryOf({ name: 'sc', before }), async () => 1);

    expect(before).toHaveBeenCalledTimes(1);
    expect(before.mock.calls[0]![0].method).toBe('save');
    expect(before.mock.calls[0]![0].files()).toEqual(['/a.uasset']);
  });

  it('skips a guard whose appliesTo is false', async () => {
    const before = vi.fn(async () => {});
    const guard: Guard<Ctx> = { name: 'scoped', appliesTo: (c) => c.files().length > 0, before };

    await runGuarded(makeCtx('read'), registryOf(guard), async () => 1);
    expect(before).not.toHaveBeenCalled();

    await runGuarded(makeCtx('save', ['/a']), registryOf(guard), async () => 1);
    expect(before).toHaveBeenCalledTimes(1);
  });

  it('awaits an async appliesTo', async () => {
    const before = vi.fn(async () => {});
    const guard: Guard<Ctx> = { name: 'async', appliesTo: async () => true, before };
    await runGuarded(makeCtx('save'), registryOf(guard), async () => 1);
    expect(before).toHaveBeenCalledTimes(1);
  });

  it('a before throw denies the operation and invoke never runs', async () => {
    const invoke = vi.fn(async () => 1);
    const guard: Guard<Ctx> = {
      name: 'sc',
      before: async () => {
        throw new Error('locked by another user');
      },
    };
    await expect(runGuarded(makeCtx('save'), registryOf(guard), invoke)).rejects.toThrow(
      'locked by another user',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('a denial in an early guard stops later before hooks', async () => {
    const later = vi.fn(async () => {});
    const guards = registryOf(
      { name: 'a', order: 1, before: async () => { throw new Error('no'); } },
      { name: 'b', order: 2, before: later },
    );
    await expect(runGuarded(makeCtx('save'), guards, async () => 1)).rejects.toThrow('no');
    expect(later).not.toHaveBeenCalled();
  });

  it('runs before in order and after in reverse order', async () => {
    const seq: string[] = [];
    const mk = (name: string, order: number): Guard<Ctx> => ({
      name,
      order,
      before: async () => { seq.push(`before:${name}`); },
      after: async () => { seq.push(`after:${name}`); },
    });

    await runGuarded(makeCtx('read'), registryOf(mk('b', 2), mk('a', 1)), async () => 1);
    expect(seq).toEqual(['before:a', 'before:b', 'after:b', 'after:a']);
  });

  it('an after hook can replace the result', async () => {
    const guard: Guard<Ctx, unknown> = {
      name: 'wrap',
      after: async (_c, result) => ({ wrapped: result }),
    };
    const out = await runGuarded(makeCtx('read'), registryOf(guard), async () => ({ original: true }));
    expect(out).toEqual({ wrapped: { original: true } });
  });

  it('an after hook returning nothing leaves the result alone', async () => {
    const guard: Guard<Ctx, unknown> = { name: 'observe', after: async () => {} };
    const out = await runGuarded(makeCtx('read'), registryOf(guard), async () => ({ original: true }));
    expect(out).toEqual({ original: true });
  });

  it('a replaced result is visible to the next after hook', async () => {
    const seen: unknown[] = [];
    const guards = registryOf(
      { name: 'outer', order: 1, after: async (_c, r) => { seen.push(r); } },
      { name: 'inner', order: 2, after: async () => 'replaced' },
    );
    const out = await runGuarded(makeCtx('read'), guards, async () => 'original');
    expect(out).toBe('replaced');
    expect(seen).toEqual(['replaced']);
  });

  it('resolves applicability once, so a before side effect cannot drop its own after', async () => {
    const after = vi.fn(async () => {});
    let checkedOut = false;
    const guard: Guard<Ctx> = {
      name: 'sc',
      // Reads false the moment the guard has done its job.
      appliesTo: () => !checkedOut,
      before: async () => { checkedOut = true; },
      after,
    };
    await runGuarded(makeCtx('save'), registryOf(guard), async () => 1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('shares meta across guards for the life of one operation', async () => {
    const guards = registryOf(
      { name: 'a', order: 1, before: async (c) => { c.meta.set('who', 'alice'); } },
      { name: 'b', order: 2, before: async (c) => { expect(c.meta.get('who')).toBe('alice'); } },
    );
    await runGuarded(makeCtx('save'), guards, async () => 1);
  });
});

describe('lazy', () => {
  it('computes once and caches into meta', () => {
    const ctx = guardContextBase();
    const compute = vi.fn(() => 42);
    const get = lazy(ctx, 'n', compute);
    expect(get()).toBe(42);
    expect(get()).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('does not recompute a falsy cached value', () => {
    const ctx = guardContextBase();
    const compute = vi.fn(() => 0);
    const get = lazy(ctx, 'n', compute);
    get();
    get();
    expect(compute).toHaveBeenCalledTimes(1);
  });
});

describe('GuardRegistry', () => {
  it('orders by order then name', () => {
    const reg = registryOf(
      { name: 'z', order: 1 },
      { name: 'a', order: 2 },
      { name: 'b', order: 1 },
    );
    expect(reg.names()).toEqual(['b', 'z', 'a']);
  });

  it('treats a missing order as 0', () => {
    const reg = registryOf({ name: 'later', order: 5 }, { name: 'default' });
    expect(reg.names()).toEqual(['default', 'later']);
  });

  it('reports its size', () => {
    expect(registryOf().size).toBe(0);
    expect(registryOf({ name: 'a' }).size).toBe(1);
  });
});
