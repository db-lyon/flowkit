# Custom tasks

Tasks are the building blocks of flowkit. Each task is a class that extends `BaseTask` and implements an `execute()` method.

## Anatomy of a task

```typescript
import { BaseTask, type TaskResult } from '@db-lyon/flowkit';

interface MyOptions {
  url: string;
  retries?: number;
}

export default class FetchData extends BaseTask<MyOptions> {
  get taskName() {
    return 'fetch_data';
  }

  protected validate() {
    if (!this.options.url) {
      throw new Error('url option is required');
    }
  }

  async execute(): Promise<TaskResult> {
    const { url, retries = 3 } = this.options;

    const response = await fetch(url);
    if (!response.ok) {
      return {
        success: false,
        error: new Error(`HTTP ${response.status}`),
      };
    }

    const data = await response.json();
    return {
      success: true,
      data: { body: data, status: response.status },
    };
  }
}
```

### Required members

| Member | Description |
|--------|-------------|
| `get taskName()` | A human-readable name used in logging |
| `execute()` | Async method that performs the work and returns a `TaskResult` |

### Optional members

| Member | Description |
|--------|-------------|
| `validate()` | Called before `execute()`. Throw to abort with a validation error. |
| `static optionsSchema` | Declared options, checked before the task runs. See below. |
| `static outputs` | Declared `data` keys, for `describe` and docs. Not enforced. |
| `static description` | Used when the task definition has no `description`. |

### Declaring options

A task class can declare its options statically, the way a CumulusCI task
declares `task_options`. `FlowRunner` checks a step's final options against the
declaration before it constructs the task, so a bad option fails with a message
naming the task and the option, and the task never runs:

```typescript
import { BaseTask, type OptionSpecs, type TaskResult } from '@db-lyon/flowkit';

export default class Deploy extends BaseTask<{ environment: string; replicas: number }> {
  static description = 'Deploy the build';
  static optionsSchema: OptionSpecs = {
    environment: { type: 'string', enum: ['staging', 'prod'], required: true, description: 'Target' },
    replicas: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
  };
  static outputs = { url: { type: 'string', description: 'Where it landed' } };

  get taskName() { return 'deploy'; }
  async execute(): Promise<TaskResult> { /* ... */ return { success: true }; }
}
// Task "deploy": option "environment" must be one of ["staging","prod"]
```

Each option spec takes `type` (one type or a list), `description`,
`required`, `default`, and the JSON Schema constraint keywords `enum`, `const`,
`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`,
`maxLength`, `pattern`, `minItems`, `maxItems`, `items`, `properties`,
`additionalProperties` and `nullable`.

- `default` fills an option no layer supplied. It is the lowest precedence of
  all, below the task definition's `options`.
- `required` is checked after every layer (defaults, definition options, step
  options, runtime params) has been merged.
- Options the schema does not declare are allowed through.
- A failed check is not retried, whatever the step's `retries`.

A task definition refines the class declaration with `options_schema`, option
by option and field by field, so one configured variant can narrow an enum,
change a default or add an option without restating the rest:

```yaml
tasks:
  deploy_staging:
    class_path: tasks.Deploy
    options_schema:
      environment: { enum: [staging], default: staging }
```

The check runs on every `FlowRunner` path: flow steps, hook steps, `runTask`,
rollback and composite child steps. A task built directly (`new Deploy(...)`)
or through `this.call()` from another task is not checked.
`validateTaskOptions(specs, options)` and `assertTaskOptions(name, specs,
options)` run the same check for a host that constructs tasks itself.

### Describing a task

`registry.describe(name, taskDefinitions?)` folds a task's class metadata and
its configured definition into one object, for a host's `describe` command or
generated docs. `FlowRunner.describeTask(name)` does the same with the
runner's own definitions:

```typescript
const d = await runner.describeTask('deploy');
// {
//   name: 'deploy', class_path: 'tasks.Deploy', description: 'Deploy the build',
//   options: { replicas: 2 },               // schema defaults, then definition options
//   options_schema: { environment: {...}, replicas: {...} },
//   outputs: { url: {...} },
// }
```

### Available on `this`

| Property | Description |
|----------|-------------|
| `this.options` | The merged options (task defaults + step overrides), typed as `TOptions` |
| `this.ctx` | The `TaskContext` passed to the flow runner — read-only, see below |
| `this.logger` | A child logger scoped to this task instance |
| `this.resolve(name, options?)` | Build another task by configured name or class path, unexecuted |
| `this.call(name, options?)` | `resolve()` plus `run()`, returning its `TaskResult` |

## Calling other tasks

`this.call(name)` resolves `name` the same way a flow step does. A configured task name is looked up in the `tasks:` config and dispatched through its `class_path`, inheriting its configured `options` as defaults; anything you pass as `options` merges over them and wins. A name with no configured entry resolves as a class path directly, so a bare `vendor.tasks.Thing` still works.

```yaml
tasks:
  soql_query:
    class_path: caseops.tasks.SoqlQuery
    options:
      org: ${org.username}
```

