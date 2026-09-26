import type { BaseTask as BaseTaskType, TaskResult } from '../../src/task/base-task.js';

// A separate instance of base-task, as a task file gets when it resolves flowkit
// through a path that differs from the host's (a second install, or a path that
// differs only in case on Windows). The specifier is a variable so tsc does not
// try to resolve the query string.
const secondCopy = '../../src/task/base-task.js?second-copy';
const { BaseTask } = (await import(secondCopy)) as { BaseTask: typeof BaseTaskType };

export { BaseTask as SecondCopyBaseTask };

export default class DynamicSecondCopyTask extends BaseTask {
  get taskName() {
    return 'dynamic-second-copy';
  }

  async execute(): Promise<TaskResult> {
    return { success: true };
  }
}
