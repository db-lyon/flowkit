import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  type BaseTask,
  extendsBaseTask,
  resolveTaskContext,
  type TaskContext,
  type TaskContextInput,
} from './base-task.js';
import type { TaskDefinition, OptionSpecs, OutputSpecs } from '../config/schema.js';
import { resolveTaskDefinition } from './task-resolution.js';
import { applyOptionDefaults, mergeOptionSpecs, taskClassMetadata } from './options-schema.js';

export type TaskConstructor = new (
  ctx: TaskContext,
  options: Record<string, unknown>,
) => BaseTask;

/**
 * Everything known about one task, for a host's `describe`, `list` or docs.
 * Field names follow the YAML keys so a description can be printed as config.
 */
export interface TaskDescription {
  /** The name asked about: a configured task name, a registered name or a class path. */
  name: string;
  /** What the name resolves to in the registry. */
  class_path: string;
  /** The definition's description, else the class's static `description`. */
  description?: string;
  group?: string;
  /**
   * Default options a run starts from: schema defaults, then the definition's
   * `options`. Uninterpolated, so `${...}` references show as written.
   */
  options: Record<string, unknown>;
  /** The class's static `optionsSchema` refined by the definition's `options_schema`. */
  options_schema?: OptionSpecs;
  /** The class's static `outputs` refined by the definition's `outputs`. */
  outputs?: OutputSpecs;
  idempotent?: boolean;
  reversible?: boolean;
  /** The definition's `deprecated`, else the class's static one. */
  deprecated?: boolean | string;
  /** The definition's `replaced_by`, else the class's static `replacedBy`. */
  replaced_by?: string;
}

export class TaskRegistry {
  private classPathMap = new Map<string, TaskConstructor>();
  private nameMap = new Map<string, TaskConstructor>();
  private dynamicCache = new Map<string, TaskConstructor>();

  /** Register a task by short name (e.g. `'deploy'`). */
  register(name: string, ctor: TaskConstructor): this {
    this.nameMap.set(name, ctor);
    return this;
  }

  /** Register a task by class path (e.g. `'my.tasks.Deploy'`). */
  registerClassPath(classPath: string, ctor: TaskConstructor): this {
    this.classPathMap.set(classPath, ctor);
    return this;
  }

  /** Bulk-register by short name. */
  registerAll(entries: Record<string, TaskConstructor>): this {
    for (const [name, ctor] of Object.entries(entries)) {
      this.nameMap.set(name, ctor);
    }
    return this;
  }

  /** Bulk-register by class path. */
  registerClassPaths(entries: Record<string, TaskConstructor>): this {
    for (const [classPath, ctor] of Object.entries(entries)) {
      this.classPathMap.set(classPath, ctor);
    }
    return this;
  }

  /**
   * Resolve a task constructor by name or class path.
   * Falls back to dynamic import from the filesystem.
   */
  async resolve(classPathOrName: string): Promise<TaskConstructor> {
    const builtin =
      this.classPathMap.get(classPathOrName) ?? this.nameMap.get(classPathOrName);
    if (builtin) return builtin;

    return this.loadDynamic(classPathOrName);
  }

  /**
   * Resolve + instantiate in one call.
   *
   * The phase is resolved *before* construction, not left to `BaseTask`, so a
   * host-authored constructor that reads `ctx.executionPhase` before calling
   * `super()` sees the same value the task will. `resolveTaskContext` is a
   * no-op when the caller already supplied a phase, which is every path through
   * `FlowRunner`.
   */
  async create(
    classPathOrName: string,
    ctx: TaskContextInput,
    options: Record<string, unknown>,
  ): Promise<BaseTask> {
    const TaskClass = await this.resolve(classPathOrName);
    return new TaskClass(resolveTaskContext(ctx), options);
  }

