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

### Available on `this`

| Property | Description |
|----------|-------------|
| `this.options` | The merged options (task defaults + step overrides), typed as `TOptions` |
| `this.ctx` | The `TaskContext` passed to the flow runner — use it to share state |
| `this.logger` | A child logger scoped to this task instance |

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

The context object is shared across all tasks in a flow run. Use it to pass shared state like database connections, API clients, or configuration:

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
  // ...
}
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

`ShellTask` executes shell commands via `execSync`. Register it under any name you like:

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

On success, `result.data.output` contains the trimmed stdout. On failure, `result.data` includes `exitCode`, `stderr`, and `stdout`.

## Listing registered tasks

```typescript
const names = registry.listRegistered();
// ['fetch_data', 'shell', 'my.tasks.Transform', ...]
```
