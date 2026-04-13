# API reference

Complete reference for all public exports from `@db-lyon/flowkit`.

## Config

*Import from `@db-lyon/flowkit` or `@db-lyon/flowkit/config`*

### `loadConfig(options)`

Load, layer, and validate YAML configuration files.

```typescript
function loadConfig<T extends z.ZodType>(
  options: LoadConfigOptions<T>,
): LoadedConfig<z.infer<T>>
```

**`LoadConfigOptions<T>`**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `filename` | `string` | yes | Primary config filename (e.g., `'app.yml'`) |
| `schema` | `z.ZodType` | yes | Zod schema applied after merging all layers |
| `defaults` | `unknown` | no | Built-in defaults merged under the project file |
| `env` | `string` | no | Environment name — loads `{base}.{env}.{ext}` overlay |
| `envVar` | `string` | no | Env var to read environment name from when `env` is not passed |
| `configDir` | `string` | no | Directory to search (default: `process.cwd()`) |

**`LoadedConfig<T>`**

| Field | Type | Description |
|-------|------|-------------|
| `config` | `T` | The validated, merged configuration object |
| `configDir` | `string` | The directory the config was loaded from |

---

### `findConfigFile(filename, startDir?)`

Walk up parent directories looking for a file by name.

```typescript
function findConfigFile(filename: string, startDir?: string): string
```

Returns the absolute path. Throws if not found.

---

### `loadRawYaml(filePath)`

Parse a YAML file and return the raw result (no schema validation).

```typescript
function loadRawYaml(filePath: string): unknown
```

---

### `deepMerge(base, override)`

Recursively merge two values. Objects merge key-by-key, arrays replace (unless `__merge: 'append'`), scalars override, `null` nullifies, `undefined` is a no-op.

```typescript
function deepMerge(base: unknown, override: unknown): unknown
```

---

### Zod schemas

| Schema | Validates |
|--------|-----------|
| `TaskOptionsSchema` | `Record<string, unknown>` |
| `TaskDefinitionSchema` | Task definition object |
| `FlowStepSchema` | Single flow step (task xor flow) |
| `FlowDefinitionSchema` | Flow with description and steps |
| `EngineConfigSchema` | Top-level config with `tasks` and `flows` |

---

### Config types

```typescript
type TaskOptions = Record<string, unknown>;

type TaskDefinition = {
  class_path: string;
  description?: string;
  group?: string;
  options: TaskOptions;  // defaults to {}
};

type FlowStep = {
  task?: string;
  flow?: string;
  options?: TaskOptions;
};

type FlowDefinition = {
  description: string;
  steps: Record<string, FlowStep>;
};

type EngineConfig = {
  tasks: Record<string, TaskDefinition>;
  flows: Record<string, FlowDefinition>;
};
```

---

## Task

*Import from `@db-lyon/flowkit` or `@db-lyon/flowkit/task`*

### `BaseTask<TOpts>`

Abstract base class for all tasks.

```typescript
abstract class BaseTask<TOpts = Record<string, unknown>> {
  protected ctx: TaskContext;
  protected options: TOpts;
  protected logger: Logger;

  constructor(ctx: TaskContext, options: TOpts);

  abstract get taskName(): string;
  abstract execute(): Promise<TaskResult>;
  protected validate(): void;
  async run(): Promise<TaskResult>;
}
```

| Method | Description |
|--------|-------------|
| `taskName` | (getter) Human-readable name for logging |
| `execute()` | Perform the task's work. Return a `TaskResult`. |
| `validate()` | Optional. Called before `execute()`. Throw to abort. |
| `run()` | Lifecycle wrapper: validate → execute → catch errors → add duration. Called by the flow runner. |

---

### `TaskContext`

```typescript
interface TaskContext {
  logger?: Logger;
  [key: string]: unknown;
}
```

Shared context passed to every task. Add any properties you need (database connections, API clients, etc.).

---

### `TaskResult`

```typescript
interface TaskResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: Error;
  duration?: number;  // milliseconds, set by run()
}
```

---

### `ShellTask`

Built-in task that executes shell commands via `execSync`.

```typescript
class ShellTask extends BaseTask<ShellTaskOptions> {
  get taskName(): string;       // "shell:{command}"
  protected validate(): void;   // requires command
  async execute(): Promise<TaskResult>;
}
```

**`ShellTaskOptions`**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `command` | `string` | (required) | Shell command to execute |
| `cwd` | `string` | `undefined` | Working directory |
| `timeout` | `number` | `300000` | Timeout in milliseconds (5 min) |

**Success result:** `data.output` contains trimmed stdout.

**Failure result:** `data.exitCode`, `data.stderr`, `data.stdout`.

---

### `TaskRegistry`

Registry that maps names and class paths to task constructors.

