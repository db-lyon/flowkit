/**
 * Reference resolution for flow option values.
 *
 * Option values may contain `${<namespace>.<path>}` references:
 *
 *   ${steps.<id>.<path>}  → value from a previously completed step
 *   ${error.<path>}       → error info, only inside on_failure / finally hooks
 *   ${<ns>.<path>}        → value from a host-supplied namespace in `namespaces`
 *                           (e.g. ${project.package.namespace}, ${org.username},
 *                           ${env.HOME}) — the resolver is namespace-extensible,
 *                           symmetric with the pluggable `conditionEvaluator`.
 *
 * For `steps`, `<id>` is a step number ("3") or a task name ("level.place_actor");
 * task names match the most recently completed step with that name, longest-prefix
 * wins. A reference filling the entire string yields the raw value (preserving
 * object/array/number types); embedded references are stringified. A reference to
 * an UNREGISTERED namespace is left untouched (so non-reference `${...}` survives).
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
  /** Host-supplied reference namespaces, e.g. { project, org, env }. */
  namespaces?: Record<string, unknown>;
}

/** Returned by resolveRef when the namespace is unregistered — leave the text literal. */
const LITERAL = Symbol('literal');

const WHOLE_VALUE = /^\$\{(\w+)\.([^}]+)\}$/;
const EMBEDDED = /\$\{(\w+)\.([^}]+)\}/g;

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
  if (whole) {
    const v = resolveRef(whole[1]!, whole[2]!, ctx);
    return v === LITERAL ? str : v;
  }

  if (!str.includes('${')) return str;

  return str.replace(EMBEDDED, (match, ns: string, ref: string) => {
    const v = resolveRef(ns, ref, ctx);
    if (v === LITERAL) return match; // unregistered namespace — leave untouched
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

  if (namespace === 'steps') {
    const segments = ref.split('.');
    for (let i = segments.length; i >= 1; i--) {
      const idCandidate = segments.slice(0, i).join('.');
      const match = findStep(idCandidate, ctx.steps);
      if (match) return getPath(match.result?.data, segments.slice(i));
    }
    throw new Error(
      `Unresolvable step reference: \${steps.${ref}} — no completed step matches "${segments[0]}"`,
    );
  }

  // Host-supplied namespace (project / org / env / ...). Missing path → undefined.
  if (ctx.namespaces && namespace in ctx.namespaces) {
    return getPath(ctx.namespaces[namespace], ref.split('.'));
  }

  // Unregistered namespace — not a reference we own; leave it literal.
  return LITERAL;
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