```typescript
// Runs caseops.tasks.SoqlQuery with { org: 'admin@example.com', query: 'SELECT ...' }
const result = await this.call('soql_query', { query: 'SELECT Id FROM Case' });
```

The `${ns.path}` references in those configured defaults are interpolated for you, against the same scope the calling task itself runs under. The `options` you pass are your own runtime data and are **never** interpolated, so a `${...}` you computed reaches the task verbatim rather than being reinterpreted as configuration.

Calling a task requires a registry on the context, which `FlowRunner` supplies. A task constructed by hand without one throws.

## Composite tasks

A flow is a fixed sequence. When the children depend on the input (one child
per item in a list, or pages until a cap), write a **composite**: a task that
runs each child with `this.step()`. Unlike `this.call()`, a child step goes
through the runner's bookkeeping, exactly like a flow step:

- it is recorded under the parent, as `TaskResult.children` (a
  `FlowStepResult[]` whose entries carry a `path` such as `2/1`), and is
  therefore visible in the run result tree;
- the runner's `beforeStep` / `afterStep` hooks fire for it, with that path;
- the step retry policy applies (`{ retries, retryDelay, retryOn }` as the third
  argument), as do option schemas and deprecation warnings;
- its rollback record is harvested with the parent's: inside a flow with
  `rollback_on_failure`, children unwind in reverse after the parent's own
  record.

```typescript
class ImportBatch extends BaseTask<{ files: string[]; failFast?: boolean }> {
  get taskName() { return 'import_batch'; }

  async execute(): Promise<TaskResult> {
    const results = [];
    for (const file of this.options.files) {
      const r = await this.step('asset.import', { file }, { retries: 2 });
      results.push({ file, ok: r.success });
      if (!r.success && this.options.failFast) {
        return { success: false, error: r.error, data: { results, stoppedAt: file } };
      }
    }
    return { success: true, data: { results } };
  }
}
```

`this.step(target, options?, spec?)` takes a configured task name, `{ task:
name }` or `{ flow: name }`, and returns the child's `TaskResult`. It never
throws for a failed child: the composite decides whether to go on. The
`options` are the composite's runtime data. They are layered over the child
task's configured defaults verbatim, not interpolated, and runtime `params` and
enclosing-flow overrides do not reach children. For a flow child they are the
flow's `params`.

The runner supplies this for every task it runs, whether as a flow step, a hook,
or on its own through `runner.runTask(name, options)`, so a composite behaves
the same with or without an enclosing flow. Under `runTask`, the children are on
the returned `TaskResult.children`, and `collectRollbackRecords(result)` returns
every record in the tree (children first, invoke in reverse) for a host that
does its own rollback. A task constructed by hand has no runner: a task child
falls back to `this.call()` without bookkeeping, and a flow child fails.

### `expand`: the child plan without running it

A composite can declare a static `expand(options, ctx)` that returns the
children it would run, as `{ task | flow, options? }` entries, without running
anything. Return `null` when the children depend on runtime results (a pager
cannot know how many pages there are):

```typescript
class ImportBatch extends BaseTask<{ files: string[] }> {
  static expand(options: Record<string, unknown>): ChildPlanEntry[] | null {
    const files = options.files;
    return Array.isArray(files) ? files.map((file) => ({ task: 'asset.import', options: { file } })) : null;
  }
  // ...
}
```

- `run({ plan: true, expandComposites: true })` follows each composite row with
  its children, one level deeper and with paths (`1/1`, `1/2`), and marks the
  row `composite: 'expanded'`. A composite whose `expand` returns `null` (or
  throws) is marked `composite: 'opaque'`. Without `expandComposites` the plan is
  unchanged. It composes with `expandNestedFlows`.
- `runner.expandTask(name, options?)` returns the child plan for a `describe`
  command, or `null`.
- `expand` receives the options as far as they can be resolved before a run:
  configured defaults, the step's options and its runtime params, with host
  references interpolated and step references left as written. `ctx` carries
  `taskName`, `taskDefinitions`, `flows` and `references`.

## The task lifecycle

When `task.run()` is called (by the flow runner):

1. `validate()` runs — throw here to reject bad options
2. `execute()` runs — return a `TaskResult`
3. The result gets a `duration` field added automatically
4. If `validate()` or `execute()` throws, the error is caught and returned as `{ success: false, error }`

You never call `run()` yourself in normal usage — the flow runner handles it.

## TaskResult

```typescript
interface TaskResult {
  success: boolean;
  data?: Record<string, unknown>;  // arbitrary output data
  error?: Error;                    // populated on failure
  duration?: number;                // milliseconds, set by run()
}
```

Return `{ success: true }` for success and `{ success: false, error }` for expected failures. Unexpected exceptions are caught automatically.

## TaskContext

The context carries host-supplied state to every task in a flow run — database connections, API clients, configuration:

```typescript
const runner = new FlowRunner({
  // ...
  context: {
    logger: myLogger,
    db: databaseConnection,
    apiKey: process.env.API_KEY,
  },
});
```

