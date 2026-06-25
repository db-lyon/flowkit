/**
 * Bounded-concurrency map. Runs `fn` over `items` with at most `limit` calls in
 * flight at once, preserving input order in the result array. This is the one
 * concurrency primitive the agent runtime uses — a single turn's tool calls
 * (including parallel sub-agents) fan out through here, never through ad-hoc
 * `Promise.all`, so the in-flight cap is enforced in exactly one place.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const bound = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };

  const workers = Array.from({ length: Math.min(bound, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
