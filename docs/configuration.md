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
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | `string` | yes | Human-readable flow description |
| `steps` | `object` | yes | Steps keyed by number (execution order) |

### Flow step

Each step must have exactly one of `task` or `flow` (mutually exclusive), unless `task: None` is used to mark a skipped step.

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
