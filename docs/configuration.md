# Configuration

Flowkit uses YAML files for declarative configuration, with support for layered merging, environment overlays, and schema validation via Zod.

## YAML schema

A flowkit config file has two top-level keys:

```yaml
tasks:
  # ...
flows:
  # ...
```

Both default to `{}` if omitted.

### Task definition

```yaml
tasks:
  my_task:
    class_path: path.to.MyTask    # required — how to resolve the task class
    description: What this task does  # optional
    group: etl                     # optional — logical grouping label
    options:                       # optional — default options passed to the task
      key: value
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `class_path` | `string` | yes | Dotted path to the task class, or a registered name |
| `description` | `string` | no | Human-readable description |
| `group` | `string` | no | Logical grouping label |
| `options` | `object` | no | Default options (merged with step-level overrides) |
| `options_schema` | `object` | no | Declared options, refining the class's `optionsSchema`. See [Declaring options](custom-tasks.md#declaring-options) |
| `outputs` | `object` | no | Declared `data` outputs (`type`, `description`), for `describe`. Not enforced |
| `deprecated` | `boolean \| string` | no | Mark the task deprecated. See [Deprecation](#deprecation) |
| `replaced_by` | `string` | no | The task to use instead, named in the deprecation warning |

### Flow definition

```yaml
flows:
  my_flow:
    description: What this flow does  # required
    steps:
      1:
        task: my_task               # reference a task by name
        options:                    # optional — override/extend task defaults
          key: override_value
      2:
        flow: other_flow            # reference another flow (nesting)
      3:
        task: None                  # skip sentinel — step is always skipped
      4:
        flow: None                  # same, for a step that referenced a flow
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | `string` | yes | Human-readable flow description |
| `steps` | `object` | yes | Steps keyed by number (execution order) |
| `options_scope` | `'flat' \| 'step'` | no | How runtime `params` reach steps. See [Step-scoped runtime options](#step-scoped-runtime-options) |
| `deprecated` | `boolean \| string` | no | Mark the flow deprecated. See [Deprecation](#deprecation) |
| `replaced_by` | `string` | no | The flow to use instead, named in the deprecation warning |

### Flow step

Each step must have exactly one of `task` or `flow` (mutually exclusive), unless `task: None` or `flow: None` is used to mark a skipped step. `None` in either slot wins, so an overlay can switch off an inherited step by number whichever key the base used.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `task` | `string` | one of task/flow | Task name to execute |
| `flow` | `string` | one of task/flow | Nested flow name to execute |
| `options` | `object` | no | Override options for this step |

Step numbers are sorted numerically at execution time, so `1, 2, 10` runs in that order (not lexicographic `1, 10, 2`).

### Options merging

When a step executes, options are merged as: **task defaults** + **step overrides** (step wins):

```yaml
tasks:
  deploy:
    class_path: tasks.Deploy
    options:
      environment: staging
      notify: true

flows:
  release:
    description: Deploy to production
    steps:
      1:
        task: deploy
        options:
          environment: production    # overrides "staging"
          # notify: true is inherited from task defaults
```

Runtime parameters passed to `FlowRunner.run({ params })` merge on top with the highest priority (**task defaults < step overrides < runtime params**).

### Step-scoped runtime options

By default runtime `params` are **flat**: every key is merged into every step's
options, so `params: { environment: 'prod' }` reaches the build, the test and
the deploy alike. Opt in to the **step** scope to address each step instead:

```yaml
flows:
  release:
    options_scope: step          # or FlowRunnerConfig.optionsScope / run({ optionsScope })
    steps:
      1: { task: build }
      2: { flow: ci }            # ci: 1: lint, 2: test
      3: { task: deploy }
```

```typescript
await runner.run({
  flowName: 'release',
  params: {
    deploy: { environment: 'prod' },   // every step running the `deploy` task
    '2/2': { coverage: 90 },           // step 2 of the flow run by step 2 (ci's `test`)
    '1': { target: 'release' },        // main step 1
  },
});
```

Under the step scope each `params` key is a **selector** and its value an
options object:

| Selector | Matches |
|----------|---------|
| a task name, e.g. `deploy` or `asset.list` (dots are part of the name) | every step running that task, anywhere in the run: main steps, nested flows and hook steps |
| a step path, e.g. `3` or `2/1` | one main step; `/` descends into the flow a step runs, as in an expanded plan's `path` |

- A path is more specific than a name: when both address a step, the path's
  value wins on a shared key.
- The scoped value takes the runtime slot in the precedence order, so it
  still overrides task defaults, enclosing-flow overrides and step options.
- A selector that matches no task name or step path, or a value that is not an
  object, fails the run (and a plan) before anything starts, naming each bad key.
- Hook steps are addressed by task name only.
- The scope is fixed by the flow the run starts on. Nested flows follow it and
  their own `options_scope` is ignored.
- `when:` expressions and `conditionEvaluator` still receive `params` as passed.

Resolution order for the scope: `run({ optionsScope })`, then the flow's
`options_scope`, then `FlowRunnerConfig.optionsScope`, then `flat`. Nothing
changes unless one of them says `step`.

### Step references

Option values may reference the output of earlier steps in the same flow using `${steps.<id>.<path>}`:

```yaml
flows:
  chain:
    description: Pass one step's output into the next
    steps:
      1:
        task: build
        options:
          target: plugin
      2:
        task: deploy
        options:
          artifact: ${steps.1.path}            # whole-value → raw type preserved
          message:  "deployed ${steps.build.version}"  # embedded → stringified
```

- **`<id>`** is a step number (`1`) or a task name (`build`, `level.place_actor`). Task names with dots are matched longest-prefix-first.
- **`<path>`** is a dot path into the step's `result.data`.
- When a task name appears in multiple steps, references resolve to the **most recently completed** one.
- A reference that fills the entire string (`"${steps.1.path}"`) is replaced with the raw value, so objects and arrays round-trip. References embedded inside a larger string are stringified.
- References that can't be resolved throw and fail the step.

References resolve just before the step runs, against the results of already-completed steps in the current flow. Nested flows have their own reference scope — they don't see their parent flow's steps.

### Flow-level hooks

A flow can attach steps that run around the main step sequence, keyed by flow outcome:

```yaml
flows:
  deploy:
    description: Deploy to prod
    on_start:   [ { task: notify, options: { msg: "starting" } } ]
    on_success: [ { task: notify, options: { msg: "done ${steps.build.version}" } } ]
    on_failure: [ { task: notify, options: { msg: "failed: ${error.message}" } } ]
    finally:    [ { task: cleanup } ]
    steps:
      1: { task: build }
      2: { task: push }
```

- **`on_start`** runs before any step. Its failure aborts the flow before steps execute.
- **`on_success`** runs when all steps succeed.
- **`on_failure`** runs when any step fails. It can reference the error via the `${error.*}` namespace.
- **`finally`** runs after either outcome, after `on_success`/`on_failure`.

Hook steps share the full step execution model — same task dispatch, same option merging, same runtime params, same `${steps.X.y}` resolution. Inside `on_failure` and `finally`, the `${error.message}`, `${error.name}`, `${error.stack}`, and `${error.step}` references resolve to the failure that triggered them.

Hook failures are captured in `FlowRunResult.hookErrors` but **do not** change the flow's primary success/failure outcome — a failed notifier doesn't rewrite history.

### Per-step retry

A step can retry itself on failure:

```yaml
steps:
  1:
    task: flaky_network_call
    retries: 3            # up to 4 total attempts
    retryDelay: 500       # ms between attempts
    retryOn: "timeout"    # only retry when the error message contains this substring
```

Omit `retryOn` to retry on any error. The number of attempts taken appears on `FlowStepResult.attempts`.

### Rollback on failure

Mutating tasks may return a `rollback` record on their `TaskResult` pointing to an inverse task:

```ts
return {
  success: true,
  data: { label: 'MyPillar' },
  rollback: { taskName: 'delete_actor', payload: { label: 'MyPillar' } },
};
```

When a flow sets `rollback_on_failure: true` (or the caller passes it on `FlowRunRunOptions`) and a later step fails, the runner invokes the collected rollback records in **reverse order**, best-effort: it continues past individual failures and reports all errors in `FlowRunResult.rollback`.

```yaml
flows:
  safe_deploy:
    description: Deploy with rollback on failure
    rollback_on_failure: true
    steps:
      1: { task: create_thing, options: { label: A } }
      2: { task: create_thing, options: { label: B } }
      3: { task: finalize }  # if this fails, thing:B then thing:A are rolled back
```

Rollback runs after `on_failure` and before `finally`. Nested flow steps' rollback records bubble up to the parent flow so a single `rollback_on_failure` setting covers the whole tree.

The outermost flow with rollback armed is the one that invokes them. A nested flow that fails while an ancestor has rollback armed does not unwind its own records: it already handed them upward, and the ancestor holds the full reverse order. Unwinding at both levels would run each inverse twice against state the first pass had already restored, which for a delete-shaped inverse is a second deletion. A nested flow whose ancestors asked for no rollback still unwinds its own, so `rollback_on_failure` on a child flow means what it says. A flow run from an `on_failure` or `finally` hook always owns its own unwind, because hook records are not bubbled into the host run.

A **failing** task may attach a rollback record too, for the part of its mutation that landed before it gave up:

```ts
return {
  success: false,
  error: new Error('renamed 3 of 7 packages, then the batch aborted'),
  rollback: { taskName: 'rename_back', payload: { moved: ['a', 'b', 'c'] } },
};
```

That record is collected like any other. Because the failing step is the last one collected and records are invoked in reverse order, its inverse runs **first**, before the inverses of the steps that came before it. That is the order the partial write needs: undoing an earlier step while the half-applied change is still in place is what leaves the inconsistent state behind. A record attached to a failure describes only the part that applied, so build its payload from what actually landed. Entries in `rollback.errors` that came from a failing step are marked `fromFailedStep: true`.

A step that fails with no rollback record contributes nothing, so a task that only records on success behaves exactly as before.

The inverse task's configured `options` are resolved for `${ns.path}` references as usual, then the `payload` is merged over them. A payload is runtime data the task recorded, not configuration, so it is passed through **literally** — a `${...}` captured inside one reaches the inverse task unchanged.

Rollback runs outside any step's scope, so those configured `options` resolve against the host namespaces only. A `${steps.…}` or `${error.…}` in an inverse task's defaults has nothing to resolve against and fails that one rollback record (it is reported in `rollback.errors`; the remaining records still run). Keep inverse-task defaults to host namespaces and put step-derived values in the `payload`.

### `agent_prompt` — LLM step

When a `LLMProvider` is attached to the context under `ctx.llm`, the built-in `agent_prompt` task invokes it:

```yaml
steps:
  1:
    task: agent_prompt
    options:
      system: "You are a deployment triage agent."
      prompt: "Last error: ${error.message}. Suggest a fix."
      model: claude-opus-4-6
      maxTokens: 512
      schema: { type: object, properties: { fix: { type: string } } }  # optional
```

Returns `{ text, parsed?, usage? }`. Provider failures become step failures; missing provider is a clear error.

### Deprecation

Tasks and flows can be retired without breaking the configs that still use
them. A deprecated task or flow still runs; the run and the plan say so:

```yaml
tasks:
  deploy_legacy:
    class_path: tasks.Deploy
    deprecated: "Targets the old cluster."   # or just `true`
    replaced_by: deploy

flows:
  release_v1:
    deprecated: true
    replaced_by: release
    steps:
      1: { task: deploy_legacy }
```

- A run collects a structured warning for every deprecated task or flow it
  ran, on the step's `result.warnings` and, without repeats, on
  `FlowRunResult.warnings`:
  `{ code: 'deprecated', kind: 'task', name: 'deploy_legacy', replacedBy: 'deploy', message: 'Task "deploy_legacy" is deprecated: Targets the old cluster. Use "deploy" instead.' }`.
  `runTask` puts it on the returned `TaskResult.warnings`. The runner's logger
  gets it at `warn` too.
- Plan mode marks each deprecated row with `deprecated` and `replaced_by` and
  returns the same warnings on the plan's `warnings`. Skipped steps are not
  reported.
- A task class can declare `static deprecated` and `static replacedBy`; a
  definition's `deprecated` (including `false`) overrides the class.
- `FlowRunner.describeTask(name)` and `describeFlow(name)` expose both fields.

## Config layering

`loadConfig()` merges up to four layers, left to right:

```
defaults (code)  →  base file  →  env overlay  →  local overlay
```

| Layer | Source | Purpose |
|-------|--------|---------|
| 1. Defaults | `options.defaults` in code | Hardcoded fallbacks |
| 2. Base file | `pipeline.yml` | Project-level config (committed) |
| 3. Env overlay | `pipeline.staging.yml` | Environment-specific overrides |
| 4. Local overlay | `pipeline.local.yml` | Developer-specific overrides (gitignored) |

### Example

```typescript
import { loadConfig, EngineConfigSchema } from '@db-lyon/flowkit';

const { config, configDir } = loadConfig({
  filename: 'pipeline.yml',
  schema: EngineConfigSchema,

  // Hardcoded defaults merged under everything
  defaults: {
    tasks: {},
    flows: {},
  },

  // Environment name — loads pipeline.{env}.yml
  env: process.env.NODE_ENV,
  // Or read from a specific env var:
  // envVar: 'APP_ENV',

  // Directory to search (default: cwd)
  configDir: './config',
});
```

The `configDir` return value tells you where the config was loaded from.

### Environment selection

You can specify the environment explicitly or via an env var:

```typescript
// Explicit
loadConfig({ filename: 'app.yml', schema, env: 'production' });

// From env var — reads process.env.APP_ENV
loadConfig({ filename: 'app.yml', schema, envVar: 'APP_ENV' });
```

If both `env` and `envVar` are provided, `env` takes precedence.

## Deep merge behavior

Config layers are merged using `deepMerge()`, which follows these rules:

| Scenario | Behavior |
|----------|----------|
| Objects | Recursive key-by-key merge (override wins per-key) |
| Arrays | Override replaces the base array |
| Scalars | Override wins |
| `null` override | Explicitly nullifies the base value |
| `undefined` override | No-op (base preserved) |

### Array append mode

By default, arrays in an overlay replace the base array entirely. To append instead, add `__merge: append` to the override array:

```yaml
# base.yml
plugins:
  - eslint
  - prettier

# base.local.yml
plugins:
  - __merge: append
  - my-custom-plugin
```

Result: `['eslint', 'prettier', 'my-custom-plugin']`

The `__merge` annotation is stripped from the final array.

## Strict validation

Zod drops keys a schema does not declare, so a typo such as `retires: 3` or
`ignore_failur: true` loads cleanly and then does nothing. Pass `strict` to
make the loader reject them instead:

```typescript
const { config } = loadConfig({
  filename: 'pipeline.yml',
  schema: EngineConfigSchema,
  strict: true,
});
// UnknownConfigKeyError: Unknown config key:
//   flows.ci.steps.2.retires (did you mean "retries"?)
```

The check runs on the merged layers, before the schema parses them, and walks
the schema you pass: tasks, flows, steps, hook steps, agents, agent tools and
budgets, plus any section a host adds with `EngineConfigSchema.extend(...)`.
Free-form maps (`options`, an agent's `schema`, a tool's `parameters`) are not
checked, and neither is any object schema declared `.passthrough()` or with a
`.catchall()`.

A host that keeps sections in the same file but does not declare them in the
schema it passes lists them as `passthroughKeys`. Only top-level keys can be
exempted this way:

```typescript
loadConfig({
  filename: 'ue-mcp.yml',
  schema: HostConfigSchema,
  strict: { passthroughKeys: ['bridge', 'editor'] },
});
```

Strict validation is opt-in. Without `strict`, unknown keys are dropped
exactly as before. `findUnknownKeys(schema, value)` and
`assertKnownKeys(schema, value)` run the same check on config that does not
come through `loadConfig`.

## Finding config files

`findConfigFile()` walks up parent directories to locate a file:

```typescript
import { findConfigFile } from '@db-lyon/flowkit';

const path = findConfigFile('pipeline.yml');
// Searches cwd, then parent, then grandparent, etc.
```

Throws if the file isn't found in any ancestor directory.

## Loading raw YAML

For cases where you need the raw parsed YAML without schema validation:

```typescript
import { loadRawYaml } from '@db-lyon/flowkit';

const data = loadRawYaml('/path/to/file.yml');
```

## Custom schemas

`EngineConfigSchema` is the minimal schema flowkit needs. You can extend it for your own config sections:

```typescript
import { z } from 'zod';
import { EngineConfigSchema } from '@db-lyon/flowkit';

const AppConfigSchema = EngineConfigSchema.extend({
  database: z.object({
    host: z.string(),
    port: z.number().default(5432),
  }),
  features: z.record(z.boolean()).default({}),
});

const { config } = loadConfig({
  filename: 'app.yml',
  schema: AppConfigSchema,
});

// config.tasks, config.flows, config.database, config.features
```

### Reusing the step and flow schemas

A host that declares flows outside the main config file (a plugin manifest, a
flow built in code) should validate them with flowkit's own schemas rather than
a copy, so every step field (`when`, `ignore_failure`, `retries`, `None` skips,
and whatever is added later) keeps working there too.

```typescript
import { FlowDefinitionSchema, FlowStepObjectSchema, refineFlowStep } from '@db-lyon/flowkit';

// A whole flow, with a host-only field.
const ManifestFlowSchema = FlowDefinitionSchema.extend({ group: z.string().optional() });

// A step with a host-only field. `FlowStepSchema` is refined and cannot be
// extended, so extend the object form and refine it again.
const ManifestStepSchema = refineFlowStep(FlowStepObjectSchema.extend({ label: z.string().optional() }));
```
