import type { Logger } from '../logger.js';
import { noopLogger } from '../logger.js';
import type {
  TaskDefinition,
  FlowDefinition,
  FlowStep,
  AgentDefinition,
  StepCheck,
} from '../config/schema.js';
import type {
  TaskResult,
  RollbackRecord,
  TaskContext,
  TaskContextInput,
  ResolvedTaskContext,
  ExecutionPhase,
} from '../task/base-task.js';
import { DEFAULT_EXECUTION_PHASE } from '../task/base-task.js';
import type { TaskRegistry, TaskConstructor, TaskDescription } from '../task/registry.js';
import {
  assertTaskOptions,
  mergeOptionSpecs,
  taskClassMetadata,
  TaskOptionsError,
} from '../task/options-schema.js';
import { deprecationWarning, mergeWarnings, type RunWarning } from '../task/warnings.js';
import type {
  ChildPlanEntry,
  ChildStepSpec,
  ChildStepTarget,
  ExpandContext,
  ExpandFunction,
} from '../task/composite.js';
import { AgentTask, type AgentTaskOptions } from '../task/agent-task.js';
import type { TokenLedger } from '../task/token-ledger.js';
import { resolveReferences, type ReferenceContext } from '../references.js';
import { resolveTaskDefinition, resolveTaskCall, type ResolvedTask } from '../task/task-resolution.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HookPhase = 'on_start' | 'on_success' | 'on_failure' | 'finally';

/**
 * Per-task option overrides injected by an enclosing flow step, keyed by the
 * inner task (or flow) name. When a flow step carries `options`, those options
 * are interpreted as this map and threaded down into the nested flow.
 */
export type ParentOptions = Record<string, Record<string, unknown>>;

/** How runtime `params` reach steps. See `FlowRunOptions.optionsScope`. */
export type OptionsScope = 'flat' | 'step';

export interface FlowRunOptions {
  flowName: string;
  skip?: string[];
  plan?: boolean;
  /**
   * Runtime parameters, the highest-precedence option layer. Under the default
   * `flat` scope every key is merged into every step's options. Under the
   * `step` scope each key is a step selector and its value an options object
   * for the matching steps only; see `optionsScope`.
   */
  params?: Record<string, unknown>;
  /**
   * How `params` are addressed. `flat` (default) spreads every key into every
   * step. `step` reads each key as a selector:
   *
   * - a task name (`deploy`, `asset.list`): every step running that task,
   *   anywhere in the run, including nested flows and hook steps;
   * - a step path (`2`, or `2/1` for step 1 of the flow run by step 2): that
   *   one main step.
   *
   * and each value as the options for the matching steps. A path is more
   * specific than a name and wins on a shared key. A selector matching no step,
   * or a value that is not an object, fails the run before anything starts.
   *
   * Precedence: this option, then the flow's `options_scope`, then
   * `FlowRunnerConfig.optionsScope`, then `flat`. It is fixed by the flow the
   * run starts on; nested flows follow it.
   */
  optionsScope?: OptionsScope;
  /** If true, invoke rollback records from completed steps in reverse order on failure. */
  rollback_on_failure?: boolean;
  /**
   * Plan mode only: recursively expand nested-flow steps into their child steps
   * (each annotated with a hierarchical `path`). Default false preserves the
   * flat, one-line-per-flow-step plan.
   */
  expandNestedFlows?: boolean;
  /**
   * Plan mode only: expand composite task steps whose class declares a static
   * `expand` into the children it reports, each with a hierarchical `path`.
   * A composite whose `expand` returns `null` is marked `composite: 'opaque'`.
   */
  expandComposites?: boolean;
  /**
   * Internal. Set by the runner on a nested run when an ancestor flow has
   * rollback armed and will therefore invoke this child's records itself.
   *
   * A child bubbles its records to the parent, so without this both levels
   * unwound the same record: the child on its own failure, the parent again on
   * the nested step's. An undo that runs twice against state already restored
   * is not a rollback, and for a delete-shaped inverse it is a second deletion.
   * The outermost armed flow owns the unwind, because it is also the only one
   * holding the full reverse order.
   */
  rollbackOwnedByAncestor?: boolean;
}

/** Context handed to a `conditionEvaluator` when resolving a string `when:` or check. */
export interface ConditionContext {
  steps: FlowStepResult[];
  params?: Record<string, unknown>;
  context: TaskContext;
  error?: { message: string; name: string; stack?: string; step?: string };
  /** The host namespaces from `FlowRunnerConfig.references`, when configured. */
  references?: Record<string, unknown>;
  /** The step being gated. Absent for a flow-level check. */
  step?: PlanStep;
  /** Set when the expression is a declared check rather than a `when:`. */
  check?: StepCheck;
  /** The flow whose step (or which itself) is being gated. */
  flowName?: string;
}

/**
 * One evaluated check. A run reports the ones that fired; `preflight` reports
 * every one it evaluated.
 */
export interface CheckOutcome {
  scope: 'flow' | 'step';
  flowName: string;
  /** For a step check: the step it gates. */
  stepNumber?: number;
  name?: string;
  /** For a step check: the step's path (`2/1`), as in an expanded plan. */
  path?: string;
  when: string | boolean;
  action: 'error' | 'warn' | 'skip';
  /** The declared message, else one naming the condition. */
  message: string;
  /** The condition was truthy, so the action applies. */
  triggered: boolean;
  /** The evaluator threw. `triggered` is false and the outcome is unknown. */
  error?: Error;
}

/** Raised (as a step or flow error) when an `action: error` check fires. */
export class CheckFailedError extends Error {
  readonly outcome: CheckOutcome;
  constructor(outcome: CheckOutcome) {
    super(outcome.message);
    this.name = 'CheckFailedError';
    this.outcome = outcome;
  }
}

/** One row of `FlowRunner.preflight`. */
export interface PreflightStep {
  stepNumber: number;
  type: 'task' | 'flow';
  name: string;
  /** Hierarchical id, as in an expanded plan (`2/1`); hooks use their phase (`finally/1`). */
  path: string;
  depth: number;
  phase?: HookPhase;
  /**
   * What the checks say would happen: `run`, `skip` (statically, or a `skip`
   * check fired), `error` (an `error` check fired) or `unknown` (a check could
   * not be evaluated before the run, e.g. it reads a step result).
   */
  status: 'run' | 'skip' | 'error' | 'unknown';
  skipReason?: 'static' | 'check';
  /** Every check evaluated for this row; for a flow step, the child flow's own checks too. */
  checks: CheckOutcome[];  /** The step's task or flow is deprecated (as in plan mode). */
  deprecated?: boolean | string;
  replaced_by?: string;
}

export interface PreflightResult {
  flowName: string;
  /** False when any `error` check fired (flow-level or on any step). */
  ok: boolean;
  /** The flow's own checks. */
  checks: CheckOutcome[];
  steps: PreflightStep[];
  /** Fired `warn` checks and deprecations, as a run would report them. */
  warnings?: RunWarning[];
}

/**
 * Evaluates a string `when:` expression to a boolean. Supply one to use a real
 * expression language (e.g. jinja-style with project/org context). When absent,
 * the runner falls back to resolving `${...}` references and testing truthiness.
 */
export type ConditionEvaluator = (
  expression: string,
  ctx: ConditionContext,
) => boolean | Promise<boolean>;

export interface FlowStepResult {
  stepNumber: number;
  type: 'task' | 'flow';
  name: string;
  result?: TaskResult;
  skipped: boolean;
  duration: number;
  /** Number of attempts including the first try (≥1 when executed). */
  attempts?: number;
  /**
   * Why the step was skipped: 'static' (skip list / task: None / flow: None),
   * 'when' (condition false) or 'check' (a `skip` check fired).
   */
  skipReason?: 'static' | 'when' | 'check';
  /**
   * Checks that fired for this step. For a flow step, those that fired inside
   * the child flow too.
   */
  checks?: CheckOutcome[];
  /** True when the step failed but `ignore_failure` let the flow continue. */
  ignoredFailure?: boolean;
  /**
   * For a `flow` step: the child flow's own step results. Kept so a caller can
   * say which child step failed and what it carried, instead of reading the
   * child's run error message as the only thing that crosses the boundary.
   */
  nestedSteps?: FlowStepResult[];
  /** For a composite's child step (`TaskResult.children`): its path, e.g. `2/1`. */
  path?: string;
}

export interface HookError {
  phase: HookPhase;
  name: string;
  error: Error;
}

export interface RollbackResult {
  attempted: number;
  succeeded: number;
  errors: {
    taskName: string;
    error: Error;
    /** True when the record came from a step that itself failed. */
    fromFailedStep?: boolean;
  }[];
}

/**
 * A rollback record harvested from a step, ready for `performRollback`.
 *
 * `fromFailedStep` marks a record that came off a step whose own verdict was
 * failure: the mutation partly landed and the task attached the inverse for the
 * part that did. The payload therefore describes the partial state, not a
 * completed change.
 */
interface HarvestedRollback {
  taskName: string;
  payload: Record<string, unknown>;
  fromFailedStep?: boolean;
}

export interface FlowRunResult {
  success: boolean;
  steps: FlowStepResult[];
  duration: number;
  error?: Error;
  /** Failures from hook steps (on_start / on_success / on_failure / finally). */
  hookErrors?: HookError[];
  /** Populated when rollback_on_failure ran. */
  rollback?: RollbackResult;
  /**
   * Non-fatal notices from the run or plan, in order and without repeats:
   * deprecated tasks and flows that ran (or would run), and fired `warn` checks.
   * Absent when there are none.
   */
  warnings?: RunWarning[];
  /** Every check that fired in the run, flow-level and per step, nested flows included. */
  checks?: CheckOutcome[];
}

