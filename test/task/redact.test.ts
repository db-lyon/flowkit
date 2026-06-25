import { describe, it, expect } from 'vitest';
import { redact, truncate, preview } from '../../src/task/redact.js';

describe('redact', () => {
  it('masks secret-like keys at any depth', () => {
    const out = redact({
      apiKey: 'sk-123',
      nested: { authorization: 'Bearer x', safe: 'keep' },
      token_list: ['a'],
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).authorization).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).safe).toBe('keep');
  });

  it('leaves non-secret values intact', () => {
    expect(redact({ model: 'opus', count: 3, flag: true })).toEqual({ model: 'opus', count: 3, flag: true });
  });

  it('truncates long strings', () => {
    const out = redact({ note: 'x'.repeat(600) }, 10) as Record<string, string>;
    expect(out.note).toMatch(/^x{10}… \(\+590 more chars\)$/);
  });

  it('collapses cycles without throwing', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => redact(a)).not.toThrow();
    expect((redact(a) as Record<string, unknown>).self).toBe('[circular]');
  });
});

describe('truncate / preview', () => {
  it('truncate is a no-op under the limit', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('preview collapses whitespace and truncates', () => {
    expect(preview('a\n\n  b   c', 100)).toBe('a b c');
    expect(preview('word '.repeat(100), 10)).toMatch(/… \(\+\d+ more chars\)$/);
  });
});
