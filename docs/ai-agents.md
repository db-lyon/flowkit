# AI agents

Flowkit can drive LLM calls as ordinary steps. A flow can mix deterministic
tasks with steps that prompt a model, extract structured data, or run a
tool-calling agent — and the model output flows into later steps through the
same `${steps.<id>.<path>}` references as anything else.

Flowkit ships **no SDK dependencies**. You supply a provider that adapts your
model of choice to a small neutral contract; the engine stays model-agnostic.

## Wiring a provider

Implement `LLMProvider` and attach it to the task context as `llm`. The
provider's only job is to translate flowkit's neutral request/response shape to
and from your SDK.

```typescript
import { FlowRunner, type LLMProvider } from '@db-lyon/flowkit';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const provider: LLMProvider = {
  async complete(req) {
    const res = await client.messages.create(
      {
        model: req.model ?? 'claude-opus-4-8',
        max_tokens: req.maxTokens ?? 1024,
        system: req.system,
        temperature: req.temperature,
        messages: toAnthropicMessages(req),   // map req.prompt / req.messages
        tools: req.tools?.map(toAnthropicTool),
      },
      { signal: req.signal },                  // honor cancellation/timeout
    );
    return {
      text: textOf(res),
      toolCalls: toolCallsOf(res),
      finishReason: res.stop_reason ?? undefined,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      model: res.model,
    };
  },
};

const runner = new FlowRunner({
  tasks: config.tasks,
  flows: config.flows,
  registry,
  context: { logger, llm: provider },          // <- the seam
});
```

A provider may ignore any field it does not support. A request that only sets
`prompt` works against the simplest possible adapter.

> Model id, pricing, and SDK specifics for Claude live in the `claude-api`
> reference — don't hard-code a stale model id.

## Single-shot prompts — `AgentPromptTask`

`class_path: agent_prompt`. One prompt in, one response out. Register it:

```typescript
import { AgentPromptTask } from '@db-lyon/flowkit';
registry.register('agent_prompt', AgentPromptTask as any);
```

```yaml
tasks:
  summarize:
    class_path: agent_prompt
    options:
      system: You extract action items from meeting notes.
      prompt: "Summarize:\n${steps.1.data.text}"
```

`result.data`: `text` (always), plus `parsed`, `usage`, `finishReason`, `model`,
and `truncated` when present.

### Structured output

Pass a JSON Schema. The response is validated against it; on a mismatch the
model is re-prompted with the concrete validation errors (the **repair loop**)
before the step fails.

```yaml
tasks:
  extract:
    class_path: agent_prompt
    options:
      prompt: "Pull the ticket fields from:\n${steps.1.data.text}"
      schema:
        type: object
        required: [title, priority]
        properties:
          title: { type: string }
          priority: { type: string, enum: [low, medium, high] }
```

On success `result.data.parsed` holds the validated object. If the model never
conforms, the step fails with a `StructuredOutputError` and `result.data.text`
carries the last raw output for debugging.

The bundled validator covers the JSON Schema subset used for structured output
(`type`, `enum`, `const`, `required`, `properties`, `items`,
`additionalProperties`, length/number bounds, `anyOf`/`oneOf`/`allOf`/`not`,
and OpenAPI-style `nullable`). Unknown keywords are ignored rather than
rejected.

## Tool-calling agents — `AgentTask`

`class_path: agent`. A multi-turn loop: the model requests tool calls, the agent
runs them, feeds the results back, and repeats until the model gives a final
answer or `maxIterations` is hit.

```typescript
import { AgentTask } from '@db-lyon/flowkit';
registry.register('agent', AgentTask as any);
```

