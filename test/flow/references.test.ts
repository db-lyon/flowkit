import { describe, it, expect } from 'vitest';
import { resolveReferences, type ReferenceableStep } from '../../src/flow/references.js';

function step(
  stepNumber: number,
  name: string,
  data: Record<string, unknown>,
): ReferenceableStep {
  return { stepNumber, name, result: { data } };
}

describe('resolveReferences', () => {
  it('returns primitives unchanged', () => {
    expect(resolveReferences(42, [])).toBe(42);
    expect(resolveReferences(true, [])).toBe(true);
    expect(resolveReferences(null, [])).toBe(null);
  });

  it('leaves strings with no reference alone', () => {
    expect(resolveReferences('hello world', [])).toBe('hello world');
  });

  it('resolves a whole-value ref to the raw value (preserves type)', () => {
    const steps = [step(1, 'make', { path: '/Game/X', meta: { count: 3 } })];
    const resolved = resolveReferences({ target: '${steps.1.path}' }, steps);
    expect(resolved).toEqual({ target: '/Game/X' });

    const resolvedObj = resolveReferences({ target: '${steps.1.meta}' }, steps);
    expect(resolvedObj).toEqual({ target: { count: 3 } });
  });

  it('embeds ref values via stringification', () => {
    const steps = [step(1, 'make', { path: '/Game/X', count: 3 })];
    const resolved = resolveReferences(
      { msg: 'made ${steps.1.path} (n=${steps.1.count})' },
      steps,
    );
    expect(resolved).toEqual({ msg: 'made /Game/X (n=3)' });
  });

  it('resolves by step number', () => {
    const steps = [step(1, 'a', { x: 1 }), step(2, 'b', { x: 2 })];
    expect(resolveReferences('${steps.2.x}', steps)).toBe(2);
  });

  it('resolves by task name', () => {
    const steps = [step(1, 'build', { path: 'out.dll' })];
    expect(resolveReferences('${steps.build.path}', steps)).toBe('out.dll');
  });

  it('task-name match picks the most recent when repeated', () => {
    const steps = [
      step(1, 'place', { id: 'a' }),
      step(2, 'place', { id: 'b' }),
      step(3, 'place', { id: 'c' }),
    ];
    expect(resolveReferences('${steps.place.id}', steps)).toBe('c');
  });

  it('matches task names that contain dots (longest prefix wins)', () => {
    const steps = [step(1, 'level.place_actor', { name: 'Pillar' })];
    expect(resolveReferences('${steps.level.place_actor.name}', steps)).toBe('Pillar');
  });

  it('recurses into arrays and nested objects', () => {
    const steps = [step(1, 'make', { id: 42, tags: ['x', 'y'] })];
    const resolved = resolveReferences(
      {
        a: ['${steps.1.id}', 'literal'],
        b: { nested: '${steps.1.tags}' },
      },
      steps,
    );
    expect(resolved).toEqual({ a: [42, 'literal'], b: { nested: ['x', 'y'] } });
  });

  it('returns undefined for a missing path on a matched step', () => {
    const steps = [step(1, 'make', { path: '/X' })];
    expect(resolveReferences('${steps.1.missing}', steps)).toBeUndefined();
  });

  it('throws when no step matches the id', () => {
    expect(() => resolveReferences('${steps.nope.x}', [])).toThrow(/Unresolvable step reference/);
  });
});