Inside a task:

```typescript
async execute(): Promise<TaskResult> {
  const db = this.ctx.db as Database;
  if (this.executionPhase === 'rollback') {
    // This invocation is compensating for earlier successful work.
  }
  // ...
}
```

`this.executionPhase` is a public, read-only lifecycle value:
`'task' | 'on_start' | 'on_success' | 'on_failure' | 'finally' | 'rollback'`.
Ordinary steps (including nested-flow steps), direct `runTask` calls,
task-to-task calls, and agent/tool work receive `'task'`. Hook tasks receive
their hook phase, and rollback-record invocations receive `'rollback'`.
Flowkit supplies the value; existing runner configurations do not need to add
it to `context`. `ctx.executionPhase` holds the same value but is typed
optional, because `TaskContext` is also the shape hosts build their own context
interfaces from; prefer the `this.executionPhase` accessor.

`ctx.signal` is an optional, read-only host cancellation signal. A runner
propagates its host/run-scoped signal to task invocations; a direct task may
receive its own invocation signal. Agent and prompt tasks forward it to every
LLM call and retry delay, so cancellation prevents later retry attempts. It is
runtime context only and is not supported in YAML/configuration.

Treat the context as read-only. Each task is handed its own derived context, so assigning a key inside a task (`this.ctx.cached = x`) does not reach the next step, another task, or a sub-agent. To share mutable state, put a mutable object on the context up front and write into that:

```typescript
context: { cache: new Map() }   // this.ctx.cache.set(...) is visible everywhere
```

## Registering tasks

### By name

```typescript
const registry = new TaskRegistry();
registry.register('fetch_data', FetchData as any);
```

The YAML can then reference it directly:

```yaml
tasks:
  fetch_data:
    class_path: fetch_data
```

### By class path

```typescript
registry.registerClassPath('my.tasks.FetchData', FetchData as any);
```

### Bulk registration

```typescript
registry.registerAll({
  fetch_data: FetchData as any,
  transform: TransformData as any,
  upload: Upload as any,
});
```

### Dynamic resolution

If a `class_path` isn't found in the registry, flowkit converts dots to path separators and looks for a file on disk:

| class_path | Files checked |
|------------|---------------|
| `tasks.FetchData` | `tasks/FetchData.ts`, `tasks/FetchData.js`, `tasks/FetchData/index.ts`, `tasks/FetchData/index.js` |
| `lib.etl.Extract` | `lib/etl/Extract.ts`, `lib/etl/Extract.js`, ... |

The module must have either a `default` export or a named export matching the last segment of the path (e.g., `FetchData`). The export must extend `BaseTask`.

## Built-in: ShellTask

`ShellTask` executes shell commands through the platform shell and streams output.
Register it under any name you like:

```typescript
import { ShellTask } from '@db-lyon/flowkit';

registry.register('shell', ShellTask as any);
```

Then use it in YAML:

```yaml
tasks:
  lint:
    class_path: shell
    description: Run the linter
    options:
      command: npm run lint

  build:
    class_path: shell
    description: Build the project
    options:
      command: npm run build
      cwd: /path/to/project
      timeout: 120000
```

### ShellTask options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `command` | `string` | (required) | The shell command to execute |
| `cwd` | `string` | `undefined` | Working directory |
| `timeout` | `number` | `300000` (5 min) | Timeout in milliseconds |
| `signal` | `AbortSignal` | `undefined` | Cancels one programmatic invocation; cannot be specified in YAML |

On success, `result.data.output` contains the trimmed stdout. On failure, `result.data` includes `exitCode`, `stderr`, and `stdout`.

Existing YAML consumers need no change. Programmatic callers that need
cancellation pass an invocation-specific `AbortSignal` in the task options.
After cancellation, Flowkit waits for the shell to close, with a bounded
fallback if the operating system does not report closure (one second on POSIX,
five seconds on Windows). That fallback does not guarantee all descendants
have exited. At the deadline Flowkit requests force termination and releases
its Node handles for the root shell and any Windows `taskkill` helper before
returning. On POSIX,
signal-bearing invocations use a dedicated process group: Flowkit requests
`SIGTERM`, waits 250ms for cooperative cleanup, then escalates the group to
`SIGKILL`. Terminal Ctrl+C is not delivered to that separate group, so use the
supplied `AbortSignal` for cancellation.

On Windows, Flowkit asks `taskkill /T /F` to terminate the shell tree and does
not kill the shell while that traversal is in progress. If `taskkill` fails or
the five-second deadline expires, Flowkit requests force termination and
releases its Node handles for the root and helper. Windows and POSIX descendants that escape the managed process
tree or process group may still survive; Node does not provide a portable
guarantee of complete descendant termination.

Trailing stdout and stderr fragments are captured once, including when no
`signal` is supplied. This corrects the duplicate final-partial-line output in
earlier releases.

## Listing registered tasks

```typescript
const names = registry.listRegistered();
// ['fetch_data', 'shell', 'my.tasks.Transform', ...]
```
