import { BaseTask, type TaskContext, type TaskResult } from '../../src/task/base-task.js';

export default class DynamicExplicitTask extends BaseTask {
  private readonly observedPhase: string;

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
