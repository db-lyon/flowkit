import { describe, it, expect } from 'vitest';
import { mapLimit } from '../../src/task/concurrency.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mapLimit', () => {
  it('preserves input order regardless of completion order', async () => {
    const out = await mapLimit([30, 10, 20], 3, async (ms, i) => {
      await tick(ms);
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });

  it('treats a limit below 1 as serial', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapLimit([1, 2, 3], 0, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(2);
      inFlight--;
    });
    expect(peak).toBe(1);
  });
});
