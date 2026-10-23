import type { z } from 'zod';

/**
 * Unknown-key detection for config validated by a zod schema.
 *
 * Zod strips keys an object schema does not declare, so a misspelt field
 * (`retires: 3`, `ignore_failur: true`) parses cleanly and is then ignored at
 * run time. This walks the raw value alongside the schema and reports every key
 * the schema would have dropped, with its full path.
 *
 * It follows the schema the caller passes, so a host that extends
 * `EngineConfigSchema` with its own sections gets them checked too. An object
 * schema declared `.passthrough()` or with a `.catchall()` accepts extra keys
 * and is not reported.
 */

export interface UnknownConfigKey {
  /** Where the key sits, e.g. `flows.ci.steps.2.retires` or `tasks["asset.list"].opts`. */
  path: string;
  /** The unknown key itself. */
  key: string;
  /** The closest declared key, when one is near enough to be a likely typo. */
  suggestion?: string;
}

export interface FindUnknownKeysOptions {
  /**
   * Top-level keys to leave unchecked. For a host that keeps sections in the
   * same file but validates them elsewhere, or not at all. A section the host
   * declares in its own schema does not need listing here.
   */
  passthroughKeys?: readonly string[];
}

/** Thrown by `assertKnownKeys` and by `loadConfig({ strict })`. */
export class UnknownConfigKeyError extends Error {
  readonly keys: UnknownConfigKey[];

  constructor(keys: UnknownConfigKey[]) {
    const lines = keys.map(
      (k) => `  ${k.path}${k.suggestion ? ` (did you mean "${k.suggestion}"?)` : ''}`,
    );
    super(`Unknown config key${keys.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
    this.name = 'UnknownConfigKeyError';
    this.keys = keys;
  }
}

/** Every key in `value` that `schema` does not declare. Never throws. */
export function findUnknownKeys(
  schema: z.ZodTypeAny,
  value: unknown,
  options: FindUnknownKeysOptions = {},
): UnknownConfigKey[] {
  const out: UnknownConfigKey[] = [];
  const skip = new Set(options.passthroughKeys ?? []);
  walk(schema, value, '', out, skip);
  return out;
}

/** Throw `UnknownConfigKeyError` when `value` carries any key `schema` does not declare. */
export function assertKnownKeys(
  schema: z.ZodTypeAny,
  value: unknown,
  options?: FindUnknownKeysOptions,
): void {
  const keys = findUnknownKeys(schema, value, options);
  if (keys.length > 0) throw new UnknownConfigKeyError(keys);
}

// ---------------------------------------------------------------------------

interface AnyDef {
  type?: string;
  [key: string]: unknown;
}

function defOf(schema: z.ZodTypeAny): AnyDef {
  return (schema as unknown as { _zod: { def: AnyDef } })._zod.def;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function joinPath(base: string, key: string): string {
  const simple = /^[A-Za-z_$][\w$-]*$/.test(key) || /^\d+$/.test(key);
  if (!simple) return `${base}[${JSON.stringify(key)}]`;
  return base ? `${base}.${key}` : key;
}

function walk(
  schema: z.ZodTypeAny,
  value: unknown,
  path: string,
  out: UnknownConfigKey[],
  rootSkip: Set<string> | null,
): void {
  if (value === undefined || value === null) return;
  const def = defOf(schema);
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'catch':
    case 'readonly':
      return walk(def.innerType as z.ZodTypeAny, value, path, out, rootSkip);
    case 'pipe':
      return walk(def.in as z.ZodTypeAny, value, path, out, rootSkip);
    case 'lazy':
      return walk((def.getter as () => z.ZodTypeAny)(), value, path, out, rootSkip);
    case 'array':
      if (!Array.isArray(value)) return;
      value.forEach((item, i) => walk(def.element as z.ZodTypeAny, item, `${path}[${i}]`, out, null));
      return;
    case 'record':
      if (!isPlainObject(value)) return;
      for (const [k, v] of Object.entries(value)) {
        walk(def.valueType as z.ZodTypeAny, v, joinPath(path, k), out, null);
      }
      return;
    case 'union':
      return walkUnion(def.options as z.ZodTypeAny[], value, path, out);
    case 'object':
      return walkObject(schema as z.ZodObject, value, path, out, rootSkip);
    default:
      return;
  }
}

function walkObject(
  schema: z.ZodObject,
  value: unknown,
  path: string,
  out: UnknownConfigKey[],
  rootSkip: Set<string> | null,
): void {
  if (!isPlainObject(value)) return;
  const def = defOf(schema);
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  // `.passthrough()` is a catchall of `unknown` and `.strict()` one of `never`.
  const catchall = def.catchall as z.ZodTypeAny | undefined;
  const hasCatchall = !!catchall && defOf(catchall).type !== 'never';

  for (const [k, v] of Object.entries(value)) {
    if (rootSkip?.has(k)) continue;
    if (Object.prototype.hasOwnProperty.call(shape, k)) {
      walk(shape[k]!, v, joinPath(path, k), out, null);
    } else if (hasCatchall) {
      walk(catchall!, v, joinPath(path, k), out, null);
    } else {
      out.push({ path: joinPath(path, k), key: k, suggestion: closest(k, Object.keys(shape)) });
    }
  }
}

/**
 * A union reports against the branch the value actually parses as. When
 * several parse, the one with the fewest unknown keys wins; when none does,
 * zod will report the mismatch itself and there is nothing useful to add.
 */
function walkUnion(
  options: z.ZodTypeAny[],
  value: unknown,
  path: string,
  out: UnknownConfigKey[],
): void {
  let best: UnknownConfigKey[] | null = null;
  for (const option of options) {
    if (!option.safeParse(value).success) continue;
    const found: UnknownConfigKey[] = [];
    walk(option, value, path, found, null);
    if (best === null || found.length < best.length) best = found;
    if (best.length === 0) break;
  }
  if (best) out.push(...best);
}

function closest(key: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = editDistance(key.toLowerCase(), c.toLowerCase());
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  const limit = Math.max(1, Math.floor(key.length / 3));
  return bestDistance <= limit ? best : undefined;
}

/** Edit distance counting an adjacent swap as one edit, the commonest typo. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}
