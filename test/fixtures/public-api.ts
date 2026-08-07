import type { ShellTaskOptions as RootShellTaskOptions } from '@db-lyon/flowkit';
import type { ShellTaskOptions as TaskShellTaskOptions } from '@db-lyon/flowkit/task';
import type { Guard as RootGuard, GuardContext } from '@db-lyon/flowkit';
import type { Guard as GuardGuard } from '@db-lyon/flowkit/guard';
import { GuardRegistry, runGuarded, guardContextBase } from '@db-lyon/flowkit/guard';
import { GuardRegistry as RootGuardRegistry } from '@db-lyon/flowkit';

const signal = new AbortController().signal;
const rootOptions: RootShellTaskOptions = { command: 'echo root', signal };
const taskOptions: TaskShellTaskOptions = { command: 'echo task', signal };

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