export interface PlanStep {
  stepNumber: number;
  type: 'task' | 'flow';
  name: string;
  skipped: boolean;
  options?: Record<string, unknown>;
  retries?: number;
  retryDelay?: number;
  retryOn?: string;
  /** Conditional execution — evaluated at run time, so plan reports it unresolved. */
  when?: string | boolean;
  /** Whether a failure of this step is tolerated. */
  ignore_failure?: boolean;
  /** Declared checks, unevaluated. `FlowRunner.preflight` evaluates them. */
  checks?: StepCheck[];
  /** For hook steps: the phase they belong to. Undefined for main steps. */
  phase?: HookPhase;
  /** Hierarchical id (e.g. "2/1") — only set when a plan expands nested flows. */
  path?: string;
  /** Nesting depth — 0 for top-level, increments per expanded nested flow. */
  depth?: number;
  /**
   * Plan mode with `expandComposites`: `expanded` when the task's `expand`
   * listed its children (the rows that follow, one level deeper), `opaque` when
   * it declared `expand` but could not say.
   */
  composite?: 'expanded' | 'opaque';
  /** Plan mode only: the step's task or flow is deprecated. */
  deprecated?: boolean | string;
  /** Plan mode only: the deprecated target's declared replacement. */
  replaced_by?: string;
}

/**
 * A `${steps.<id>...}` reference in a flow that cannot be bound to exactly one
 * earlier step. See `FlowRunner.checkStepReferences`.
 */
export interface StepReferenceIssue {
  flowName: string;
  /** The step whose configuration holds the reference. */
  stepNumber: number;
  /** For a hook step: its phase. */
  phase?: HookPhase;
  /** The reference as written, e.g. `${steps.deploy.url}`. */
  reference: string;
  /**
   * `ambiguous`: a name used by more than one main step. `unknown`: no main
   * step has that number or name. `forward`: the step has not run yet at that
   * point (itself or a later one).
   */
  kind: 'ambiguous' | 'unknown' | 'forward';
  message: string;
}

/** A flow as `FlowRunner.describeFlow` reports it. */
export interface FlowDescription {
  name: string;
  description?: string;
  deprecated?: boolean | string;
  replaced_by?: string;
  rollback_on_failure?: boolean;
  options_scope?: OptionsScope;
  /** The flow's own declared checks. */
  checks?: StepCheck[];
  /** Main steps, in run order, as the planner resolves them. */
  steps: PlanStep[];
}

export interface FlowRunnerHooks {
  beforeRun?(flowName: string, plan: PlanStep[]): Promise<void>;
  afterRun?(result: FlowRunResult): Promise<void>;
  beforeStep?(step: PlanStep): Promise<void>;
  afterStep?(step: PlanStep, result: FlowStepResult): Promise<void>;
  onStepError?(step: PlanStep, error: Error, completed: FlowStepResult[]): Promise<void>;
}

/** Task-like object returned by a host-supplied nested agent factory. */
export interface NestedAgentTask {
  run(): Promise<TaskResult>;
}

/**
 * Creates the task used when an `AgentTask` invokes a configured sub-agent via
 * an `agent:` tool. The context and options have already been fully prepared by
 * `FlowRunner`; implementations should preserve them.
 */
export type NestedAgentTaskFactory = (
  ctx: ResolvedTaskContext & { readonly executionPhase: 'task' },
  options: AgentTaskOptions,
) => NestedAgentTask;

export interface FlowRunnerConfig {
  tasks: Record<string, TaskDefinition>;
  flows: Record<string, FlowDefinition>;
  registry: TaskRegistry;
  /** Host context; Flowkit supplies the per-invocation `executionPhase`. */
  context: TaskContextInput;
  hooks?: FlowRunnerHooks;
  logger?: Logger;
  /** Optional evaluator for string `when:` expressions. */
  conditionEvaluator?: ConditionEvaluator;
  /**
   * Host-supplied reference namespaces for `${ns.path}` interpolation in option
   * values, e.g. `{ project, org, env }`. `steps` and `error` are always built in.
   */
  references?: Record<string, unknown>;
  /**
   * Declarative agents. Each becomes runnable as a flow step (`task: <name>`)
   * and as another agent's `agent:` tool, and the runner wires `ctx.runFlow` /
   * `ctx.runAgent` so agents can call flows and sub-agents as tools.
   */
  agents?: Record<string, AgentDefinition>;
  /**
   * Optional factory for the task object used by configured sub-agents invoked
   * through `agent:` tools. Defaults to `(ctx, options) => new AgentTask(ctx,
   * options)`. Direct `AgentTask` construction is unchanged; configured agents
   * run as flow steps continue to use the registry path.
   */
  nestedAgentTaskFactory?: NestedAgentTaskFactory;
  /**
   * Default for how runtime `params` are addressed when neither the run nor
   * the flow says. See `FlowRunOptions.optionsScope`. Default `flat`.
   */
  optionsScope?: OptionsScope;
  /**
   * Refuse to run (or plan) a flow with a `${steps.<id>}` reference that is
   * ambiguous, unknown or forward, instead of letting it resolve at run time
   * to the most recent step of that name, or fail when reached. Checked for the
   * flow a run starts on and every flow nested under it. Default false.
   */
  strictStepReferences?: boolean;
}

/**
 * Where one task invocation sits, for the bookkeeping of its composite
 * children. Internal.
 */
interface InvocationSite {
  /** The invocation's step path (`2`, `2/1`); `''` for a direct `runTask`. */
  path: string;
  /** An enclosing flow has rollback armed and will unwind child records itself. */
  rollbackOwned: boolean;
}

/** Collects the child steps one task invocation runs through `ctx.step`. Internal. */
interface ChildSink extends InvocationSite {
  children: FlowStepResult[];
  references: ReferenceContext;
}

/**
 * Where a (possibly nested) flow execution sits inside the run that started
 * it. Internal: fixed at the start of a run and handed down to nested flows.
 */
interface RunFrame {
  /** Path of the step that ran this flow (`''` at the root), e.g. `2` or `2/1`. */
  pathPrefix: string;
  scope: OptionsScope;
}

// ---------------------------------------------------------------------------
// FlowRunner
// ---------------------------------------------------------------------------

export class FlowRunner {
  private logger: Logger;
  private tasks: Record<string, TaskDefinition>;
  private flows: Record<string, FlowDefinition>;
  private registry: TaskRegistry;
  private ctx: TaskContext;
  private hooks: FlowRunnerHooks;
  private conditionEvaluator?: ConditionEvaluator;
  private references?: Record<string, unknown>;
  private agents: Record<string, AgentDefinition>;
  private nestedAgentTaskFactory: NestedAgentTaskFactory;
  private optionsScope: OptionsScope;
  private strictStepReferences: boolean;
  private runDepth = 0;
  /**
   * Reference scope outside any step: the host namespaces, no step results.
   * Every task runs under at least this, so `${project.x}` in a configured
   * default resolves the same whether the task runs as a step, as an agent
   * tool, from another task, or during rollback.
   */
  private baseReferences: ReferenceContext;

  constructor(config: FlowRunnerConfig) {
    this.logger = (config.logger ?? noopLogger).child({ component: 'flow-runner' });
    this.flows = config.flows;
    this.registry = config.registry;
    this.hooks = config.hooks ?? {};
    this.conditionEvaluator = config.conditionEvaluator;
    this.references = config.references;
    this.baseReferences = { steps: [], namespaces: this.references };
    this.agents = config.agents ?? {};
    this.optionsScope = config.optionsScope ?? 'flat';
    this.strictStepReferences = config.strictStepReferences ?? false;
    this.nestedAgentTaskFactory =
      config.nestedAgentTaskFactory ?? ((ctx, options) => new AgentTask(ctx, options));

    // Compile each agent into a task definition so it is runnable as a flow
    // step (`task: <agentName>`) and as a task-backed tool. Explicit tasks of
    // the same name win.
    const agentTaskDefs: Record<string, TaskDefinition> = {};
    for (const [name, def] of Object.entries(this.agents)) {
      agentTaskDefs[name] = {
        class_path: 'agent',
        description: def.description,
        options: this.compileAgent(def) as Record<string, unknown>,
      };
    }
    this.tasks = { ...agentTaskDefs, ...config.tasks };

    // Ensure the `agent` class resolves without the consumer wiring it, unless
    // they already registered their own.
    if (Object.keys(this.agents).length > 0 && !this.registry.listRegistered().includes('agent')) {
      this.registry.register('agent', AgentTask as unknown as TaskConstructor);
    }

    // Expose the configured task definitions so tasks invoked as agent tools
    // inherit their class_path/options defaults (see AgentTask), and wire the
    // flow/agent tool dispatchers.
    // `executionPhase` is derived per invocation by `contextFor`, so a phase
    // present on `config.context` is deliberately ignored rather than merged:
    // the runner knows why each task is running and the host does not. This
    // seed value only covers reads of `this.ctx` outside a task invocation.
    this.ctx = {
      ...config.context,
      executionPhase: DEFAULT_EXECUTION_PHASE,
      registry: config.registry,
      taskDefinitions: this.tasks,
      taskReferenceContext: this.baseReferences,
      runFlow: (flowName, params) => this.runFlowTool(flowName, params),
      runAgent: (agentName, input, depth, ledger) =>
        this.runAgentTool(agentName, input, depth, ledger),
    };
  }

  /**
   * Context for work running under a given reference scope. The scope is
   * propagated to nested tasks (`taskReferenceContext`) and forwarded through
   * sub-agent dispatch, so a task invoked several agents deep resolves its
   * configured defaults exactly as it would as a top-level step.
   */
  private contextFor(
    references: ReferenceContext,
    executionPhase: ExecutionPhase = DEFAULT_EXECUTION_PHASE,
    sink?: ChildSink,
  ): TaskContext {
    return {
      ...this.ctx,
      taskReferenceContext: references,
      executionPhase,
      runAgent: (agentName, input, depth, ledger) =>
        this.runAgentTool(agentName, input, depth, ledger, references),
      ...(sink
        ? {
            step: (target: ChildStepTarget, options?: Record<string, unknown>, spec?: ChildStepSpec) =>
              this.runChildStep(sink, target, options ?? {}, spec),
          }
        : {}),
    };
  }

