import { describe, it, expect } from 'vitest';
import {
  topologicalSort,
  CircularDependencyError,
  MissingDependencyError,
} from '../../src/dag/resolver.js';
import type { DagNode } from '../../src/dag/resolver.js';

describe('topologicalSort', () => {
  it('returns empty for empty input', () => {
    expect(topologicalSort([])).toEqual([]);
  });

  it('sorts independent nodes', () => {
    const nodes: DagNode[] = [
      { id: 'a', dependencies: [], data: {} },
      { id: 'b', dependencies: [], data: {} },
      { id: 'c', dependencies: [], data: {} },
    ];
    const sorted = topologicalSort(nodes);
    expect(sorted).toHaveLength(3);
    expect(new Set(sorted.map((n) => n.id))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('sorts a linear chain', () => {
    const nodes: DagNode[] = [
      { id: 'c', dependencies: ['b'], data: {} },
      { id: 'a', dependencies: [], data: {} },
      { id: 'b', dependencies: ['a'], data: {} },
    ];
    const ids = topologicalSort(nodes).map((n) => n.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'));
  });

  it('sorts a diamond dependency', () => {
    const nodes: DagNode[] = [
      { id: 'd', dependencies: ['b', 'c'], data: {} },
      { id: 'b', dependencies: ['a'], data: {} },
      { id: 'c', dependencies: ['a'], data: {} },
      { id: 'a', dependencies: [], data: {} },
    ];
    const ids = topologicalSort(nodes).map((n) => n.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('d'));
    expect(ids.indexOf('c')).toBeLessThan(ids.indexOf('d'));
  });

  it('throws CircularDependencyError on cycle', () => {
    const nodes: DagNode[] = [
      { id: 'a', dependencies: ['b'], data: {} },
      { id: 'b', dependencies: ['a'], data: {} },
    ];
    expect(() => topologicalSort(nodes)).toThrow(CircularDependencyError);
  });

  it('throws MissingDependencyError for missing dep', () => {
    const nodes: DagNode[] = [{ id: 'a', dependencies: ['missing'], data: {} }];
    expect(() => topologicalSort(nodes)).toThrow(MissingDependencyError);
  });

  it('includes cycle path in error', () => {
    const nodes: DagNode[] = [
      { id: 'a', dependencies: ['b'], data: {} },
      { id: 'b', dependencies: ['c'], data: {} },
      { id: 'c', dependencies: ['a'], data: {} },
    ];
    try {
      topologicalSort(nodes);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CircularDependencyError);
      expect((err as CircularDependencyError).cycle).toContain('a');
    }
  });

  it('preserves generic data type', () => {
    interface MyData {
      value: number;
    }
    const nodes: DagNode<MyData>[] = [
      { id: 'a', dependencies: [], data: { value: 1 } },
      { id: 'b', dependencies: ['a'], data: { value: 2 } },
    ];
    const sorted = topologicalSort(nodes);
    expect(sorted[0].data.value).toBe(1);
    expect(sorted[1].data.value).toBe(2);
  });
});
