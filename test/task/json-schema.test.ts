import { describe, it, expect } from 'vitest';
import { validateJson, formatErrors } from '../../src/task/json-schema.js';

describe('validateJson', () => {
  it('accepts a valid object against type/required/properties', () => {
    const schema = {
      type: 'object',
      required: ['name', 'age'],
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
    };
    expect(validateJson({ name: 'a', age: 3 }, schema).valid).toBe(true);
  });

  it('flags missing required keys with a path', () => {
    const schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
    const result = validateJson({}, schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.path).toBe('/name');
    expect(result.errors[0]?.message).toMatch(/required/);
  });

  it('distinguishes integer from number', () => {
    const schema = { type: 'integer' };
    expect(validateJson(3, schema).valid).toBe(true);
    expect(validateJson(3.5, schema).valid).toBe(false);
  });

  it('validates nested arrays of objects', () => {
    const schema = {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'number' } } } },
      },
    };
    expect(validateJson({ items: [{ id: 1 }, { id: 2 }] }, schema).valid).toBe(true);
    const bad = validateJson({ items: [{ id: 1 }, {}] }, schema);
    expect(bad.valid).toBe(false);
    expect(bad.errors[0]?.path).toBe('/items/1/id');
  });

  it('enforces enum and const', () => {
    expect(validateJson('b', { enum: ['a', 'b'] }).valid).toBe(true);
    expect(validateJson('c', { enum: ['a', 'b'] }).valid).toBe(false);
    expect(validateJson(5, { const: 5 }).valid).toBe(true);
    expect(validateJson(6, { const: 5 }).valid).toBe(false);
  });

  it('supports nullable and array-typed type tokens', () => {
    expect(validateJson(null, { type: 'string', nullable: true }).valid).toBe(true);
    expect(validateJson(null, { type: 'string' }).valid).toBe(false);
    expect(validateJson(null, { type: ['string', 'null'] }).valid).toBe(true);
  });

  it('enforces additionalProperties: false', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    expect(validateJson({ a: 'x' }, schema).valid).toBe(true);
    const bad = validateJson({ a: 'x', b: 1 }, schema);
    expect(bad.valid).toBe(false);
    expect(bad.errors[0]?.path).toBe('/b');
  });

  it('enforces string and number bounds', () => {
    expect(validateJson('ab', { type: 'string', minLength: 3 }).valid).toBe(false);
    expect(validateJson(10, { type: 'number', maximum: 5 }).valid).toBe(false);
    expect(validateJson(4, { type: 'number', exclusiveMaximum: 4 }).valid).toBe(false);
  });

  it('handles anyOf / oneOf / not', () => {
    expect(validateJson(5, { anyOf: [{ type: 'string' }, { type: 'number' }] }).valid).toBe(true);
    expect(validateJson(true, { anyOf: [{ type: 'string' }, { type: 'number' }] }).valid).toBe(false);
    expect(validateJson(5, { oneOf: [{ type: 'number' }, { const: 5 }] }).valid).toBe(false); // matches both
    expect(validateJson('x', { not: { type: 'number' } }).valid).toBe(true);
  });

  it('formats errors into a single readable string', () => {
    const result = validateJson({}, { type: 'object', required: ['a', 'b'] });
    expect(formatErrors(result.errors)).toMatch(/\/a: is required; \/b: is required/);
  });

  it('never throws on a malformed schema', () => {
    expect(() => validateJson({ x: 1 }, { type: 'object', properties: null as never })).not.toThrow();
  });
});
