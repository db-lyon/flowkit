interface MergeAnnotated {
  __merge?: 'append' | 'replace';
  [key: string]: unknown;
}

/**
 * Deep-merges two values with CumulusCI-style semantics:
 *
 * - Objects: recursive key-by-key merge (override wins per-key)
 * - Arrays: replace by default; `__merge: 'append'` on the override array concatenates
 * - Scalars: override wins
 * - `null` override: explicitly nullifies
 * - `undefined` override: no-op (base preserved)
 */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (override === null) return null;

  if (Array.isArray(override)) {
    if (Array.isArray(base)) {
      const annotation = (override as unknown as MergeAnnotated).__merge;
      if (annotation === 'append') {
        const cleaned = override.filter(
          (item) => typeof item !== 'object' || !(item as MergeAnnotated).__merge,
        );
        return [...base, ...cleaned];
      }
    }
    return override;
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    const result: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      if (key === '__merge') continue;
      result[key] = deepMerge(result[key], (override as Record<string, unknown>)[key]);
    }
    return result;
  }

  return override;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
