/**
 * Structured, non-fatal notices a run or a plan reports alongside its verdict.
 *
 * `deprecated`: a task or flow marked `deprecated:` (in config or on the task
 * class) was run or planned. `check`: a declared check with `action: warn`
 * fired. Hosts surface these to the caller; nothing in the runner acts on them.
 */
export interface RunWarning {
  code: 'deprecated' | 'check';
  message: string;
  /** The task or flow the warning is about. */
  name: string;
  kind?: 'task' | 'flow';
  /** For `deprecated`: the declared replacement, when there is one. */
  replacedBy?: string;
  /** For `check`: the step the check belongs to; absent for a flow-level check. */
  stepNumber?: number;
}

/** Deprecation as declared: `true`, or a string saying why or what to do. */
export type Deprecation = boolean | string;

/** Build the warning for a deprecated task or flow, or `undefined` when it is not deprecated. */
export function deprecationWarning(
  kind: 'task' | 'flow',
  name: string,
  deprecated: Deprecation | undefined,
  replacedBy: string | undefined,
): RunWarning | undefined {
  if (!deprecated) return undefined;
  let message = `${kind === 'task' ? 'Task' : 'Flow'} "${name}" is deprecated`;
  if (typeof deprecated === 'string' && deprecated.trim()) message += `: ${deprecated.trim()}`;
  if (replacedBy) message += `${/[.!?]$/.test(message) ? '' : '.'} Use "${replacedBy}" instead.`;
  const w: RunWarning = { code: 'deprecated', kind, name, message };
  if (replacedBy) w.replacedBy = replacedBy;
  return w;
}

/** Concatenate warning lists, dropping repeats of the same notice about the same target. */
export function mergeWarnings(...lists: (RunWarning[] | undefined)[]): RunWarning[] {
  const out: RunWarning[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const w of list ?? []) {
      const key = `${w.code}\u0000${w.kind ?? ''}\u0000${w.name}\u0000${w.stepNumber ?? ''}\u0000${w.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(w);
    }
  }
  return out;
}
