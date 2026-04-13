import type { Logger } from '../logger.js';
import { noopLogger } from '../logger.js';

export interface TaskContext {
  logger?: Logger;
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
