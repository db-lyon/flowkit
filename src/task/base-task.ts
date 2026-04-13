import type { Logger } from '../logger.js';
import { noopLogger } from '../logger.js';
import type { TaskRegistry } from './registry.js';

export interface TaskContext {
  logger?: Logger;
  registry?: TaskRegistry;
  [key: string]: unknown;
}

export interface TaskResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: Error;
  duration?: number;
}

export abstract class BaseTask<TOpts = Record<string, unknown>> {
  protected logger: Logger;

  constructor(
    protected ctx: TaskContext,
    protected options: TOpts,
  ) {
    const parentLogger = ctx.logger ?? noopLogger;
    this.logger = parentLogger.child({ task: this.constructor.name });
  }

  abstract get taskName(): string;

  abstract execute(): Promise<TaskResult>;

  /** Override for option validation — called before execute(). */
  protected validate(): void {}

  /**
   * Resolve another task by name from the registry.
   * Returns an unexecuted task instance — call `.run()` on it yourself
   * when you need to inspect or configure the task before running.
   */
  protected async resolve<T extends BaseTask = BaseTask>(
    taskName: string,
    options?: Record<string, unknown>,
  ): Promise<T> {
    const registry = this.ctx.registry;
    if (!registry) {
      throw new Error(
        `Cannot resolve task "${taskName}" — no registry in context. ` +
          'Tasks can only resolve other tasks when run via FlowRunner.',
      );
    }
    return registry.create(taskName, this.ctx, options ?? {}) as Promise<T>;
  }

  /**
   * Resolve and execute another task by name in a single call.
   * The resolved task shares this task's context (bridge, project, etc.).
   */
  protected async call(
    taskName: string,
    options?: Record<string, unknown>,
  ): Promise<TaskResult> {
    const task = await this.resolve(taskName, options);
    return task.run();
  }

  /**
   * Lifecycle wrapper: validate → execute → return result.
   * Catches exceptions and returns `{ success: false }` instead of throwing.
   */
  async run(): Promise<TaskResult> {
    const startTime = Date.now();

    this.logger.debug({ options: this.options }, `Starting task: ${this.taskName}`);

    try {
      this.validate();
      const result = await this.execute();
      result.duration = Date.now() - startTime;

      this.logger.debug(
        { success: result.success, duration: result.duration },
        `Completed task: ${this.taskName}`,
      );

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error({ error, duration }, `Failed task: ${this.taskName}`);

      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        duration,
      };
    }
  }
}
