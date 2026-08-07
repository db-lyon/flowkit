import { describe, it, expect, vi } from 'vitest';
import { TaskRegistry, type TaskConstructor } from '../../src/task/registry.js';
import { BaseTask, type TaskResult } from '../../src/task/base-task.js';
import { discoverTaskGuards, type GuardTaskFailure } from '../../src/guard/task-guards.js';
import { GuardRegistry } from '../../src/guard/registry.js';
import { runGuarded } from '../../src/guard/pipeline.js';
import { guardContextBase, lazy, type GuardContext } from '../../src/guard/types.js';

interface Ctx extends GuardContext {
  method: string;
  files(): string[];
}

function makeCtx(method: string, files: string[] = []): Ctx {
  const ctx = { ...guardContextBase(), method } as Ctx;
  ctx.files = lazy(ctx, 'files', () => files);
  return ctx;
}

/** Records every invocation so a test can assert what the guard task was handed. */
const seen: Array<{ task: string; options: Record<string, unknown> }> = [];

function taskReturning(result: TaskResult | (() => never), label: string): TaskConstructor {
  class Stub extends BaseTask {
    get taskName() {
      return label;
    }
    async execute(): Promise<TaskResult> {
      seen.push({ task: label, options: this.options as Record<string, unknown> });
      if (typeof result === 'function') result();
      return result as TaskResult;
    }
  }
  return Stub as unknown as TaskConstructor;
}

const ALLOW = { success: true } as TaskResult;
const DENY = { success: false, error: new Error('checked out by alice') } as TaskResult;

/** Standard wiring: the host supplies context, options and a `write` scope. */
function discover(reg: TaskRegistry, over: Record<string, unknown> = {}) {
  return discoverTaskGuards<Ctx, unknown>(reg, {
    scopes: { write: (c) => c.files().length > 0 },
    contextFor: () => ({}),
    optionsFor: (c, result) => ({
      method: c.method,
      paths: c.files(),
      ...(result !== undefined ? { result } : {}),
    }),
    ...over,
  });
}

describe('discoverTaskGuards', () => {
  it('ignores tasks that do not match the guard naming convention', () => {
    const reg = new TaskRegistry();
    reg.register('deploy', taskReturning(ALLOW, 'deploy'));
    reg.register('guard.malformed', taskReturning(ALLOW, 'malformed'));
    expect(discover(reg)).toHaveLength(0);
  });

  it('discovers a before guard and names it <guard>.<phase>', () => {
    const reg = new TaskRegistry();
    reg.register('guard.p4.before', taskReturning(ALLOW, 'p4'));
    const guards = discover(reg);
    expect(guards).toHaveLength(1);
    expect(guards[0].name).toBe('p4.before');
    expect(guards[0].before).toBeDefined();
    expect(guards[0].after).toBeUndefined();
  });

  it('discovers an after guard with only an after hook', () => {
    const reg = new TaskRegistry();
    reg.register('guard.audit.after', taskReturning(ALLOW, 'audit'));
    const [guard] = discover(reg);
    expect(guard.name).toBe('audit.after');
    expect(guard.after).toBeDefined();
    expect(guard.before).toBeUndefined();
  });

  it('binds a scoped phase to the host predicate', async () => {
    const reg = new TaskRegistry();
    reg.register('guard.p4.beforeWrite', taskReturning(ALLOW, 'p4'));
    const [guard] = discover(reg);

    expect(guard.name).toBe('p4.beforeWrite');
    expect(await guard.appliesTo!(makeCtx('read'))).toBe(false);
    expect(await guard.appliesTo!(makeCtx('save', ['/a.uasset']))).toBe(true);
  });

  it('leaves an unscoped phase applying to everything', () => {
    const reg = new TaskRegistry();
    reg.register('guard.audit.before', taskReturning(ALLOW, 'audit'));
    expect(discover(reg)[0].appliesTo).toBeUndefined();
  });

  it('throws at discovery when a task names an unregistered scope', () => {
    const reg = new TaskRegistry();
    reg.register('guard.x.beforeTypo', taskReturning(ALLOW, 'x'));
    expect(() => discover(reg)).toThrow(/scope 'typo'.*Known scopes: write/s);
  });

  it('reports that no scopes exist when the host registered none', () => {
    const reg = new TaskRegistry();
    reg.register('guard.x.beforeWrite', taskReturning(ALLOW, 'x'));
    expect(() => discover(reg, { scopes: undefined })).toThrow(/No scopes are registered/);
  });

  it('hands the guard task the options the host built', async () => {
    seen.length = 0;
    const reg = new TaskRegistry();
    reg.register('guard.p4.beforeWrite', taskReturning(ALLOW, 'p4'));
    const [guard] = discover(reg);

    await guard.before!(makeCtx('save_asset', ['/a.uasset']));

    expect(seen).toEqual([{ task: 'p4', options: { method: 'save_asset', paths: ['/a.uasset'] } }]);
  });

  it('passes the result to an after guard and not to a before guard', async () => {
    seen.length = 0;
    const reg = new TaskRegistry();
    reg.register('guard.audit.after', taskReturning(ALLOW, 'audit'));
    const [guard] = discover(reg);

    await guard.after!(makeCtx('save_asset'), { saved: true });

    expect(seen[0].options.result).toEqual({ saved: true });
  });

  it('an after guard never replaces the result', async () => {
    const reg = new TaskRegistry();
    reg.register('guard.audit.after', taskReturning(ALLOW, 'audit'));
    const [guard] = discover(reg);
    await expect(guard.after!(makeCtx('save'), 'original')).resolves.toBeUndefined();
  });
});

