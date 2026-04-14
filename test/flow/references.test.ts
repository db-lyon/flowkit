import { describe, it, expect } from 'vitest';
import { resolveReferences, type ReferenceableStep } from '../../src/flow/references.js';

function step(
  stepNumber: number,
  name: string,
  data: Record<string, unknown>,
): ReferenceableStep {
  return { stepNumber, name, result: { data } };
}

const ctx = (steps: ReferenceableStep[], error?: Parameters<typeof resolveReferences>[1]['error']) => ({
  steps,
  error,
});

describe('resolveReferences — steps namespace', () => {
  it('returns primitives unchanged', () => {
    expect(resolveReferences(42, ctx([]))).toBe(42);
    expect(resolveReferences(true, ctx([]))).toBe(true);
    expect(resolveReferences(null, ctx([]))).toBe(null);
  });

  it('leaves strings with no reference alone', () => {
    expect(resolveReferences('hello world', ctx([]))).toBe('hello world');
  });

  it('resolves a whole-value ref to the raw value (preserves type)', () => {
    const steps = [step(1, 'make', { path: '/Game/X', meta: { count: 3 } })];
    expect(resolveReferences({ target: '${steps.1.path}' }, ctx(steps))).toEqual({
      target: '/Game/X',
    });
    expect(resolveReferences({ target: '${steps.1.meta}' }, ctx(steps))).toEqual({
      target: { count: 3 },
    });
  });

  it('embeds ref values via stringification', () => {
    const steps = [step(1, 'make', { path: '/Game/X', count: 3 })];
    expect(
      resolveReferences({ msg: 'made ${steps.1.path} (n=${steps.1.count})' }, ctx(steps)),
    ).toEqual({ msg: 'made /Game/X (n=3)' });
  });

  it('resolves by step number', () => {
    const steps = [step(1, 'a', { x: 1 }), step(2, 'b', { x: 2 })];
    expect(resolveReferences('${steps.2.x}', ctx(steps))).toBe(2);
  });

  it('resolves by task name', () => {
    const steps = [step(1, 'build', { path: 'out.dll' })];
    expect(resolveReferences('${steps.build.path}', ctx(steps))).toBe('out.dll');
  });

  it('task-name match picks the most recent when repeated', () => {
    const steps = [
      step(1, 'place', { id: 'a' }),
      step(2, 'place', { id: 'b' }),
      step(3, 'place', { id: 'c' }),
    ];
    expect(resolveReferences('${steps.place.id}', ctx(steps))).toBe('c');
  });

  it('matches task names that contain dots (longest prefix wins)', () => {
    const steps = [step(1, 'level.place_actor', { name: 'Pillar' })];
    expect(resolveReferences('${steps.level.place_actor.name}', ctx(steps))).toBe('Pillar');
  });

  it('recurses into arrays and nested objects', () => {
    const steps = [step(1, 'make', { id: 42, tags: ['x', 'y'] })];
    expect(
      resolveReferences(
        { a: ['${steps.1.id}', 'literal'], b: { nested: '${steps.1.tags}' } },
        ctx(steps),
      ),
    ).toEqual({ a: [42, 'literal'], b: { nested: ['x', 'y'] } });
  });

  it('returns undefined for a missing path on a matched step', () => {
    const steps = [step(1, 'make', { path: '/X' })];
    expect(resolveReferences('${steps.1.missing}', ctx(steps))).toBeUndefined();
  });

  it('throws when no step matches the id', () => {
    expect(() => resolveReferences('${steps.nope.x}', ctx([]))).toThrow(
      /Unresolvable step reference/,
    );
  });
});

describe('resolveReferences — error namespace', () => {
  it('resolves ${error.message} and ${error.step} when available', () => {
    const errorInfo = { message: 'kaboom', name: 'Error', step: 'place_actor' };
    expect(resolveReferences('${error.message}', ctx([], errorInfo))).toBe('kaboom');
    expect(resolveReferences('failed at ${error.step}', ctx([], errorInfo))).toBe(
      'failed at place_actor',
    );
  });

  it('throws when ${error.*} is referenced without error context', () => {
    expect(() => resolveReferences('${error.message}', ctx([]))).toThrow(
      /outside on_failure\/finally/,
    );
  });
});