```typescript
class TaskRegistry {
  register(name: string, ctor: TaskConstructor): this;
  registerClassPath(classPath: string, ctor: TaskConstructor): this;
  registerAll(entries: Record<string, TaskConstructor>): this;
  registerClassPaths(entries: Record<string, TaskConstructor>): this;
  async resolve(classPathOrName: string): Promise<TaskConstructor>;
  async create(
    classPathOrName: string,
    ctx: TaskContext,
    options: Record<string, unknown>,
  ): Promise<BaseTask>;
  listRegistered(): string[];
}
```

| Method | Description |
|--------|-------------|
| `register(name, ctor)` | Register by short name |
| `registerClassPath(path, ctor)` | Register by dotted class path |
| `registerAll(entries)` | Bulk register by short name |
| `registerClassPaths(entries)` | Bulk register by class path |
| `resolve(nameOrPath)` | Look up a constructor. Falls back to dynamic filesystem import. |
| `create(nameOrPath, ctx, opts)` | Resolve + instantiate in one call |
| `listRegistered()` | Return all registered names and class paths |

**`TaskConstructor`**

```typescript
type TaskConstructor = new (
  ctx: TaskContext,
  options: Record<string, unknown>,
) => BaseTask;
```

---

## Flow

*Import from `@db-lyon/flowkit` or `@db-lyon/flowkit/flow`*

### `FlowRunner`

Orchestration engine that executes flows.

```typescript
class FlowRunner {
  constructor(config: FlowRunnerConfig);
  async run(options: FlowRunOptions): Promise<FlowRunResult>;
  resolveExecutionPlan(
    flow: FlowDefinition,
    skipSet: Set<string>,
  ): PlanStep[];
}
```

---

### `FlowRunnerConfig`

```typescript
interface FlowRunnerConfig {
  tasks: Record<string, TaskDefinition>;
  flows: Record<string, FlowDefinition>;
  registry: TaskRegistry;
  context: TaskContext;
  hooks?: FlowRunnerHooks;
  logger?: Logger;
}
```

---

### `FlowRunOptions`

```typescript
interface FlowRunOptions {
  flowName: string;       // name of the flow to execute
  skip?: string[];        // task names or step numbers to skip
  plan?: boolean;         // return plan without executing
}
```

---

### `FlowRunResult`

```typescript
interface FlowRunResult {
  success: boolean;
  steps: FlowStepResult[];
  duration: number;       // total milliseconds
  error?: Error;          // first error that caused failure
}
```

---

### `FlowStepResult`

```typescript
interface FlowStepResult {
  stepNumber: number;
  type: 'task' | 'flow';
  name: string;
  result?: TaskResult;
  skipped: boolean;
  duration: number;       // milliseconds
}
```

---

### `PlanStep`

Represents a step in the execution plan (returned by plan mode or passed to hooks).

```typescript
interface PlanStep {
  stepNumber: number;
  type: 'task' | 'flow';
  name: string;
  skipped: boolean;
  options?: Record<string, unknown>;
}
```

---

### `FlowRunnerHooks`

```typescript
interface FlowRunnerHooks {
  beforeRun?(flowName: string, plan: PlanStep[]): Promise<void>;
  afterRun?(result: FlowRunResult): Promise<void>;
  beforeStep?(step: PlanStep): Promise<void>;
  afterStep?(step: PlanStep, result: FlowStepResult): Promise<void>;
  onStepError?(
    step: PlanStep,
    error: Error,
    completed: FlowStepResult[],
  ): Promise<void>;
}
```

| Hook | Fires | Scope |
|------|-------|-------|
| `beforeRun` | Once before execution starts | Top-level flow only |
| `afterRun` | Once after execution completes | Top-level flow only |
| `beforeStep` | Before each step executes | All steps (including nested) |
| `afterStep` | After each step completes | All steps (including nested) |
| `onStepError` | When a step fails | All steps (including nested) |

---

## DAG

*Import from `@db-lyon/flowkit` or `@db-lyon/flowkit/dag`*

### `topologicalSort(nodes)`

Sort a directed acyclic graph in dependency order (dependencies first).

```typescript
function topologicalSort<T>(nodes: DagNode<T>[]): DagNode<T>[]
```

Throws `CircularDependencyError` if the graph has cycles. Throws `MissingDependencyError` if a node references a dependency that doesn't exist.

---

### `DagNode<T>`

```typescript
interface DagNode<T = unknown> {
  id: string;
  dependencies: string[];
  data: T;
}
```

---

### `CircularDependencyError`

```typescript
class CircularDependencyError extends Error {
  cycle: string[];  // e.g., ['a', 'b', 'c', 'a']
}
```

---

### `MissingDependencyError`

```typescript
class MissingDependencyError extends Error {
  nodeId: string;     // the node that has the bad dependency
  missingDep: string; // the dependency that doesn't exist
}
```

---

## Logger

*Import from `@db-lyon/flowkit`*

### `Logger` interface

```typescript
interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(bindings: Record<string, unknown>): Logger;
}
```

Compatible with pino, winston, and similar structured loggers.

### `noopLogger`

A silent logger that discards all output. Used as the default when no logger is provided.

```typescript
const noopLogger: Logger;
```
