import * as path from 'node:path';
import * as fs from 'node:fs';
import { BaseTask, type TaskContext } from './base-task.js';

export type TaskConstructor = new (
  ctx: TaskContext,
  options: Record<string, unknown>,
) => BaseTask;

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

  /** Resolve + instantiate in one call. */
  async create(
    classPathOrName: string,
    ctx: TaskContext,
    options: Record<string, unknown>,
  ): Promise<BaseTask> {
    const TaskClass = await this.resolve(classPathOrName);
    return new TaskClass(ctx, options);
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

    if (!(TaskClass.prototype instanceof BaseTask)) {
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
