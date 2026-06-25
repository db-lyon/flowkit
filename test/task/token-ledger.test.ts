import { describe, it, expect } from 'vitest';
import {
  createLedger,
  chargeLedger,
  ledgerExhausted,
  exhaustedLimit,
} from '../../src/task/token-ledger.js';

describe('token ledger', () => {
  it('charges and reports exhaustion against a single frame', () => {
    const l = createLedger(100);
    chargeLedger(l, 60);
    expect(ledgerExhausted(l)).toBe(false);
    chargeLedger(l, 40);
    expect(ledgerExhausted(l)).toBe(true);
    expect(exhaustedLimit(l)).toBe(100);
  });

  it('treats limit 0 as unbounded', () => {
    const l = createLedger(0);
    chargeLedger(l, 1_000_000);
    expect(ledgerExhausted(l)).toBe(false);
  });

  it('rolls charges up through parent frames', () => {
    const root = createLedger(1000);
    const child = createLedger(100, root);
    chargeLedger(child, 80);
    expect(root.spent).toBe(80); // child charge rolled up
    expect(ledgerExhausted(child)).toBe(false);
  });

  it('is exhausted when any frame in the chain hits its limit', () => {
    const root = createLedger(50);
    const child = createLedger(1000, root);
    chargeLedger(child, 60); // child fine, root over
    expect(ledgerExhausted(child)).toBe(true);
    expect(exhaustedLimit(child)).toBe(50); // the binding (root) limit
  });
});
