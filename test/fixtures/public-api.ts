import type { ShellTaskOptions as RootShellTaskOptions } from '@db-lyon/flowkit';
import type { ShellTaskOptions as TaskShellTaskOptions } from '@db-lyon/flowkit/task';

const signal = new AbortController().signal;
const rootOptions: RootShellTaskOptions = { command: 'echo root', signal };
const taskOptions: TaskShellTaskOptions = { command: 'echo task', signal };

void rootOptions;
void taskOptions;