  /**
   * Run one composite child through the same machinery as a flow step: hooks,
   * retries, option schema, deprecation and rollback capture. The child is
   * recorded on the parent's sink and becomes `TaskResult.children`.
   *
   * A child's options are the composite's runtime data: they layer over the
   * child task's configured defaults (interpolated in the parent's reference
   * scope) verbatim. Runtime `params` and enclosing-flow overrides do not
   * reach children, and a child flow gets `options` as its `params`.
   */
  private async runChildStep(
    sink: ChildSink,
    target: ChildStepTarget,
    options: Record<string, unknown>,
    spec: ChildStepSpec | undefined,
  ): Promise<TaskResult> {
    const stepNumber = sink.children.length + 1;
    const isFlow = typeof target === 'object' && 'flow' in target;
    const name = typeof target === 'string' ? target : 'flow' in target ? target.flow : target.task;
    const path = sink.path ? `${sink.path}/${stepNumber}` : String(stepNumber);
    const planStep: PlanStep = {
      stepNumber,
      type: isFlow ? 'flow' : 'task',
      name,
      skipped: false,
      options,
      ...(spec?.retries !== undefined ? { retries: spec.retries } : {}),
      ...(spec?.retryDelay !== undefined ? { retryDelay: spec.retryDelay } : {}),
      ...(spec?.retryOn !== undefined ? { retryOn: spec.retryOn } : {}),
      path,
      depth: path.split('/').length - 1,
    };
    // Claim the slot before running, so a composite that runs children
    // concurrently still numbers them in the order it asked.
    const record: FlowStepResult = { stepNumber, type: planStep.type, name, skipped: false, duration: 0, path };
    sink.children.push(record);

    await this.hooks.beforeStep?.(planStep);
    const start = Date.now();
    if (isFlow) {
      if (!this.flows[name]) {
        record.result = { success: false, error: new Error(`Flow "${name}" not found in configuration`) };
      } else {
        // A child flow is never the top of a run, even under a bare runTask.
        this.runDepth++;
        try {
          const nested = await this.runWith(
            { flowName: name, params: options, rollbackOwnedByAncestor: sink.rollbackOwned },
            {},
          );
          record.result = {
            success: nested.success,
            data: { stepCount: nested.steps.length },
            error: nested.success ? undefined : nested.error,
            ...(nested.warnings ? { warnings: nested.warnings } : {}),
          };
          record.nestedSteps = nested.steps;
          if (nested.checks) record.checks = nested.checks;
        } catch (err) {
          record.result = { success: false, error: err instanceof Error ? err : new Error(String(err)) };
        } finally {
          this.runDepth--;
        }
      }
    } else {
      const { result, attempts } = await this.withRetry(planStep, async () => {
        let resolved: ResolvedTask;
        try {
          resolved = resolveTaskCall(name, this.tasks, options, sink.references);
        } catch (err) {
          return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
        }
        return this.executeTask(
          resolved.classPath,
          resolved.options,
          sink.references,
          DEFAULT_EXECUTION_PHASE,
          name,
          { path, rollbackOwned: sink.rollbackOwned },
        );
      });
      record.result = result;
      record.attempts = attempts;
    }
    record.duration = Date.now() - start;
    await this.hooks.afterStep?.(planStep, record);
    return record.result!;
  }

  /** Map an agent definition onto AgentTask options (everything but the prompt). */
  private compileAgent(def: AgentDefinition): Omit<AgentTaskOptions, 'prompt'> {
    const b = def.budget ?? {};
    const opts: Record<string, unknown> = {
      system: def.system,
      model: def.model,
      temperature: def.temperature,
      maxTokens: def.maxTokens,
      tools: def.tools,
      schema: def.schema,
      maxIterations: b.maxIterations,
      tokenBudget: b.tokenBudget,
      maxToolResultChars: b.maxToolResultChars,
      maxAgentResultChars: b.maxAgentResultChars,
      maxConcurrency: b.maxConcurrency,
      maxAgentDepth: b.maxAgentDepth,
      timeout: def.timeout,
      retries: def.retries,
    };
    for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
    return opts as Omit<AgentTaskOptions, 'prompt'>;
  }

  /** Run a configured flow as an agent tool, returning a compact step summary. */
  private async runFlowTool(
    flowName: string,
    params?: Record<string, unknown>,
  ): Promise<TaskResult> {
    if (!this.flows[flowName]) {
      return { success: false, error: new Error(`unknown flow "${flowName}"`) };
    }
    const res = await this.run({ flowName, params });
    const steps: Record<string, unknown> = {};
    for (const s of res.steps) {
      if (s.result?.data !== undefined) steps[s.name] = s.result.data;
    }
    return { success: res.success, error: res.error, data: { success: res.success, steps } };
  }