A tool references an existing flowkit primitive — a `task:`, a `flow:`, or
another `agent:` — or a **context handler** (a function on `ctx.agentTools`,
matched by `name:`). Tool dispatch reuses the registry and options machinery, so
there is no separate tool concept to maintain. A task-backed tool inherits its
configured `class_path` and `options` defaults, with the model's arguments
layered on top, so a task behaves the same as a tool as it does as a flow step.
`flow:` and `agent:` tools require a `FlowRunner` context (see "Declarative
agents" below).

```yaml
tasks:
  research:
    class_path: agent
    options:
      system: You answer questions using the available tools.
      prompt: "How many open PRs touch the auth module?"
      maxIterations: 6
      tools:
        - task: shell                 # a flowkit task, exposed to the model
          name: run_command
          description: Run a read-only shell command and return its output.
          parameters:
            type: object
            required: [command]
            properties:
              command: { type: string }
        - name: search_docs           # a ctx.agentTools handler
          description: Full-text search the internal docs.
          parameters:
            type: object
            required: [query]
            properties:
              query: { type: string }
```

```typescript
const runner = new FlowRunner({
  /* ... */
  context: {
    logger,
    llm: provider,
    agentTools: {
      search_docs: async ({ query }) => docs.search(query as string),
    },
  },
});
```

`result.data`: `text` (final answer), `iterations`, `toolCalls` (every call with
its name, arguments, `ok`, and truncated `result`), `usage` (aggregated), and
`finishReason`. Add a `schema` option to get a validated `parsed` final answer —
the agent reuses the final turn when it already conforms and only spends an
extra round-trip on the structured pass when it does not.

### Parallel tool calls

When the model requests several tools in one turn — including several sub-agents
— they execute concurrently, bounded by `maxConcurrency` (default 4), and their
results are reassembled in call order so the conversation stays deterministic.
This is the only concurrency mechanism: there is no parallel flow-step
construct. Two parallel agentic loops are modeled as two sub-agents of one
coordinating agent.

### Tool safety

- **Allowlist** — only declared tools are callable. An unknown tool name is
  reported back to the model, never executed.
- **Argument validation** — the model's arguments are checked against each
  tool's `parameters` schema before the tool runs; invalid arguments are fed
  back for the model to correct.
- **Bounded results** — each tool result is truncated to
  `maxToolResultChars` (default 8000).
- **Bounded loops** — `maxIterations` (default 8) caps model turns; exceeding it
  fails the step.
- **Bounded spend** — `tokenBudget` caps total input+output tokens across the
  whole loop (and its sub-agents); reaching it fails the step.
- **Bounded recursion** — `maxAgentDepth` (default 6) caps how deep
  agents-calling-agents may nest.

## Declarative agents

Inline `agent` tasks are fine for one-offs, but agents you reuse across flows
(and that call each other) belong in the `agents:` root key of your config. It is
additive — CumulusCI never had it, so `tasks:` and `flows:` stay byte-identical.

```yaml
agents:
  developer:
    description: Researches and implements a change.
    model: claude-opus-4-8
    system: You implement the requested change using the available tools.
    tools:
      - task: shell
        name: run_command
        parameters:
          type: object
          required: [command]
          properties: { command: { type: string } }
    schema:
      type: object
      required: [summary]
      properties: { summary: { type: string } }
    budget:
      maxIterations: 8
      tokenBudget: 200000
      maxConcurrency: 4
      maxAgentDepth: 4
```

Wire the config and a provider into the runner. The runner compiles each agent,
registers the `agent` class, and enables `flow:`/`agent:` tools:

```typescript
const runner = new FlowRunner({
  tasks: config.tasks,
  flows: config.flows,
  agents: config.agents,            // <- the AI-native layer
  registry,
  context: { logger, llm: provider },
});
```

A declared agent is usable two ways, both through machinery that already exists:

- **As a flow step** — reference it like any task; supply its prompt in the step:

  ```yaml
  flows:
    ship:
      steps:
        1: { flow: dev_org }
        2: { task: developer, options: { prompt: "Implement ${steps.1.data.ticket}" } }
        3: { task: submit_pr }
  ```

- **As another agent's tool** — list it under `tools:` with `agent:`. When the
  parent calls it, the model's `prompt` argument becomes the sub-agent's input,
  and the sub-agent's result is fed back. Recursion is bounded by `maxAgentDepth`.

### The shape this targets

A flow that builds a dev org, researches and develops (with parallel sub-agents),
deploys, iterates on failed deploys, runs tests, iterates on failed tests, and
opens a PR collapses to a sequential flow spine where every loop and fork lives
inside an agent:

```yaml
agents:
  developer: { system: "...", tools: [ { agent: researcher }, { task: shell } ] }
  researcher: { system: "..." }              # fanned out as parallel sub-agents
  deployer:   { system: "...", tools: [ { task: deploy_scratch } ] }  # edit/redeploy loop
  tester:     { system: "...", tools: [ { task: run_tests }, { task: shell } ] }  # fix/retest loop

flows:
  ship:
    steps:
      1: { flow: dev_org }
      2: { task: developer, options: { prompt: "..." } }
      3: { task: deployer,  options: { prompt: "Deploy and fix failures." } }
      4: { task: tester,    options: { prompt: "Make the tests pass." } }
      5: { task: submit_pr }
```

Steps 3 and 4 are not flow loops. The fix-retest cycle is each agent's own
tool-use loop. Parallel research in step 2 is the developer emitting several
`researcher` sub-agent calls in one turn. No `loop:` and no parallel flow step
appear anywhere.

## Robustness controls

These option fields apply to both `agent_prompt` and `agent`:

| Option            | Default | Effect                                                        |
| ----------------- | ------- | ------------------------------------------------------------- |
| `timeout`         | 60000   | Per-call timeout in ms; the provider's `signal` is aborted.   |
| `retries`         | 2       | Transport retries on failure, with exponential backoff.       |
| `retryDelay`      | 500     | Base backoff in ms; doubles each retry.                       |
| `repairAttempts`  | 1       | Structured-output re-prompts before failing.                  |
| `maxOutputChars`  | 0       | Cap on response text length (0 = unlimited).                  |

Programmatic callers can use `runCompletion(provider, request, options, logger)`
directly — it is the shared core both tasks build on, and it accepts a
`retryOn(err)` predicate for fine-grained retry control.

## Security notes

- **Prompt injection.** Templating prior step output (`${steps...}`) or tool
  results into a prompt means untrusted text can reach the model. Treat model
  output as untrusted: validate it (use `schema`), and scope what task-backed
  tools can do — an `agent` whose toolbox includes `shell` can run whatever the
  model asks. Prefer narrow, read-only tools.
- **Secret hygiene.** The tasks log prompts only at `debug`, and previews are
  whitespace-collapsed and length-capped. Use `redact()` before logging
  provider config so API keys and tokens never reach your logs.
- **Resource bounds.** `timeout`, `maxOutputChars`, `maxToolResultChars`, and
  `maxIterations` together bound how long a step runs, how much it can emit, and
  how far an agent can wander.
