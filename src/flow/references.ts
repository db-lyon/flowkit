/**
 * Step reference resolution.
 *
 * Option values may contain `${steps.<id>.<path>}` references that resolve
 * against previously completed steps in the same flow run.
 *
 *   levelPath: "${steps.1.path}"           // whole-value → raw value (preserves type)
 *   message:  "created ${steps.build.id}"  // embedded → stringified
 *
 * `<id>` is a step number ("3") or a task name ("level.place_actor"). Task
 * names match the most recently completed step with that name.
 *
 * When both a task name and a path start with the same prefix (e.g. the task
 * `level.place_actor` and a data field `place_actor`), the longest matching
 * id wins — so step ids beat path fragments.
 */

export interface ReferenceableStep {
  stepNumber: number;
  name: string;
  result?: { data?: unknown };
}

const WHOLE_VALUE = /^\$\{steps\.([^}]+)\}$/;
const EMBEDDED = /\$\{steps\.([^}]+)\}/g;

export function resolveReferences<T>(value: T, steps: ReferenceableStep[]): T {
  if (value == null) return value;
  if (typeof value === 'string') return resolveString(value, steps) as T;
  if (Array.isArray(value)) {
    return value.map((v) => resolveReferences(v, steps)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveReferences(v, steps);
    }
    return out as T;
  }
  return value;
}

function resolveString(str: string, steps: ReferenceableStep[]): unknown {
  const whole = str.match(WHOLE_VALUE);
  if (whole) return resolveRef(whole[1]!, steps);

  // No embedded references — return the string untouched.
  if (!str.includes('${steps.')) return str;

  return str.replace(EMBEDDED, (_match, ref: string) => {
    const v = resolveRef(ref, steps);
    if (v == null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
}

function resolveRef(ref: string, steps: ReferenceableStep[]): unknown {
  const segments = ref.split('.');

  // Try the longest prefix first so task names containing dots
  // (e.g. "level.place_actor") win over single-segment ids.
  for (let i = segments.length; i >= 1; i--) {
    const idCandidate = segments.slice(0, i).join('.');
    const match = findStep(idCandidate, steps);
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