  /**
   * Run a configured agent as an agent tool (sub-agent), threading recursion
   * depth and the caller's token ledger so the sub-agent's spend charges the
   * same budget.
   */
  private async runAgentTool(
    agentName: string,
    input: Record<string, unknown>,
    depth: number,
    ledger?: TokenLedger,
    references: ReferenceContext = this.baseReferences,
  ): Promise<TaskResult> {
    const def = this.agents[agentName];
    if (!def) return { success: false, error: new Error(`unknown agent "${agentName}"`) };
    const prompt = typeof input.prompt === 'string' ? input.prompt : JSON.stringify(input);
    // A compiled agent is configuration, so its `system` and friends interpolate
    // here exactly as they do when the same agent runs as a flow step. The
    // prompt is the caller's runtime input and stays literal.
    let compiled: Omit<AgentTaskOptions, 'prompt'>;
    try {
      compiled = resolveReferences(this.compileAgent(def), references);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
    const options = { ...compiled, prompt };
    // Carry the caller's reference scope down, so a task used as a tool inside
    // the sub-agent interpolates its configured defaults like anywhere else.
    const childCtx: ResolvedTaskContext & { readonly executionPhase: 'task' } = {
      ...this.contextFor(references),
      executionPhase: 'task',
      __agentDepth: depth,
      __tokenLedger: ledger,
    };
    try {
      return await this.nestedAgentTaskFactory(childCtx, options as AgentTaskOptions).run();
    } catch (err) {
      return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  async run(options: FlowRunOptions): Promise<FlowRunResult> {
    return this.runWith(options, {});
  }

  /**
   * Run a single task by name, directly — the leaf unit of work, without a flow.
   * A flow is a composition of these; this is the same primitive each flow step
   * executes (see `executeTask`), so a task behaves identically whether it's run
   * on its own or as a step. `options` merge over the task's configured defaults.
   */
  async runTask(taskName: string, options: Record<string, unknown> = {}): Promise<TaskResult> {
    this.logger.info({ task: taskName }, `Running task ${taskName}`);
    // A direct invocation's `options` stand in for a step's configured options,
    // so they are interpolated here as a step's would be; `resolveTaskCall` then
    // layers them over the (also interpolated) configured defaults. A bad
    // reference is reported the way a step reports one, not thrown.
    const refs = this.baseReferences;
    let resolved: ResolvedTask;
    try {
      resolved = resolveTaskCall(taskName, this.tasks, resolveReferences(options, refs), refs);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
    return this.executeTask(resolved.classPath, resolved.options, refs, DEFAULT_EXECUTION_PHASE, taskName);
  }

  /**
   * Describe a configured (or registered) task: its class, merged default
   * options, option schema, outputs and deprecation. See `TaskRegistry.describe`.
   */
  async describeTask(taskName: string): Promise<TaskDescription> {
    return this.registry.describe(taskName, this.tasks);
  }

  /** Describe a configured flow: its declared metadata and its resolved main steps. */
  describeFlow(flowName: string): FlowDescription {
    const flow = this.flows[flowName];
    if (!flow) throw new Error(`Flow "${flowName}" not found in configuration`);
    const out: FlowDescription = { name: flowName, steps: this.resolveExecutionPlan(flow, new Set()) };
    if (flow.description != null) out.description = flow.description;
    if (flow.deprecated) out.deprecated = flow.deprecated;
    if (flow.replaced_by !== undefined) out.replaced_by = flow.replaced_by;
    if (flow.rollback_on_failure !== undefined) out.rollback_on_failure = flow.rollback_on_failure;
    if (flow.options_scope !== undefined) out.options_scope = flow.options_scope;
    if (flow.checks) out.checks = flow.checks;
    return out;
  }

  /**
   * The children a composite task would run for `options`, from its class's
   * static `expand`, without running anything. `options` layer over the task's
   * configured defaults as `runTask` would layer them. Returns `null` when the
   * class declares no `expand` or its `expand` cannot say.
   */
  async expandTask(
    taskName: string,
    options: Record<string, unknown> = {},
  ): Promise<ChildPlanEntry[] | null> {
    const { classPath, options: defaults } = resolveTaskDefinition(taskName, this.tasks);
    const expand = await this.expandFunctionOf(classPath);
    if (!expand) return null;
    const merged = lenientReferences({ ...defaults, ...options }, this.baseReferences);
    return (await expand(merged, this.expandContext(taskName))) ?? null;
  }

  private expandContext(taskName: string): ExpandContext {
    return {
      taskName,
      taskDefinitions: this.tasks,
      flows: this.flows,
      ...(this.references ? { references: this.references } : {}),
    };
  }

  /** A task class's static `expand`, or undefined (including when the class cannot load). */
  private async expandFunctionOf(classPath: string): Promise<ExpandFunction | undefined> {
    try {
      const ctor = (await this.registry.resolve(classPath)) as unknown as { expand?: unknown };
      return typeof ctor.expand === 'function' ? (ctor.expand.bind(ctor) as ExpandFunction) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Plan mode: follow each composite task row with the children its `expand`
   * reports, one level deeper, recursively. Options are resolved as far as
   * they can be before a run: definition defaults, the step's options and its
   * runtime params, with host references interpolated and step references left
   * as written.
   */
  private async expandCompositeRows(
    plan: PlanStep[],
    params: Record<string, unknown> | undefined,
    scope: OptionsScope,
    ancestors: Set<string> = new Set(),
  ): Promise<PlanStep[]> {
    const out: PlanStep[] = [];
    for (const row of plan) {
      out.push(row);
      if (row.type !== 'task' || row.skipped || ancestors.has(row.name)) continue;
      const { classPath, options: defaults } = resolveTaskDefinition(row.name, this.tasks);
      const expand = await this.expandFunctionOf(classPath);
      if (!expand) continue;
      const path = row.path ?? String(row.stepNumber);
      let runtime: Record<string, unknown> | undefined = params;
      if (scope === 'step' && params) {
        runtime = {
          ...(params[row.name] as Record<string, unknown> | undefined),
          ...(params[path] as Record<string, unknown> | undefined),
        };
      }
      const raw = { ...defaults, ...(row.options ?? {}), ...(ancestors.size === 0 ? runtime : {}) };
      let entries: ChildPlanEntry[] | null = null;
      try {
        entries = await expand(lenientReferences(raw, this.baseReferences), this.expandContext(row.name));
      } catch (err) {
        this.logger.warn({ task: row.name, err }, `expand() failed for ${row.name}; shown as opaque`);
      }
      if (!entries) {
        row.composite = 'opaque';
        continue;
      }
      row.composite = 'expanded';
      row.path = path;
      row.depth = row.depth ?? 0;
      const children: PlanStep[] = entries.map((entry, i) => ({
        stepNumber: i + 1,
        type: 'flow' in entry ? 'flow' : 'task',
        name: 'flow' in entry ? entry.flow : entry.task,
        skipped: false,
        ...(entry.options ? { options: entry.options } : {}),
        path: `${path}/${i + 1}`,
        depth: row.depth! + 1,
      }));
      out.push(...(await this.expandCompositeRows(children, params, scope, new Set(ancestors).add(row.name))));
    }
    return out;
  }

  /**
   * The deprecation notice for a task or flow, or undefined. A task's class is
   * resolved for its static metadata; one that cannot load reports nothing
   * here and fails where it would have anyway, at run time.
   */
  private async deprecationOf(type: 'task' | 'flow', name: string): Promise<RunWarning | undefined> {
    if (type === 'flow') {
      const f = this.flows[name];
      return f ? deprecationWarning('flow', name, f.deprecated, f.replaced_by) : undefined;
    }
    const def = this.tasks[name];
    let meta: ReturnType<typeof taskClassMetadata> = {};
    try {
      meta = taskClassMetadata(await this.registry.resolve(resolveTaskDefinition(name, this.tasks).classPath));
    } catch {
      // Unloadable class: no static metadata to report.
    }
    return deprecationWarning('task', name, def?.deprecated ?? meta.deprecated, def?.replaced_by ?? meta.replacedBy);
  }

  /** Plan mode: mark deprecated rows and collect their warnings. */
  private async annotatePlan(plan: PlanStep[]): Promise<RunWarning[]> {
    const warnings: RunWarning[] = [];
    for (const step of plan) {
      if (step.skipped) continue;
      const w = await this.deprecationOf(step.type, step.name);
      if (!w) continue;
      const def = step.type === 'flow' ? this.flows[step.name] : this.tasks[step.name];
      step.deprecated = def?.deprecated || true;
      if (w.replacedBy) step.replaced_by = w.replacedBy;
      warnings.push(w);
    }
    return warnings;
  }

  /**
   * Instantiate and run a task with fully-resolved options (the shared leaf).
   *
   * Never throws: a failure to load or construct the class is reported as a
   * failed `TaskResult`, the same shape `BaseTask.run` guarantees for a failure
   * inside the task. Every path into a task goes through here, so running one
   * as a step, directly, as a tool, or during rollback all report failure
   * identically — and a step's `retries` cover construction, not just execution.
   * Task-to-task calls derive their equivalent context in `BaseTask.resolve`.
   *
   * `taskName` is the configured name the call came through. When given, the
   * task's declared options (class `optionsSchema` refined by the definition's
   * `options_schema`) supply defaults and are checked here, so every runner
   * path validates the same way and a bad option fails before the task exists.
   */
  private async executeTask(
    classPath: string,
    options: Record<string, unknown>,
    references: ReferenceContext,
    executionPhase: ExecutionPhase = DEFAULT_EXECUTION_PHASE,
    taskName?: string,
    site: InvocationSite = { path: '', rollbackOwned: false },
  ): Promise<TaskResult> {
    const sink: ChildSink = { ...site, children: [], references };
    const taskCtx = this.contextFor(references, executionPhase, sink);
    const finish = (result: TaskResult): TaskResult => {
      if (sink.children.length === 0) return result;
      result.children = sink.children;
      // A child's notices (a deprecated child task, say) surface on the parent,
      // so a flow reports them like any step's.
      const merged = mergeWarnings(result.warnings, ...sink.children.map((c) => c.result?.warnings));
      if (merged.length > 0) result.warnings = merged;
      return result;
    };
    try {
      let finalOptions = options;
      let deprecation: RunWarning | undefined;
      if (taskName !== undefined) {
        const meta = taskClassMetadata(await this.registry.resolve(classPath));
        const def = this.tasks[taskName];
        deprecation = deprecationWarning(
          'task',
          taskName,
          def?.deprecated ?? meta.deprecated,
          def?.replaced_by ?? meta.replacedBy,
        );
        if (deprecation) this.logger.warn({ task: taskName }, deprecation.message);
        const specs = mergeOptionSpecs(meta.optionsSchema, def?.options_schema);
        try {
          finalOptions = assertTaskOptions(taskName, specs, options);
        } catch (err) {
          return withWarnings({ success: false, error: err as Error }, deprecation);
        }
      }
      const task = await this.registry.create(classPath, taskCtx, finalOptions);
      return finish(withWarnings(await task.run(), deprecation));
    } catch (err) {
      return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  private async runWith(
    options: FlowRunOptions,
    parentOptions: ParentOptions,
    frame?: RunFrame,
  ): Promise<FlowRunResult> {
    this.runDepth++;
    const isTopLevel = this.runDepth === 1;
    try {
      return await this.executeFlow(options, isTopLevel, parentOptions, frame);
    } finally {
      this.runDepth--;
    }
  }

  /** Path of a main step inside a frame: `3` at the root, `2/3` inside step 2's flow. */
  private stepPath(frame: RunFrame, stepNumber: number): string {
    return frame.pathPrefix ? `${frame.pathPrefix}/${stepNumber}` : String(stepNumber);
  }

  /**
   * The runtime option layer one step receives. Flat: all of `params`.
   * Step-scoped: the options under the step's task name, then under its path.
   */
  private runtimeOptionsFor(
    step: PlanStep,
    frame: RunFrame,
    params: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (frame.scope === 'flat' || !params) return params;
    const byName = params[step.name] as Record<string, unknown> | undefined;
    // Hook steps carry synthetic step numbers and are addressed by name only.
    const byPath =
      step.phase === undefined
        ? (params[this.stepPath(frame, step.stepNumber)] as Record<string, unknown> | undefined)
        : undefined;
    if (!byName && !byPath) return undefined;
    return { ...byName, ...byPath };
  }

  /**
   * Every selector a step-scoped `params` key may use for a run of `flowName`:
   * task names anywhere in the tree (main and hook steps, nested flows
   * included) and the paths of main task steps.
   */
  private collectSelectors(
    flowName: string,
    pathPrefix: string,
    ancestors: Set<string>,
    out: { names: Set<string>; paths: Set<string> },
  ): void {
    const flow = this.flows[flowName];
    if (!flow || ancestors.has(flowName)) return;
    const nextAncestors = new Set(ancestors).add(flowName);
    const visit = (step: PlanStep, path: string | undefined): void => {
      if (step.name === 'None') return;
      if (step.type === 'task') {
        out.names.add(step.name);
        if (path !== undefined) out.paths.add(path);
      } else {
        this.collectSelectors(step.name, path ?? `${pathPrefix}/${step.phase}`, nextAncestors, out);
      }
    };
    for (const step of this.resolveExecutionPlan(flow, new Set())) {
      visit(step, pathPrefix ? `${pathPrefix}/${step.stepNumber}` : String(step.stepNumber));
    }
    for (const phase of ['on_start', 'on_success', 'on_failure', 'finally'] as const) {
      for (const step of this.planHookSteps(flow[phase], phase, new Set(), 0)) visit(step, undefined);
    }
  }

  /**
   * Find `${steps.<id>...}` references that cannot be bound to exactly one
   * earlier main step: ambiguous names, unknown ids and forward references.
   * Scans the flow's main and hook steps (`options` of task steps, `when`, and
   * check `when`s) and, recursively, every flow they nest. It does not scan
   * task definition defaults, which are resolved in whatever step runs them.
   */
  checkStepReferences(flowName: string): StepReferenceIssue[] {
    const issues: StepReferenceIssue[] = [];
    this.collectReferenceIssues(flowName, new Set(), issues);
    return issues;
  }

  private collectReferenceIssues(flowName: string, seen: Set<string>, issues: StepReferenceIssue[]): void {
    const flow = this.flows[flowName];
    if (!flow || seen.has(flowName)) return;
    seen.add(flowName);
    const main = this.resolveExecutionPlan(flow, new Set());
    const byName = new Map<string, number[]>();
    for (const st of main) {
      if (st.name === 'None') continue;
      byName.set(st.name, [...(byName.get(st.name) ?? []), st.stepNumber]);
    }
    const numbers = new Set(main.filter((st) => st.name !== 'None').map((st) => st.stepNumber));

    const scan = (st: PlanStep): void => {
      const texts: unknown[] = [st.when, ...(st.checks ?? []).map((c) => c.when)];
      // A flow step's options are overrides for tasks inside the child flow and
      // resolve against the child's steps, not this flow's.
      if (st.type === 'task') texts.push(st.options);
      for (const ref of stepReferencesIn(texts)) {
        const issue = bindStepReference(ref, st, byName, numbers);
        if (issue) {
          issues.push({
            flowName,
            stepNumber: st.stepNumber,
            ...(st.phase ? { phase: st.phase } : {}),
            reference: `\${steps.${ref}}`,
            ...issue,
          });
        }
      }
    };
    for (const st of main) {
      if (st.name === 'None') continue;
      scan(st);
      if (st.type === 'flow') this.collectReferenceIssues(st.name, seen, issues);
    }
    for (const phase of ['on_start', 'on_success', 'on_failure', 'finally'] as const) {
      for (const st of this.planHookSteps(flow[phase], phase, new Set(), 0)) {
        if (st.name === 'None') continue;
        scan(st);
        if (st.type === 'flow') this.collectReferenceIssues(st.name, seen, issues);
      }
    }
  }

  /** Reject step-scoped `params` that address nothing or are not option objects. */
  private checkScopedParams(flowName: string, params: Record<string, unknown> | undefined): void {
    if (!params) return;
    const selectors = { names: new Set<string>(), paths: new Set<string>() };
    this.collectSelectors(flowName, '', new Set(), selectors);
    const problems: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (!selectors.names.has(key) && !selectors.paths.has(key)) {
        problems.push(`"${key}" matches no task name or step path in flow "${flowName}"`);
      } else if (!value || typeof value !== 'object' || Array.isArray(value)) {
        problems.push(`"${key}" must map to an object of options`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`Invalid step-scoped params: ${problems.join('; ')}`);
    }
  }

  resolveExecutionPlan(flow: FlowDefinition, skipSet: Set<string>): PlanStep[] {
    const sortedKeys = Object.keys(flow.steps)
      .map(Number)
      .sort((a, b) => a - b);

    return sortedKeys.map((key) => this.planStepFromDef(flow.steps[String(key)]!, key, skipSet));
  }

  private planStepFromDef(step: FlowStep, stepNumber: number, skipSet: Set<string>): PlanStep {
    if (step.task === 'None') {
      return { stepNumber, type: 'task', name: 'None', skipped: true };
    }
    if (step.flow === 'None') {
      return { stepNumber, type: 'flow', name: 'None', skipped: true };
    }
    const name = (step.task ?? step.flow)!;
    const type: 'task' | 'flow' = step.task ? 'task' : 'flow';
    return {
      stepNumber,
      type,
      name,
      skipped: skipSet.has(name) || skipSet.has(String(stepNumber)),
      options: step.options as Record<string, unknown> | undefined,
      retries: step.retries,
      retryDelay: step.retryDelay,
      retryOn: step.retryOn,
      when: step.when,
      ignore_failure: step.ignore_failure,
      ...(step.checks ? { checks: step.checks } : {}),
    };
  }

  private planHookSteps(
    hookSteps: FlowStep[] | undefined,
    phase: HookPhase,
    skipSet: Set<string>,
    baseStepNumber: number,
  ): PlanStep[] {
    if (!hookSteps || hookSteps.length === 0) return [];
    return hookSteps.map((s, i) => ({
      ...this.planStepFromDef(s, baseStepNumber + i, skipSet),
      phase,
    }));
  }

  /**
   * Merge an enclosing flow step's per-task override map onto inherited parent
   * options. Inner (closer) overrides win over outer for the same task+key.
   */
  private mergeParentOptions(
    base: ParentOptions,
    overrideMap: Record<string, unknown> | undefined,
  ): ParentOptions {
    if (!overrideMap) return base;
    const out: ParentOptions = { ...base };
    for (const [name, opts] of Object.entries(overrideMap)) {
      if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
        out[name] = { ...(base[name] ?? {}), ...(opts as Record<string, unknown>) };
      }
    }
    return out;
  }

  /** Recursively expand a plan step's nested flow into its child steps. */
  private expandPlanStep(
    planStep: PlanStep,
    parentOptions: ParentOptions,
    pathPrefix: string,
    depth: number,
    ancestors: Set<string>,
    skipSet: Set<string>,
  ): PlanStep[] {
    const self: PlanStep = { ...planStep, path: pathPrefix, depth };
    if (planStep.type !== 'flow' || planStep.skipped || ancestors.has(planStep.name)) {
      return [self];
    }
    const childFlow = this.flows[planStep.name];
    if (!childFlow) return [self];

    const childParentOptions = this.mergeParentOptions(parentOptions, planStep.options);
    const nextAncestors = new Set(ancestors).add(planStep.name);
    const childPlan = this.resolveExecutionPlan(childFlow, skipSet);
    const children = childPlan.flatMap((cs) =>
      this.expandPlanStep(
        cs,
        childParentOptions,
        `${pathPrefix}/${cs.stepNumber}`,
        depth + 1,
        nextAncestors,
        skipSet,
      ),
    );
    return [self, ...children];
  }

  /**
   * Evaluate a step's `when:` to a boolean. Undefined `when` always runs.
   *
   * `executionPhase` is the phase the step's own task will observe. It is
   * threaded in rather than read off `this.ctx`, whose phase is only the
   * constructor seed: a `finally` hook gating on `context.executionPhase`
   * would otherwise be told `'task'` and run when it meant to skip.
   */
  private async evaluateWhen(
    when: string | boolean | undefined,
    completedSteps: FlowStepResult[],
    params: Record<string, unknown> | undefined,
    executionPhase: ExecutionPhase,
    errorCtx?: { error: Error; step?: string },
    gate?: { step?: PlanStep; check?: StepCheck; flowName?: string },
  ): Promise<boolean> {
    if (when === undefined) return true;
    if (typeof when === 'boolean') return when;

    const error = errorCtx
      ? {
          message: errorCtx.error.message,
          name: errorCtx.error.name,
          stack: errorCtx.error.stack,
          step: errorCtx.step,
        }
      : undefined;

    if (this.conditionEvaluator) {
      return await this.conditionEvaluator(when, {
        steps: completedSteps,
        params,
        context: executionPhase === this.ctx.executionPhase ? this.ctx : { ...this.ctx, executionPhase },
        error,
        ...(this.references ? { references: this.references } : {}),
        ...(gate?.step ? { step: gate.step } : {}),
        ...(gate?.check ? { check: gate.check } : {}),
        ...(gate?.flowName ? { flowName: gate.flowName } : {}),
      });
    }

    // Built-in fallback: resolve ${...} references, then test truthiness.
    const resolved = resolveReferences(when as unknown, {
      steps: completedSteps,
      namespaces: this.references,
      error,
    });
    return truthy(resolved);
  }

  /**
   * Evaluate declared checks in order. Never throws: an evaluator failure is
   * reported on the outcome.
   */
  private async evaluateChecks(
    checks: StepCheck[] | undefined,
    scope: 'flow' | 'step',
    flowName: string,
    completedSteps: FlowStepResult[],
    params: Record<string, unknown> | undefined,
    executionPhase: ExecutionPhase,
    step?: PlanStep,
    path?: string,
    errorCtx?: { error: Error; step?: string },
  ): Promise<CheckOutcome[]> {
    const out: CheckOutcome[] = [];
    for (const check of checks ?? []) {
      const outcome: CheckOutcome = {
        scope,
        flowName,
        ...(step ? { stepNumber: step.stepNumber, name: step.name } : {}),
        ...(path !== undefined ? { path } : {}),
        when: check.when,
        action: check.action,
        message: check.message ?? defaultCheckMessage(check, scope === 'flow' ? flowName : step?.name),
        triggered: false,
      };
      try {
        outcome.triggered = await this.evaluateWhen(
          check.when,
          completedSteps,
          params,
          executionPhase,
          errorCtx,
          { step, check, flowName },
        );
      } catch (err) {
        outcome.error = err instanceof Error ? err : new Error(String(err));
      }
      out.push(outcome);
    }
    return out;
  }

  /**
   * Fold evaluated checks into a verdict. Fired checks go to `fired`, fired
   * `warn` checks to `warnings`. The first fired `error` check wins; an
   * evaluator failure is returned separately so the caller can treat it like a
   * `when:` that throws.
   */
  private applyChecks(
    outcomes: CheckOutcome[],
    fired: CheckOutcome[],
    warnings: RunWarning[],
  ): { error?: CheckFailedError; skip: boolean; evalError?: Error } {
    let error: CheckFailedError | undefined;
    let evalError: Error | undefined;
    let skip = false;
    for (const o of outcomes) {
      if (o.error) {
        evalError ??= new Error(`Check on "${o.name ?? o.flowName}" could not be evaluated: ${o.error.message}`);
        continue;
      }
      if (!o.triggered) continue;
      fired.push(o);
      if (o.action === 'error') error ??= new CheckFailedError(o);
      else if (o.action === 'skip') skip = true;
      else {
        warnings.push(checkWarning(o));
        this.logger.warn({ flow: o.flowName, step: o.stepNumber }, o.message);
      }
    }
    return { error, skip, evalError };
  }

  /**
   * Evaluate every declared check of a flow and its steps without running
   * anything. Checks see no step results (nothing has run) and the runtime
   * `params`; one that needs a step result reports an evaluation error and the
   * row's status is `unknown`. Nested flows are expanded, with paths as in an
   * expanded plan; hook steps are listed under their phase.
   */
  async preflight(
    flowName: string,
    params?: Record<string, unknown>,
    options: { skip?: string[] } = {},
  ): Promise<PreflightResult> {
    const flow = this.flows[flowName];
    if (!flow) throw new Error(`Flow "${flowName}" not found in configuration`);
    const skipSet = new Set(options.skip ?? []);
    const flowChecks = await this.evaluateChecks(
      flow.checks,
      'flow',
      flowName,
      [],
      params,
      DEFAULT_EXECUTION_PHASE,
    );
    const steps: PreflightStep[] = [];
    await this.preflightFlow(flow, flowName, params, skipSet, '', 0, new Set([flowName]), steps);

    const all = [...flowChecks, ...steps.flatMap((s) => s.checks)];
    const warnings = mergeWarnings(
      all.filter((c) => c.triggered && c.action === 'warn').map(checkWarning),
      await this.annotatePlan(steps.filter((s) => s.status !== 'skip') as unknown as PlanStep[]),
    );
    const result: PreflightResult = {
      flowName,
      ok: !all.some((c) => c.triggered && c.action === 'error'),
      checks: flowChecks,
      steps,
    };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  private async preflightFlow(
    flow: FlowDefinition,
    flowName: string,
    params: Record<string, unknown> | undefined,
    skipSet: Set<string>,
    pathPrefix: string,
    depth: number,
    ancestors: Set<string>,
    out: PreflightStep[],
  ): Promise<void> {
    const at = (p: string) => (pathPrefix ? `${pathPrefix}/${p}` : p);
    const rows: { step: PlanStep; path: string }[] = [
      ...this.resolveExecutionPlan(flow, skipSet).map((step) => ({ step, path: at(String(step.stepNumber)) })),
      ...(['on_start', 'on_success', 'on_failure', 'finally'] as const).flatMap((phase) =>
        this.planHookSteps(flow[phase], phase, skipSet, 0).map((step, i) => ({
          step,
          path: at(`${phase}/${i + 1}`),
        })),
      ),
    ];
    for (const { step, path } of rows) {
      const row: PreflightStep = {
        stepNumber: step.stepNumber,
        type: step.type,
        name: step.name,
        path,
        depth,
        ...(step.phase ? { phase: step.phase } : {}),
        status: 'run',
        checks: [],
      };
      out.push(row);
      if (step.skipped) {
        row.status = 'skip';
        row.skipReason = 'static';
        continue;
      }
      row.checks = await this.evaluateChecks(
        step.checks,
        'step',
        flowName,
        [],
        params,
        step.phase ?? DEFAULT_EXECUTION_PHASE,
        step,
        path,
      );
      const child = step.type === 'flow' && !ancestors.has(step.name) ? this.flows[step.name] : undefined;
      if (child) {
        row.checks.push(
          ...(await this.evaluateChecks(child.checks, 'flow', step.name, [], params, DEFAULT_EXECUTION_PHASE)),
        );
      }
      row.status = checkStatus(row.checks);
      if (row.status === 'skip') row.skipReason = 'check';
      if (child && row.status !== 'skip') {
        await this.preflightFlow(
          child,
          step.name,
          params,
          skipSet,
          path,
          depth + 1,
          new Set(ancestors).add(step.name),
          out,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async executeFlow(
    options: FlowRunOptions,
    isTopLevel: boolean,
    parentOptions: ParentOptions,
    inheritedFrame?: RunFrame,
  ): Promise<FlowRunResult> {
    const startTime = Date.now();
    const skipSet = new Set(options.skip ?? []);
    const completedSteps: FlowStepResult[] = [];
    const hookErrors: HookError[] = [];
    const rollbackRecords: HarvestedRollback[] = [];

    const flow = this.flows[options.flowName];
    if (!flow) {
      throw new Error(`Flow "${options.flowName}" not found in configuration`);
    }

    const rollbackEnabled = options.rollback_on_failure ?? flow.rollback_on_failure ?? false;
    // An ancestor with rollback armed already holds this run's records, bubbled
    // up from the nested step, and will invoke them in the full reverse order.
    // This level must not invoke them as well.
    const ancestorOwnsRollback = options.rollbackOwnedByAncestor === true;

    const executionPlan = this.resolveExecutionPlan(flow, skipSet);
    const flowDeprecation = deprecationWarning('flow', options.flowName, flow.deprecated, flow.replaced_by);

    // The flow a run starts on fixes how its params are addressed; nested
    // flows inherit that rather than reading their own `options_scope`.
    const frame: RunFrame = inheritedFrame ?? {
      pathPrefix: '',
      scope: options.optionsScope ?? flow.options_scope ?? this.optionsScope,
    };
    if (!inheritedFrame && frame.scope === 'step') {
      try {
        this.checkScopedParams(options.flowName, options.params);
      } catch (err) {
        return { success: false, steps: [], duration: Date.now() - startTime, error: err as Error };
      }
    }
    if (!inheritedFrame && this.strictStepReferences) {
      const issues = this.checkStepReferences(options.flowName);
      if (issues.length > 0) {
        const detail = issues.map((i) => `${i.flowName} step ${i.stepNumber}: ${i.message}`).join('; ');
        return {
          success: false,
          steps: [],
          duration: Date.now() - startTime,
          error: new Error(`Unbindable step references: ${detail}`),
        };
      }
    }

    // Plan mode — dump all phases for visibility, nothing runs.
    if (options.plan) {
      let mainPlan = options.expandNestedFlows
        ? executionPlan.flatMap((s) =>
            this.expandPlanStep(
              s,
              parentOptions,
              String(s.stepNumber),
              0,
              new Set([options.flowName]),
              skipSet,
            ),
          )
        : executionPlan;
      if (options.expandComposites) {
        mainPlan = await this.expandCompositeRows(mainPlan, options.params, frame.scope);
      }
      const fullPlan: PlanStep[] = [
        ...this.planHookSteps(flow.on_start, 'on_start', skipSet, -3000),
        ...mainPlan,
        ...this.planHookSteps(flow.on_success, 'on_success', skipSet, 10_000),
        ...this.planHookSteps(flow.on_failure, 'on_failure', skipSet, 20_000),
        ...this.planHookSteps(flow.finally, 'finally', skipSet, 30_000),
      ];
      const planWarnings = mergeWarnings(
        flowDeprecation ? [flowDeprecation] : [],
        await this.annotatePlan(fullPlan),
      );
      const planResult: FlowRunResult = {
        success: true,
        steps: fullPlan.map((s) => ({
          stepNumber: s.stepNumber,
          type: s.type,
          name: s.name,
          skipped: s.skipped,
          duration: 0,
          ...(s.path !== undefined ? { path: s.path, depth: s.depth } : {}),
          ...(s.composite ? { composite: s.composite } : {}),
          ...(s.deprecated ? { deprecated: s.deprecated } : {}),
          ...(s.replaced_by !== undefined ? { replaced_by: s.replaced_by } : {}),
        })) as unknown as FlowStepResult[],
        duration: 0,
      };
      if (planWarnings.length > 0) planResult.warnings = planWarnings;
      return planResult;
    }

    // Flow-level checks gate everything, hooks included, so they run before
    // the run is announced to `beforeRun`.
    const firedChecks: CheckOutcome[] = [];
    const checkWarnings: RunWarning[] = [];
    if (flow.checks?.length) {
      const outcomes = await this.evaluateChecks(
        flow.checks,
        'flow',
        options.flowName,
        [],
        options.params,
        DEFAULT_EXECUTION_PHASE,
      );
      const verdict = this.applyChecks(outcomes, firedChecks, checkWarnings);
      const failure = verdict.error ?? verdict.evalError;
      if (failure || verdict.skip) {
        const done: FlowRunResult = {
          success: !failure,
          steps: !failure
            ? executionPlan.map((s) => ({
                stepNumber: s.stepNumber,
                type: s.type,
                name: s.name,
                skipped: true,
                duration: 0,
                skipReason: 'check' as const,
              }))
            : [],
          duration: Date.now() - startTime,
          ...(failure ? { error: failure } : {}),
          ...(firedChecks.length > 0 ? { checks: firedChecks } : {}),
        };
        const w = mergeWarnings(flowDeprecation ? [flowDeprecation] : [], checkWarnings);
        if (w.length > 0) done.warnings = w;
        return done;
      }
    }

    if (isTopLevel) {
      await this.hooks.beforeRun?.(options.flowName, executionPlan);
    }
    if (flowDeprecation) this.logger.warn({ flow: options.flowName }, flowDeprecation.message);
    const hookWarnings: RunWarning[] = [];

    let flowError: Error | undefined;
    let flowErrorStepName: string | undefined;

    // ---- on_start ----
    {
      const startPlan = this.planHookSteps(flow.on_start, 'on_start', skipSet, -3000);
      for (const hookStep of startPlan) {
        const ok = await this.runHookStep(
          hookStep,
          options,
          completedSteps,
          parentOptions,
          undefined,
          hookErrors,
          hookWarnings,
          frame,
        );
        if (!ok) {
          flowError = hookErrors[hookErrors.length - 1]?.error;
          flowErrorStepName = hookStep.name;
          break;
        }
      }
    }

    // ---- main steps ----
    if (!flowError) {
      for (const planStep of executionPlan) {
        // Resolve conditional execution (`when:`) at run time.
        let conditionMet = true;
        let conditionError: Error | undefined;
        if (!planStep.skipped && planStep.when !== undefined) {
          try {
            conditionMet = await this.evaluateWhen(
              planStep.when,
              completedSteps,
              options.params,
              planStep.phase ?? DEFAULT_EXECUTION_PHASE,
            );
          } catch (err) {
            conditionError = err instanceof Error ? err : new Error(String(err));
          }
        }

        if (conditionError) {
          // A condition that throws is treated like a step failure.
          const sr: FlowStepResult = {
            stepNumber: planStep.stepNumber,
            type: planStep.type,
            name: planStep.name,
            skipped: false,
            duration: 0,
            result: { success: false, error: conditionError },
          };
          completedSteps.push(sr);
          await this.hooks.afterStep?.(planStep, sr);
          if (planStep.ignore_failure) {
            sr.ignoredFailure = true;
            continue;
          }
          flowError = conditionError;
          flowErrorStepName = planStep.name;
          await this.hooks.onStepError?.(planStep, conditionError, completedSteps);
          break;
        }

        if (planStep.skipped || !conditionMet) {
          const sr: FlowStepResult = {
            stepNumber: planStep.stepNumber,
            type: planStep.type,
            name: planStep.name,
            skipped: true,
            duration: 0,
            skipReason: planStep.skipped ? 'static' : 'when',
          };
          completedSteps.push(sr);
          await this.hooks.afterStep?.(planStep, sr);
          continue;
        }

        // Declared checks, after `when` has decided the step would run.
        const stepFired: CheckOutcome[] = [];
        if (planStep.checks?.length) {
          const outcomes = await this.evaluateChecks(
            planStep.checks,
            'step',
            options.flowName,
            completedSteps,
            options.params,
            DEFAULT_EXECUTION_PHASE,
            planStep,
            this.stepPath(frame, planStep.stepNumber),
          );
          const verdict = this.applyChecks(outcomes, stepFired, checkWarnings);
          firedChecks.push(...stepFired);
          if (verdict.error || verdict.skip || verdict.evalError) {
            const sr: FlowStepResult = {
              stepNumber: planStep.stepNumber,
              type: planStep.type,
              name: planStep.name,
              skipped: !verdict.error && !verdict.evalError,
              duration: 0,
              ...(stepFired.length > 0 ? { checks: [...stepFired] } : {}),
            };
            if (sr.skipped) {
              sr.skipReason = 'check';
            } else {
              sr.result = { success: false, error: (verdict.error ?? verdict.evalError)! };
            }
            completedSteps.push(sr);
            await this.hooks.afterStep?.(planStep, sr);
            if (sr.skipped) continue;
            // A check that could not be evaluated fails like a `when:` that
            // throws, and honours ignore_failure. A fired `error` check is a
            // gate and aborts regardless.
            if (!verdict.error && planStep.ignore_failure) {
              sr.ignoredFailure = true;
              continue;
            }
            flowError = sr.result!.error!;
            flowErrorStepName = planStep.name;
            await this.hooks.onStepError?.(planStep, flowError, completedSteps);
            break;
          }
        }

        await this.hooks.beforeStep?.(planStep);
        const stepStart = Date.now();
        let nestedChecks: CheckOutcome[] | undefined;

        try {
          let stepResult: FlowStepResult;

          if (planStep.type === 'task') {
            const { result: taskResult, attempts } = await this.executeTaskStepWithRetry(
              planStep,
              this.runtimeOptionsFor(planStep, frame, options.params),
              completedSteps,
              parentOptions,
              undefined,
              {
                path: this.stepPath(frame, planStep.stepNumber),
                rollbackOwned: rollbackEnabled || ancestorOwnsRollback,
              },
            );
            stepResult = {
              stepNumber: planStep.stepNumber,
              type: 'task',
              name: planStep.name,
              result: taskResult,
              skipped: false,
              duration: Date.now() - stepStart,
              attempts,
            };
            // A step that FAILED may still have written part of its change, and
            // a task that knows it did attaches the inverse for the part that
            // landed. Harvesting only from a successful step throws that record
            // away at exactly the moment it is worth the most. The failing step
            // is pushed last and performRollback walks the array backwards, so
            // the partial write is undone first and the earlier steps unwind
            // after it.
            // A composite's children ran before it finished, so their records
            // go first and unwind after the composite's own.
            harvestRollbacks(taskResult, rollbackRecords);
          } else {
            const childParentOptions = this.mergeParentOptions(parentOptions, planStep.options);
            const nestedResult = await this.runWith(
              {
                ...options,
                flowName: planStep.name,
                plan: false,
                rollbackOwnedByAncestor: rollbackEnabled || ancestorOwnsRollback,
              },
              childParentOptions,
              { ...frame, pathPrefix: this.stepPath(frame, planStep.stepNumber) },
            );
            nestedChecks = nestedResult.checks;
            if (nestedChecks) firedChecks.push(...nestedChecks);
            stepResult = {
              stepNumber: planStep.stepNumber,
              type: 'flow',
              name: planStep.name,
              result: {
                success: nestedResult.success,
                data: { stepCount: nestedResult.steps.length },
                error: nestedResult.success ? undefined : nestedResult.error,
                ...(nestedResult.warnings ? { warnings: nestedResult.warnings } : {}),
              },
              skipped: false,
              duration: Date.now() - stepStart,
              nestedSteps: nestedResult.steps,
            };
            // Bubble nested rollback records up so the parent can invoke them.
            // A failing child step's record bubbles for the same reason a
            // failing main step's does: the part that landed still needs
            // undoing, and the child is the only place that knows what it was.
            for (const s of nestedResult.steps) {
              if (s.type === 'task' && s.result) harvestRollbacks(s.result, rollbackRecords);
            }
          }

          const stepChecks = [...stepFired, ...(nestedChecks ?? [])];
          if (stepChecks.length > 0) stepResult.checks = stepChecks;
          completedSteps.push(stepResult);
          await this.hooks.afterStep?.(planStep, stepResult);

          if (!stepResult.result?.success) {
            if (planStep.ignore_failure) {
              stepResult.ignoredFailure = true;
              this.logger.info(
                { step: planStep.stepNumber, task: planStep.name },
                `Step ${planStep.name} failed but ignore_failure is set; continuing`,
              );
              continue;
            }
            flowError =
              stepResult.result?.error ?? new Error(`Step ${planStep.name} failed`);
            flowErrorStepName = planStep.name;
            await this.hooks.onStepError?.(planStep, flowError, completedSteps);
            break;
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          const sr: FlowStepResult = {
            stepNumber: planStep.stepNumber,
            type: planStep.type,
            name: planStep.name,
            skipped: false,
            duration: Date.now() - stepStart,
            result: { success: false, error: err },
          };
          completedSteps.push(sr);
          if (planStep.ignore_failure) {
            sr.ignoredFailure = true;
            await this.hooks.afterStep?.(planStep, sr);
            this.logger.info(
              { step: planStep.stepNumber, task: planStep.name },
              `Step ${planStep.name} threw but ignore_failure is set; continuing`,
            );
            continue;
          }
          flowError = err;
          flowErrorStepName = planStep.name;
          await this.hooks.onStepError?.(planStep, err, completedSteps);
          break;
        }
      }
    }

    // ---- on_success or on_failure ----
    if (flowError) {
      const failPlan = this.planHookSteps(flow.on_failure, 'on_failure', skipSet, 20_000);
      for (const hookStep of failPlan) {
        await this.runHookStep(
          hookStep,
          options,
          completedSteps,
          parentOptions,
          { error: flowError, step: flowErrorStepName },
          hookErrors,
          hookWarnings,
          frame,
        );
      }
    } else {
      const successPlan = this.planHookSteps(flow.on_success, 'on_success', skipSet, 10_000);
      for (const hookStep of successPlan) {
        await this.runHookStep(
          hookStep,
          options,
          completedSteps,
          parentOptions,
          undefined,
          hookErrors,
          hookWarnings,
          frame,
        );
      }
    }

    // ---- rollback ----
    let rollbackResult: RollbackResult | undefined;
    if (flowError && rollbackEnabled && rollbackRecords.length > 0 && !ancestorOwnsRollback) {
      rollbackResult = await this.performRollback(rollbackRecords);
    }

    // ---- finally ----
    {
      const finallyPlan = this.planHookSteps(flow.finally, 'finally', skipSet, 30_000);
      for (const hookStep of finallyPlan) {
        await this.runHookStep(
          hookStep,
          options,
          completedSteps,
          parentOptions,
          flowError ? { error: flowError, step: flowErrorStepName } : undefined,
          hookErrors,
          hookWarnings,
          frame,
        );
      }
    }

    const result: FlowRunResult = {
      success: !flowError,
      steps: completedSteps,
      duration: Date.now() - startTime,
      error: flowError,
      hookErrors: hookErrors.length > 0 ? hookErrors : undefined,
      rollback: rollbackResult,
    };
    const warnings = mergeWarnings(
      flowDeprecation ? [flowDeprecation] : [],
      checkWarnings,
      ...completedSteps.map((s) => s.result?.warnings),
      hookWarnings,
    );
    if (warnings.length > 0) result.warnings = warnings;
    if (firedChecks.length > 0) result.checks = firedChecks;

    if (isTopLevel) {
      await this.hooks.afterRun?.(result);
    }

    return result;
  }

  private async runHookStep(
    hookStep: PlanStep,
    options: FlowRunOptions,
    completedSteps: FlowStepResult[],
    parentOptions: ParentOptions,
    errorCtx: { error: Error; step?: string } | undefined,
    hookErrors: HookError[],
    hookWarnings: RunWarning[],
    frame: RunFrame,
  ): Promise<boolean> {
    if (hookStep.skipped) return true;

    // Hook steps honor `when:` too — a falsy condition skips them silently.
    if (hookStep.when !== undefined) {
      try {
        const ok = await this.evaluateWhen(
          hookStep.when,
          completedSteps,
          options.params,
          hookStep.phase ?? DEFAULT_EXECUTION_PHASE,
          errorCtx,
        );
        if (!ok) return true;
      } catch (err) {
        hookErrors.push({
          phase: hookStep.phase!,
          name: hookStep.name,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return false;
      }
    }

    if (hookStep.checks?.length) {
      const outcomes = await this.evaluateChecks(
        hookStep.checks,
        'step',
        options.flowName,
        completedSteps,
        options.params,
        hookStep.phase ?? DEFAULT_EXECUTION_PHASE,
        hookStep,
        undefined,
        errorCtx,
      );
      const verdict = this.applyChecks(outcomes, [], hookWarnings);
      const failure = verdict.error ?? verdict.evalError;
      if (failure) {
        hookErrors.push({ phase: hookStep.phase!, name: hookStep.name, error: failure });
        return false;
      }
      if (verdict.skip) return true;
    }

    try {
      if (hookStep.type === 'flow') {
        const childParentOptions = this.mergeParentOptions(parentOptions, hookStep.options);
        const nested = await this.runWith(
          {
            ...options,
            flowName: hookStep.name,
            plan: false,
            // A hook flow's records are NOT bubbled into the host run's
            // harvest, so nothing above will unwind it. It owns its own,
            // whatever the run that triggered the hook is doing.
            rollbackOwnedByAncestor: false,
          },
          childParentOptions,
          // Hook flows are addressed by task name only; the phase keeps their
          // steps off every main-step path.
          { ...frame, pathPrefix: `${frame.pathPrefix ? `${frame.pathPrefix}/` : ''}${hookStep.phase}` },
        );
        if (nested.warnings) hookWarnings.push(...nested.warnings);
        if (!nested.success) {
          hookErrors.push({
            phase: hookStep.phase!,
            name: hookStep.name,
            error: nested.error ?? new Error(`Nested flow ${hookStep.name} failed`),
          });
          return false;
        }
        return true;
      }

      const { result } = await this.executeTaskStepWithRetry(
        hookStep,
        this.runtimeOptionsFor(hookStep, frame, options.params),
        completedSteps,
        parentOptions,
        errorCtx,
      );
      if (result.warnings) hookWarnings.push(...result.warnings);
      if (!result.success) {
        hookErrors.push({
          phase: hookStep.phase!,
          name: hookStep.name,
          error: result.error ?? new Error(`Hook ${hookStep.phase} step ${hookStep.name} failed`),
        });
        return false;
      }
      return true;
    } catch (err) {
      hookErrors.push({
        phase: hookStep.phase!,
        name: hookStep.name,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return false;
    }
  }

  private async executeTaskStepWithRetry(
    step: PlanStep,
    flowParams: Record<string, unknown> | undefined,
    completedSteps: FlowStepResult[],
    parentOptions: ParentOptions,
    errorCtx?: { error: Error; step?: string },
    site?: InvocationSite,
  ): Promise<{ result: TaskResult; attempts: number }> {
    return this.withRetry(step, () =>
      this.executeTaskStep(step, flowParams, completedSteps, parentOptions, errorCtx, site),
    );
  }

  /** A step's retry policy (`retries`, `retryDelay`, `retryOn`) around one attempt function. */
  private async withRetry(
    step: Pick<PlanStep, 'stepNumber' | 'name' | 'retries' | 'retryDelay' | 'retryOn'>,
    attemptOnce: () => Promise<TaskResult>,
  ): Promise<{ result: TaskResult; attempts: number }> {
    const maxAttempts = Math.max(1, 1 + (step.retries ?? 0));
    const delayMs = step.retryDelay ?? 0;
    const retryOn = step.retryOn;

    let lastResult: TaskResult = { success: false, error: new Error('no attempts executed') };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastResult = await attemptOnce();
      if (lastResult.success) return { result: lastResult, attempts: attempt };
      // Bad options fail the same way every time; retrying cannot help.
      if (lastResult.error instanceof TaskOptionsError) return { result: lastResult, attempts: attempt };

      const errMsg = lastResult.error?.message ?? '';
      const retryMatches = retryOn == null || errMsg.includes(retryOn);

      if (attempt < maxAttempts && retryMatches) {
        if (delayMs > 0) await sleep(delayMs);
        this.logger.info(
          { step: step.stepNumber, task: step.name, attempt, nextAttempt: attempt + 1 },
          `Retrying step ${step.name}`,
        );
        continue;
      }
      break;
    }

    return { result: lastResult, attempts: maxAttempts };
  }

  private async executeTaskStep(
    step: PlanStep,
    flowParams: Record<string, unknown> | undefined,
    completedSteps: FlowStepResult[],
    parentOptions: ParentOptions,
    errorCtx?: { error: Error; step?: string },
    site?: InvocationSite,
  ): Promise<TaskResult> {
    const taskDef = resolveTaskDefinition(step.name, this.tasks);
    // Precedence (low → high): task default → enclosing-flow override → step inline → runtime params.
    // Every layer here is configuration, so the merge is interpolated as a whole.
    const rawOptions = {
      ...taskDef.options,
      ...(parentOptions[step.name] ?? {}),
      ...step.options,
      ...flowParams,
    };

    const refCtx: ReferenceContext = {
      steps: completedSteps,
      namespaces: this.references,
      error: errorCtx
        ? {
            message: errorCtx.error.message,
            name: errorCtx.error.name,
            stack: errorCtx.error.stack,
            step: errorCtx.step,
          }
        : undefined,
    };

    let mergedOptions: Record<string, unknown>;
    try {
      mergedOptions = resolveReferences(rawOptions, refCtx);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }

    this.logger.info(
      { step: step.stepNumber, task: step.name, type: step.type },
      `Executing step ${step.stepNumber}: ${step.name}`,
    );

    return this.executeTask(
      taskDef.classPath,
      mergedOptions,
      refCtx,
      step.phase ?? DEFAULT_EXECUTION_PHASE,
      step.name,
      site,
    );
  }

  private async performRollback(records: HarvestedRollback[]): Promise<RollbackResult> {
    const result: RollbackResult = { attempted: 0, succeeded: 0, errors: [] };

    for (let i = records.length - 1; i >= 0; i--) {
      const rec = records[i]!;
      result.attempted++;
      try {
        // A rollback payload is runtime data the task recorded, not
        // configuration: `resolveTaskCall` interpolates the inverse task's
        // configured defaults and merges the payload over them verbatim, so a
        // `${...}` captured in recorded data is neither substituted nor thrown
        // on — which the catch below would turn into a silently failed rollback.
        const resolved = resolveTaskCall(
          rec.taskName,
          this.tasks,
          rec.payload,
          this.baseReferences,
        );
        const r = await this.executeTask(
          resolved.classPath,
          resolved.options,
          this.baseReferences,
          'rollback',
          rec.taskName,
        );
        if (r.success) {
          result.succeeded++;
        } else {
          result.errors.push({
            taskName: rec.taskName,
            error: r.error ?? new Error(`Rollback ${rec.taskName} returned failure`),
            ...(rec.fromFailedStep ? { fromFailedStep: true } : {}),
          });
        }
      } catch (err) {
        result.errors.push({
          taskName: rec.taskName,
          error: err instanceof Error ? err : new Error(String(err)),
          ...(rec.fromFailedStep ? { fromFailedStep: true } : {}),
        });
      }
    }

    return result;
  }
}

const STEP_REF = /\$\{steps\.([^}]+)\}/g;

/** Every `${steps.<ref>}` body in the strings found anywhere inside `values`. */
function stepReferencesIn(values: unknown[]): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(STEP_REF)) out.push(m[1]!);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      Object.values(v).forEach(walk);
    }
  };
  values.forEach(walk);
  return out;
}

/**
 * Bind one reference the way the resolver does (longest id prefix first,
 * a number is a step number, anything else a step name) and report why it
 * cannot be bound to exactly one earlier main step.
 */
function bindStepReference(
  ref: string,
  from: PlanStep,
  byName: Map<string, number[]>,
  numbers: Set<number>,
): Pick<StepReferenceIssue, 'kind' | 'message'> | undefined {
  const segments = ref.split('.');
  // Hook steps run after every main step that ran.
  const before = (n: number) => from.phase !== undefined || n < from.stepNumber;
  for (let i = segments.length; i >= 1; i--) {
    const id = segments.slice(0, i).join('.');
    if (/^\d+$/.test(id)) {
      const n = Number(id);
      if (!numbers.has(n)) return { kind: 'unknown', message: `\${steps.${ref}} names step ${id}, which does not exist` };
      if (!before(n)) {
        return { kind: 'forward', message: `\${steps.${ref}} names step ${id}, which has not run yet` };
      }
      return undefined;
    }
    const matches = byName.get(id);
    if (!matches) continue;
    if (matches.length > 1) {
      return {
        kind: 'ambiguous',
        message: `\${steps.${ref}}: "${id}" is the name of steps ${matches.join(', ')}; reference one by number`,
      };
    }
    if (!before(matches[0]!)) {
      return { kind: 'forward', message: `\${steps.${ref}}: step "${id}" has not run yet` };
    }
    return undefined;
  }
  return { kind: 'unknown', message: `\${steps.${ref}} matches no step number or name in the flow` };
}

/**
 * Interpolate what can be interpolated before a run: host namespaces resolve,
 * and anything that throws (a step reference, nothing having run) is left as
 * written.
 */
function lenientReferences(value: Record<string, unknown>, refs: ReferenceContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    try {
      out[k] = resolveReferences(v, refs);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Harvest a task result's rollback records, its composite children's first
 * (recursively, child flows' steps included), then its own.
 */
function harvestRollbacks(result: TaskResult, into: HarvestedRollback[]): void {
  for (const child of result.children ?? []) harvestStep(child, into);
  if (result.rollback) {
    into.push({
      taskName: result.rollback.taskName,
      payload: result.rollback.payload,
      fromFailedStep: !result.success,
    });
  }
}

function harvestStep(step: FlowStepResult, into: HarvestedRollback[]): void {
  if (step.result) harvestRollbacks(step.result, into);
  for (const nested of step.nestedSteps ?? []) harvestStep(nested, into);
}

/** Status a set of evaluated checks gives a preflight row. Error beats skip beats unknown. */
function checkStatus(outcomes: CheckOutcome[]): PreflightStep['status'] {
  if (outcomes.some((o) => o.triggered && o.action === 'error')) return 'error';
  if (outcomes.some((o) => o.triggered && o.action === 'skip')) return 'skip';
  if (outcomes.some((o) => o.error)) return 'unknown';
  return 'run';
}

function defaultCheckMessage(check: StepCheck, subject: string | undefined): string {
  const cond = typeof check.when === 'string' ? check.when : String(check.when);
  return `Check on ${subject ? `"${subject}"` : 'step'} fired (${check.action}): ${cond}`;
}

/** The warning a fired `warn` check contributes to a run. */
function checkWarning(o: CheckOutcome): RunWarning {
  return {
    code: 'check',
    message: o.message,
    name: o.scope === 'flow' ? o.flowName : (o.name ?? o.flowName),
    kind: o.scope === 'flow' ? 'flow' : undefined,
    ...(o.stepNumber !== undefined ? { stepNumber: o.stepNumber } : {}),
  } as RunWarning;
}

/** Append a runner notice to a task's result without dropping any the task added itself. */
function withWarnings(result: TaskResult, warning: RunWarning | undefined): TaskResult {
  if (!warning) return result;
  result.warnings = [...(result.warnings ?? []), warning];
  return result;
}

/** Truthiness of a resolved `when:` value, with string special-cases. */
function truthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value == null) return false;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase();
  return !(s === '' || s === 'false' || s === '0' || s === 'null' || s === 'undefined');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