describe('task guard denial', () => {
  it('throws when a before guard returns success:false', async () => {
    const reg = new TaskRegistry();
    reg.register('guard.p4.beforeWrite', taskReturning(DENY, 'p4'));
    const [guard] = discover(reg);
    await expect(guard.before!(makeCtx('save', ['/a']))).rejects.toThrow(
      "blocked by guard 'p4': checked out by alice",
    );
  });

  it('lets the host shape the denial error', async () => {
    const reg = new TaskRegistry();
    reg.register('guard.p4.beforeWrite', taskReturning(DENY, 'p4'));

    class HostError extends Error {}
    const [guard] = discover(reg, {
      onDeny: (info: { guard: string; phase: string; taskName: string; reason: string; ctx: Ctx }) =>
        new HostError(`${info.guard}/${info.phase} on ${info.ctx.method}: ${info.reason}`),
    });

    await expect(guard.before!(makeCtx('save_asset', ['/a']))).rejects.toThrow(
      new HostError('p4/beforeWrite on save_asset: checked out by alice'),
    );
  });

  it('denies when the guard task throws, rather than waving the operation through', async () => {
    const reg = new TaskRegistry();
    reg.register(
      'guard.p4.before',
      taskReturning(() => {
        throw new Error('p4 daemon unreachable');
      }, 'p4'),
    );
    const onDeny = vi.fn((_info: GuardTaskFailure<Ctx>) => new Error('mapped'));
    const [guard] = discover(reg, { onDeny });

    await expect(guard.before!(makeCtx('save'))).rejects.toThrow('mapped');
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onDeny.mock.calls[0]![0]).toMatchObject({
      guard: 'p4',
      phase: 'before',
      taskName: 'guard.p4.before',
      reason: 'p4 daemon unreachable',
    });
  });

  it('routes an unconstructable guard task to onError, not onDeny', async () => {
    const reg = new TaskRegistry();
    // Registered by name only in the guard scan; resolution falls through to a
    // dynamic import that cannot succeed.
    reg.listRegistered = () => ['guard.ghost.before'];
    const onError = vi.fn(() => new Error('cannot load'));
    const onDeny = vi.fn(() => new Error('denied'));
    const [guard] = discover(reg, { onError, onDeny });

    await expect(guard.before!(makeCtx('save'))).rejects.toThrow('cannot load');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onDeny).not.toHaveBeenCalled();
  });

  it('reports an after guard failure without throwing', async () => {
    const reg = new TaskRegistry();
    reg.register('guard.audit.after', taskReturning(DENY, 'audit'));
    const onAfterFailure = vi.fn();
    const [guard] = discover(reg, { onAfterFailure });

    await expect(guard.after!(makeCtx('save'), 1)).resolves.toBeUndefined();
    expect(onAfterFailure).toHaveBeenCalledTimes(1);
    expect(onAfterFailure.mock.calls[0][0]).toMatchObject({
      guard: 'audit',
      reason: 'checked out by alice',
    });
  });
});

describe('task guards through the pipeline', () => {
  it('a denying before guard stops the operation end to end', async () => {
    const reg = new TaskRegistry();
    reg.register('guard.p4.beforeWrite', taskReturning(DENY, 'p4'));
    const guards = new GuardRegistry<Ctx, unknown>().registerAll(discover(reg));
    const invoke = vi.fn(async () => 'done');

    await expect(runGuarded(makeCtx('save_asset', ['/a']), guards, invoke)).rejects.toThrow(
      /checked out by alice/,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('a write-scoped guard lets a read through untouched', async () => {
    seen.length = 0;
    const reg = new TaskRegistry();
    reg.register('guard.p4.beforeWrite', taskReturning(DENY, 'p4'));
    const guards = new GuardRegistry<Ctx, unknown>().registerAll(discover(reg));

    await expect(runGuarded(makeCtx('read_asset'), guards, async () => 'done')).resolves.toBe('done');
    expect(seen).toHaveLength(0);
  });

  it('allows the operation and then runs the audit guard on the result', async () => {
    seen.length = 0;
    const reg = new TaskRegistry();
    reg.register('guard.p4.beforeWrite', taskReturning(ALLOW, 'p4'));
    reg.register('guard.audit.after', taskReturning(ALLOW, 'audit'));
    const guards = new GuardRegistry<Ctx, unknown>().registerAll(discover(reg));

    const out = await runGuarded(makeCtx('save_asset', ['/a']), guards, async () => 'done');

    expect(out).toBe('done');
    expect(seen.map((s) => s.task)).toEqual(['p4', 'audit']);
    expect(seen[1].options.result).toBe('done');
  });
});