  /**
   * Wrap an existing registered task with a decorator class.
   *
   * The `wrapper` factory receives the original constructor and must return
   * a new constructor — typically a subclass that calls `super.execute()`.
   * Multiple wraps compose: each layer sees the previously wrapped version
   * as its `Original`.
   *
   * ```ts
   * registry.wrap('asset.list', (Original) => {
   *   return class extends Original {
   *     get taskName() { return 'asset.list:filtered'; }
   *     async execute() {
   *       const result = await super.execute();
   *       // post-process result …
   *       return result;
   *     }
   *   };
   * });
   * ```
   */
  wrap(name: string, wrapper: (Original: TaskConstructor) => TaskConstructor): this {
    const original = this.nameMap.get(name) ?? this.classPathMap.get(name);
    if (!original) {
      throw new Error(
        `Cannot wrap task "${name}" — not found in registry. ` +
          `Registered: ${this.listRegistered().join(', ')}`,
      );
    }
    const wrapped = wrapper(original);
    // Always write to nameMap so subsequent resolve() finds it
    this.nameMap.set(name, wrapped);
    return this;
  }

  /**
   * Describe a task: resolve its class (loading it if needed) and fold the
   * class's static metadata together with its configured definition.
   *
   * Pass the configured task definitions (`config.tasks`) to include them;
   * without, only the class is described. `FlowRunner.describeTask` passes the
   * runner's own.
   */
  async describe(
    name: string,
    taskDefinitions?: Record<string, TaskDefinition>,
  ): Promise<TaskDescription> {
    const def = taskDefinitions?.[name];
    const { classPath, options } = resolveTaskDefinition(name, taskDefinitions);
    const meta = taskClassMetadata(await this.resolve(classPath));
    const optionsSchema = mergeOptionSpecs(meta.optionsSchema, def?.options_schema);
    const outputs =
      meta.outputs || def?.outputs ? { ...(meta.outputs ?? {}), ...(def?.outputs ?? {}) } : undefined;
    const out: TaskDescription = {
      name,
      class_path: classPath,
      options: applyOptionDefaults(optionsSchema, { ...options }),
    };
    const description = def?.description ?? meta.description;
    if (description !== undefined) out.description = description;
    if (def?.group !== undefined) out.group = def.group;
    if (optionsSchema) out.options_schema = optionsSchema;
    if (outputs) out.outputs = outputs;
    if (def?.idempotent !== undefined) out.idempotent = def.idempotent;
    if (def?.reversible !== undefined) out.reversible = def.reversible;
    const deprecated = def?.deprecated ?? meta.deprecated;
    if (deprecated) out.deprecated = deprecated;
    const replacedBy = def?.replaced_by ?? meta.replacedBy;
    if (replacedBy !== undefined) out.replaced_by = replacedBy;
    return out;
  }

  /** Return all registered names and class paths. */
  listRegistered(): string[] {
    return [...new Set([...this.nameMap.keys(), ...this.classPathMap.keys()])];
  }

  // ---------------------------------------------------------------------------
  // Dynamic loading — class_path treated as a dotted file path
  // ---------------------------------------------------------------------------

  private async loadDynamic(classPath: string): Promise<TaskConstructor> {
    const cached = this.dynamicCache.get(classPath);
    if (cached) return cached;

    const candidates = this.classPathToCandidates(classPath);
    let resolvedPath: string | null = null;

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        resolvedPath = candidate;
        break;
      }
    }

    if (!resolvedPath) {
      throw new Error(
        `Cannot resolve task "${classPath}". Searched:\n` +
          candidates.map((c) => `  - ${c}`).join('\n'),
      );
    }

    const fileUrl = `file://${resolvedPath.replace(/\\/g, '/')}`;
    const mod = await import(fileUrl);

    const baseName = path.basename(classPath.replace(/\./g, '/'));
    const TaskClass = mod.default ?? mod[baseName];

    if (!TaskClass) {
      throw new Error(
        `Module "${resolvedPath}" does not export a default class or a named export ` +
          `matching "${baseName}"`,
      );
    }

    if (!extendsBaseTask(TaskClass)) {
      throw new Error(`Task class from "${resolvedPath}" does not extend BaseTask`);
    }

    this.dynamicCache.set(classPath, TaskClass as TaskConstructor);
    return TaskClass as TaskConstructor;
  }

  private classPathToCandidates(classPath: string): string[] {
    const segments = classPath.replace(/\./g, '/');
    const cwd = process.cwd();

    return [
      path.resolve(cwd, `${segments}.ts`),
      path.resolve(cwd, `${segments}.js`),
      path.resolve(cwd, `${segments}/index.ts`),
      path.resolve(cwd, `${segments}/index.js`),
    ];
  }
}
