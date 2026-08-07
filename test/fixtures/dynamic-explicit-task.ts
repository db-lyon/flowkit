import {
  BaseTask,
  type ExecutionPhase,
  type TaskContext,
  type TaskResult,
} from '../../src/task/base-task.js';

export default class DynamicExplicitTask extends BaseTask {
  // Optional: a caller constructing this directly may omit the phase. The test
  // asserts the registry path, which always resolves it before construction.
  private readonly observedPhase: ExecutionPhase | undefined;

  constructor(ctx: TaskContext, options: Record<string, unknown>) {
    const observedPhase = ctx.executionPhase;
    super(ctx, options);
    this.observedPhase = observedPhase;
  }

  get taskName() {
    return 'dynamic-explicit';
  }

  async execute(): Promise<TaskResult> {
    return { success: true, data: { observedPhase: this.observedPhase } };
  }
}
