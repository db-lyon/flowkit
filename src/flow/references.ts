/**
 * Reference resolution for flow option values.
 *
 * Option values may contain two reference namespaces, delimited by `${...}`:
 *
 *   ${steps.<id>.<path>}  → value from a previously completed step
 *   ${error.<path>}       → error info, only inside on_failure / finally hooks
 *
 * `<id>` is a step number ("3") or a task name ("level.place_actor"). Task
 * names match the most recently completed step with that name. Longest-prefix
 * match wins when a task name shares a prefix with a path segment.
 *
 * A reference that fills the entire string is replaced with the raw value
 * (preserving object/array/number types). Embedded references are stringified.
 */

export interface ReferenceableStep {
  stepNumber: number;
  name: string;
  result?: { data?: unknown };
}

export interface ReferenceContext {
  steps: ReferenceableStep[];
  /** Present inside on_failure / finally hooks. */
  error?: { message: string; name: string; stack?: string; step?: string };
}

const WHOLE_VALUE = /^\$\{(steps|error)\.([^}]+)\}$/;
const EMBEDDED = /\$\{(steps|error)\.([^}]+)\}/g;

export function resolveReferences<T>(value: T, ctx: ReferenceContext): T {
  if (value == null) return value;
  if (typeof value === 'string') return resolveString(value, ctx) as T;
  if (Array.isArray(value)) {
    return value.map((v) => resolveReferences(v, ctx)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveReferences(v, ctx);
    }
    return out as T;
  }
  return value;
}

function resolveString(str: string, ctx: ReferenceContext): unknown {
  const whole = str.match(WHOLE_VALUE);
  if (whole) return resolveRef(whole[1]!, whole[2]!, ctx);

  if (!str.includes('${')) return str;

  return str.replace(EMBEDDED, (_match, ns: string, ref: string) => {
    const v = resolveRef(ns, ref, ctx);
    if (v == null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
}

function resolveRef(namespace: string, ref: string, ctx: ReferenceContext): unknown {
  if (namespace === 'error') {
    if (!ctx.error) {
      throw new Error(
        `\${error.${ref}} referenced outside on_failure/finally — error context not available`,
      );
    }
    return getPath(ctx.error, ref.split('.'));
  }

  // steps namespace
  const segments = ref.split('.');
  for (let i = segments.length; i >= 1; i--) {
    const idCandidate = segments.slice(0, i).join('.');
    const match = findStep(idCandidate, ctx.steps);
    if (match) {
      return getPath(match.result?.data, segments.slice(i));
    }
  }

  throw new Error(
    `Unresolvable step reference: \${steps.${ref}} — no completed step matches "${segments[0]}"`,
  );
}

function findStep(id: string, steps: ReferenceableStep[]): ReferenceableStep | undefined {
  if (/^\d+$/.test(id)) {
    return steps.find((s) => String(s.stepNumber) === id);
  }
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]!.name === id) return steps[i];
  }
  return undefined;
}

function getPath(obj: unknown, segments: string[]): unknown {
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
