import {
  SHELL_TASK_CANCELLED_MESSAGE as rootCancelledMessage,
  type ShellTaskOptions as RootShellTaskOptions,
} from '@db-lyon/flowkit';
import {
  SHELL_TASK_CANCELLED_MESSAGE as taskCancelledMessage,
  type ShellTaskOptions as TaskShellTaskOptions,
} from '@db-lyon/flowkit/task';

const signal = new AbortController().signal;
const rootOptions: RootShellTaskOptions = { command: 'echo root', signal };
const taskOptions: TaskShellTaskOptions = { command: 'echo task', signal };

void rootOptions;
void taskOptions;
void rootCancelledMessage;
void taskCancelledMessage;
