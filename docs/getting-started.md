# Getting started

This guide walks through setting up flowkit from scratch.

## Prerequisites

- Node.js >= 20
- TypeScript project with `"module": "NodeNext"` (or compatible ESM setup)

## Install

```bash
npm install @db-lyon/flowkit
```

## 1. Create a YAML config

Create `config/pipeline.yml`:

```yaml
tasks:
  greet:
    class_path: tasks.Greet
    description: Print a greeting
    options:
      name: world

flows:
  hello:
    description: Run the greeting
    steps:
      1:
        task: greet
```

### What's happening here

- **tasks** defines reusable units of work. Each task has a `class_path` that tells flowkit how to find the task implementation, and optional default `options`.
- **flows** defines sequences of steps. Each step references a task (or another flow) by name. Steps execute in numeric order.

## 2. Create a task class

Create `tasks/Greet.ts`:

```typescript
import { BaseTask, type TaskResult } from '@db-lyon/flowkit';

interface GreetOptions {
  name: string;
}

export default class Greet extends BaseTask<GreetOptions> {
  get taskName() {
    return 'greet';
  }

  async execute(): Promise<TaskResult> {
    const message = `Hello, ${this.options.name}!`;
    this.logger.info(message);
    return { success: true, data: { message } };
  }
}
```

Every task must:
1. Extend `BaseTask<TOptions>`
2. Implement the `taskName` getter
3. Implement the async `execute()` method returning a `TaskResult`

## 3. Wire it up

Create `run.ts`:

```typescript
import {
  loadConfig,
  EngineConfigSchema,
  TaskRegistry,
  FlowRunner,
} from '@db-lyon/flowkit';

// Load and validate the YAML config
const { config } = loadConfig({
  filename: 'pipeline.yml',
  schema: EngineConfigSchema,
  configDir: './config',
});

// Create a registry — flowkit uses this to resolve class_path → constructor
const registry = new TaskRegistry();

// Create the flow runner
const runner = new FlowRunner({
  tasks: config.tasks,
  flows: config.flows,
  registry,
  context: {},
});

// Run the flow
const result = await runner.run({ flowName: 'hello' });

if (result.success) {
  console.log('Flow completed successfully');
} else {
  console.error('Flow failed:', result.error?.message);
}
```

## 4. Run it

```bash
npx tsx run.ts
```

The `greet` task's `class_path: tasks.Greet` tells flowkit to look for `tasks/Greet.ts` (or `.js`) relative to `process.cwd()`. It dynamically imports the file and instantiates the default export.

## How task resolution works

When the flow runner encounters a task step, it:

1. Looks up the task name in `config.tasks` to get the `class_path`
2. Checks the registry for a constructor registered under that `class_path` or name
3. If not found, converts the dotted path to a file path and dynamically imports it (e.g., `tasks.Greet` → `tasks/Greet.ts`)
4. Instantiates the task with the merged options (task defaults + step overrides)
5. Calls `task.run()` which runs `validate()` → `execute()` → returns the result

## Explicit registration

Instead of relying on dynamic filesystem resolution, you can register tasks directly:

```typescript
import Greet from './tasks/Greet.js';

const registry = new TaskRegistry();
registry.register('greet', Greet as any);

// Or by class_path
registry.registerClassPath('tasks.Greet', Greet as any);

// Or bulk register
registry.registerAll({
  greet: Greet as any,
  // ...more tasks
});
```

## Adding a logger

Flowkit accepts any logger with `debug`, `info`, `warn`, `error`, and `child` methods (pino, winston, etc.):

```typescript
import pino from 'pino';

const logger = pino();

const runner = new FlowRunner({
  tasks: config.tasks,
  flows: config.flows,
  registry,
  context: { logger },
  logger,
});
```

The context logger is passed to each task instance. The runner logger is used for flow-level logging. Both fall back to a silent no-op logger if omitted.

## Next steps

- [Custom tasks](custom-tasks.md) — validation, error handling, and the ShellTask
- [Configuration](configuration.md) — layered configs, environment overlays, deep merge
- [API reference](api-reference.md) — full type and function docs
