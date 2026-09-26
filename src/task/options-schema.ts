import type { OptionSpec, OptionSpecs, OutputSpecs } from '../config/schema.js';
import { validateJson } from './json-schema.js';

/**
 * Metadata a task class may declare statically, the way a CumulusCI task
 * declares `task_options` on the class. A task definition in config refines it.
 *
 * ```ts
 * class Deploy extends BaseTask<DeployOptions> {
 *   static optionsSchema = {
 *     environment: { type: 'string', enum: ['staging', 'prod'], required: true },
 *   } satisfies OptionSpecs;
 * }
 * ```
 */
export interface TaskClassMetadata {
  description?: string;
  optionsSchema?: OptionSpecs;
  outputs?: OutputSpecs;
  deprecated?: boolean | string;
  replacedBy?: string;
}

/** Read a task class's static metadata. Tolerates any value. */
export function taskClassMetadata(ctor: unknown): TaskClassMetadata {
  if (typeof ctor !== 'function') return {};
  const c = ctor as unknown as Record<string, unknown>;
  const out: TaskClassMetadata = {};
  if (typeof c.description === 'string') out.description = c.description;
  if (isRecord(c.optionsSchema)) out.optionsSchema = c.optionsSchema as OptionSpecs;
  if (isRecord(c.outputs)) out.outputs = c.outputs as OutputSpecs;
  if (typeof c.deprecated === 'boolean' || typeof c.deprecated === 'string') out.deprecated = c.deprecated;
  if (typeof c.replacedBy === 'string') out.replacedBy = c.replacedBy;
  return out;
}

/**
 * Layer a definition's option specs over a class's, option by option and field
 * by field: a definition can tighten one constraint, change a default or add an
 * option without restating the rest.
 */
export function mergeOptionSpecs(
  base: OptionSpecs | undefined,
  override: OptionSpecs | undefined,
): OptionSpecs | undefined {
  if (!base) return override;
  if (!override) return base;
  const out: OptionSpecs = { ...base };
  for (const [name, spec] of Object.entries(override)) {
    out[name] = { ...(base[name] ?? {}), ...spec };
  }
  return out;
}

/** Fill every option the schema gives a `default` for and `options` leaves undefined. */
export function applyOptionDefaults(
  specs: OptionSpecs | undefined,
  options: Record<string, unknown>,
): Record<string, unknown> {
  if (!specs) return options;
  let out = options;
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.default !== undefined && out[name] === undefined) {
      if (out === options) out = { ...options };
      out[name] = spec.default;
    }
  }
  return out;
}

export interface TaskOptionIssue {
  option: string;
  message: string;
}

/** A step's options failed the task's declared `options_schema`. */
export class TaskOptionsError extends Error {
  readonly taskName: string;
  readonly issues: TaskOptionIssue[];

  constructor(taskName: string, issues: TaskOptionIssue[]) {
    const detail = issues.map((i) => `option "${i.option}" ${i.message}`).join('; ');
    super(`Task "${taskName}": ${detail}`);
    this.name = 'TaskOptionsError';
    this.taskName = taskName;
    this.issues = issues;
  }
}

/**
 * Check `options` against declared specs. Undeclared options are allowed:
 * the schema describes what a task reads, not everything a host may pass.
 */
export function validateTaskOptions(
  specs: OptionSpecs | undefined,
  options: Record<string, unknown>,
): TaskOptionIssue[] {
  if (!specs) return [];
  const issues: TaskOptionIssue[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    const value = options[name];
    if (value === undefined) {
      if (spec.required) issues.push({ option: name, message: 'is required' });
      continue;
    }
    const result = validateJson(value, toJsonSchema(spec));
    for (const e of result.errors) {
      issues.push({ option: e.path ? `${name}${e.path.replace(/\//g, '.')}` : name, message: e.message });
    }
  }
  return issues;
}

/**
 * Validate and throw. Returns `options` with schema defaults applied, so a
 * caller can use the result directly.
 */
export function assertTaskOptions(
  taskName: string,
  specs: OptionSpecs | undefined,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const withDefaults = applyOptionDefaults(specs, options);
  const issues = validateTaskOptions(specs, withDefaults);
  if (issues.length > 0) throw new TaskOptionsError(taskName, issues);
  return withDefaults;
}

function toJsonSchema(spec: OptionSpec): Record<string, unknown> {
  const { description: _d, required: _r, default: _def, ...rest } = spec;
  return rest as Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
