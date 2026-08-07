import type { ShellTaskOptions as RootShellTaskOptions } from '@db-lyon/flowkit';
import type { ShellTaskOptions as TaskShellTaskOptions } from '@db-lyon/flowkit/task';
import type { Guard as RootGuard, GuardContext } from '@db-lyon/flowkit';
import type { Guard as GuardGuard } from '@db-lyon/flowkit/guard';
import { GuardRegistry, runGuarded, guardContextBase } from '@db-lyon/flowkit/guard';
import { GuardRegistry as RootGuardRegistry } from '@db-lyon/flowkit';
import { ShellTask as RootShellTask } from '@db-lyon/flowkit';
import { ShellTask as TaskShellTask } from '@db-lyon/flowkit/task';
import { TaskRegistry as RootTaskRegistry } from '@db-lyon/flowkit';
import { TaskRegistry as TaskTaskRegistry } from '@db-lyon/flowkit/task';
import type { FlowRunnerConfig as RootFlowRunnerConfig } from '@db-lyon/flowkit';
import type { FlowRunnerConfig as FlowFlowRunnerConfig } from '@db-lyon/flowkit/flow';
import type {
  ExecutionPhase as RootExecutionPhase,
  TaskContext as RootTaskContext,
  TaskContextInput as RootTaskContextInput,
} from '@db-lyon/flowkit';
import type {
  ExecutionPhase as TaskExecutionPhase,
  TaskContext as TaskTaskContext,
  TaskContextInput as TaskTaskContextInput,
} from '@db-lyon/flowkit/task';

const signal = new AbortController().signal;
const rootOptions: RootShellTaskOptions = { command: 'echo root', signal };
const taskOptions: TaskShellTaskOptions = { command: 'echo task', signal };
const rootTask = new RootShellTask({}, rootOptions);
const taskTask = new TaskShellTask({}, taskOptions);
const rootCreatedTask = new RootTaskRegistry().create('root-task', {}, {});
const taskCreatedTask = new TaskTaskRegistry().create('task-task', {}, {});
const phases: RootExecutionPhase[] = [
  'task',
  'on_start',
  'on_success',
  'on_failure',
  'finally',
  'rollback',
];
const taskPhase: TaskExecutionPhase = 'task';
const rootInput: RootTaskContextInput = {};
const taskInput: TaskTaskContextInput = {};

declare const rootContext: RootTaskContext;
declare const taskContext: TaskTaskContext;
const rootContextPhase: RootExecutionPhase = rootContext.executionPhase;
const taskContextPhase: TaskExecutionPhase = taskContext.executionPhase;
const rootRunnerContext: RootFlowRunnerConfig['context'] = {};
const flowRunnerContext: FlowFlowRunnerConfig['context'] = {};

// @ts-expect-error lifecycle values are a closed public union.
const invalidPhase: RootExecutionPhase = 'cleanup';

// The lifecycle value is observable but runner-owned and read-only.
// @ts-expect-error executionPhase cannot be mutated by a task.
rootContext.executionPhase = 'rollback';
// @ts-expect-error executionPhase cannot be mutated through the task subpath either.
taskContext.executionPhase = 'finally';

// The root and the ./guard subpath must describe the same guard, so a host can
// import from either without the two drifting into incompatible shapes.
const guard: RootGuard<GuardContext, string> = { name: 'x', before: async () => {} };
const sameGuard: GuardGuard<GuardContext, string> = guard;

const registry: RootGuardRegistry<GuardContext, string> = new GuardRegistry<
  GuardContext,
  string
>().register(sameGuard);

const run = runGuarded(guardContextBase(), registry, async () => 'ok');

void rootOptions;
void taskOptions;
void run;
void rootTask;
void taskTask;
void rootCreatedTask;
void taskCreatedTask;
void phases;
void taskPhase;
void rootInput;
void taskInput;
void rootContextPhase;
void taskContextPhase;
void rootRunnerContext;
void flowRunnerContext;
void invalidPhase;
