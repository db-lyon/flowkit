import { describe, it, expect } from 'vitest';
import { deepMerge } from '../../src/config/deep-merge.js';

describe('deepMerge', () => {
  it('merges flat objects', () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('deeply merges nested objects', () => {
    const base = { a: { x: 1, y: 2 }, b: 3 };
    const override = { a: { y: 99, z: 100 } };
    expect(deepMerge(base, override)).toEqual({ a: { x: 1, y: 99, z: 100 }, b: 3 });
  });

  it('merges three levels deep', () => {
    const base = { a: { b: { c: 1, d: 2 }, e: 3 } };
    const override = { a: { b: { c: 99 } } };
    expect(deepMerge(base, override)).toEqual({ a: { b: { c: 99, d: 2 }, e: 3 } });
  });

  it('replaces arrays by default', () => {
    expect(deepMerge({ tags: ['a', 'b'] }, { tags: ['c'] })).toEqual({ tags: ['c'] });
  });

  it('appends arrays with __merge annotation', () => {
    const base = { items: ['a', 'b'] };
    const arr: string[] & { __merge?: string } = ['c', 'd'];
    arr.__merge = 'append';
    expect(deepMerge(base, { items: arr })).toEqual({ items: ['a', 'b', 'c', 'd'] });
  });

  it('returns override when base is undefined', () => {
    expect(deepMerge(undefined, { a: 1 })).toEqual({ a: 1 });
  });

  it('returns base when override is undefined', () => {
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it('returns null when override is null', () => {
    expect(deepMerge({ a: 1 }, null)).toBeNull();
  });

  it('override scalar replaces base scalar', () => {
    expect(deepMerge(42, 99)).toBe(99);
  });

  it('override scalar replaces base object', () => {
    expect(deepMerge({ a: 1 }, 42)).toBe(42);
  });

  it('override object replaces base scalar', () => {
    expect(deepMerge(42, { a: 1 })).toEqual({ a: 1 });
  });

  it('does not mutate base or override', () => {
    const base = { a: { x: 1 } };
    const override = { a: { y: 2 } };
    const baseCopy = JSON.parse(JSON.stringify(base));
    const overrideCopy = JSON.parse(JSON.stringify(override));
    deepMerge(base, override);
    expect(base).toEqual(baseCopy);
    expect(override).toEqual(overrideCopy);
  });
});
