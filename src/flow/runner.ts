import type { Logger } from '../logger.js';
import { noopLogger } from '../logger.js';
import type { TaskDefinition, FlowDefinition, FlowStep } from '../config/schema.js';
import type { TaskResult, RollbackRecord } from '../task/base-task.js';
import type { TaskContext } from '../task/base-task.js';
import type { TaskRegistry } from '../task/registry.js';
import { resolveReferences, type ReferenceContext } from './references.js';

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

export interface FlowRunOptions {
  flowName: string;
  skip?: string[];
  plan?: boolean;
  /** Runtime parameters — merged into every step's options with highest priority. */
  params?: Record<string, unknown>;
  /** If true, invoke rollback records from completed steps in reverse order on failure. */
  rollback_on_failure?: boolean;
  /**
   * Plan mode only: recursively expand nested-flow steps into their child steps
   * (each annotated with a hierarchical `path`). Default false preserves the
   * flat, one-line-per-flow-step plan.
   */
  expandNestedFlows?: boolean;
}

/** Context handed to a `conditionEvaluator` when resolving a string `when:`. */
export interface ConditionContext {
  steps: FlowStepResult[];
  params?: Record<string, unknown>;
  context: TaskContext;
  error?: { message: string; name: string; stack?: string; step?: string };
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
  /** Why the step was skipped: 'static' (skip list / task: None) or 'when' (condition false). */
  skipReason?: 'static' | 'when';
  /** True when the step failed but `ignore_failure` let the flow continue. */
  ignoredFailure?: boolean;
}

export interface HookError {
  phase: HookPhase;
  name: string;
  error: Error;
}

export interface RollbackResult {
  attempted: number;
  succeeded: number;
  errors: { taskName: string; error: Error }[];
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
  /** For hook steps: the phase they belong to. Undefined for main steps. */
  phase?: HookPhase;
  /** Hierarchical id (e.g. "2/1") — only set when a plan expands nested flows. */
  path?: string;
  /** Nesting depth — 0 for top-level, increments per expanded nested flow. */
  depth?: number;
}

export interface FlowRunnerHooks {
  beforeRun?(flowName: string, plan: PlanStep[]): Promise<void>;
  afterRun?(result: FlowRunResult): Promise<void>;
  beforeStep?(step: PlanStep): Promise<void>;
  afterStep?(step: PlanStep, result: FlowStepResult): Promise<void>;
  onStepError?(step: PlanStep, error: Error, completed: FlowStepResult[]): Promise<void>;
}

export interface FlowRunnerConfig {
  tasks: Record<string, TaskDefinition>;
  flows: Record<string, FlowDefinition>;
  registry: TaskRegistry;
  context: TaskContext;
  hooks?: FlowRunnerHooks;
  logger?: Logger;
  /** Optional evaluator for string `when:` expressions. */
  conditionEvaluator?: ConditionEvaluator;
  /**
   * Host-supplied reference namespaces for `${ns.path}` interpolation in option
   * values, e.g. `{ project, org, env }`. `steps` and `error` are always built in.
   */
  references?: Record<string, unknown>;
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
  private runDepth = 0;

  constructor(config: FlowRunnerConfig) {
    this.logger = (config.logger ?? noopLogger).child({ component: 'flow-runner' });
    this.tasks = config.tasks;
    this.flows = config.flows;
    this.registry = config.registry;
    this.hooks = config.hooks ?? {};
    this.conditionEvaluator = config.conditionEvaluator;
    this.references = config.references;
    this.ctx = { ...config.context, registry: config.registry };
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
    const taskDef = this.resolveTaskDefinition(taskName);
    this.logger.info({ task: taskName }, `Running task ${taskName}`);
    // Interpolate ${ns.path} references in option values (no prior steps here).
    const merged = resolveReferences({ ...taskDef.options, ...options }, {
      steps: [],
      namespaces: this.references,
    });
    return this.executeTask(taskDef.class_path, merged);
  }

  /** Instantiate and run a task with fully-resolved options (the shared leaf). */
  private async executeTask(classPath: string, options: Record<string, unknown>): Promise<TaskResult> {
    const task = await this.registry.create(classPath, this.ctx, options);
    return task.run();
  }

  private async runWith(
    options: FlowRunOptions,
    parentOptions: ParentOptions,
  ): Promise<FlowRunResult> {
    this.runDepth++;
    const isTopLevel = this.runDepth === 1;
    try {
      return await this.executeFlow(options, isTopLevel, parentOptions);
    } finally {
      this.runDepth--;
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

  /** Evaluate a step's `when:` to a boolean. Undefined `when` always runs. */
  private async evaluateWhen(
    when: string | boolean | undefined,
    completedSteps: FlowStepResult[],
    params: Record<string, unknown> | undefined,
    errorCtx?: { error: Error; step?: string },
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
        context: this.ctx,
        error,
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

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async executeFlow(
    options: FlowRunOptions,
    isTopLevel: boolean,
    parentOptions: ParentOptions,
  ): Promise<FlowRunResult> {
    const startTime = Date.now();
    const skipSet = new Set(options.skip ?? []);
    const completedSteps: FlowStepResult[] = [];
    const hookErrors: HookError[] = [];
    const rollbackRecords: { taskName: string; payload: Record<string, unknown> }[] = [];

    const flow = this.flows[options.flowName];
    if (!flow) {
      throw new Error(`Flow "${options.flowName}" not found in configuration`);
    }

    const rollbackEnabled = options.rollback_on_failure ?? flow.rollback_on_failure ?? false;

    const executionPlan = this.resolveExecutionPlan(flow, skipSet);

    // Plan mode — dump all phases for visibility, nothing runs.
    if (options.plan) {
      const mainPlan = options.expandNestedFlows
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
      const fullPlan: PlanStep[] = [
        ...this.planHookSteps(flow.on_start, 'on_start', skipSet, -3000),
        ...mainPlan,
        ...this.planHookSteps(flow.on_success, 'on_success', skipSet, 10_000),
        ...this.planHookSteps(flow.on_failure, 'on_failure', skipSet, 20_000),
        ...this.planHookSteps(flow.finally, 'finally', skipSet, 30_000),
      ];
      return {
        success: true,
        steps: fullPlan.map((s) => ({
          stepNumber: s.stepNumber,
          type: s.type,
          name: s.name,
          skipped: s.skipped,
          duration: 0,
          ...(s.path !== undefined ? { path: s.path, depth: s.depth } : {}),
        })) as unknown as FlowStepResult[],
        duration: 0,
      };
    }

    if (isTopLevel) {
      await this.hooks.beforeRun?.(options.flowName, executionPlan);
    }

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
            conditionMet = await this.evaluateWhen(planStep.when, completedSteps, options.params);
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

        await this.hooks.beforeStep?.(planStep);
        const stepStart = Date.now();

        try {
          let stepResult: FlowStepResult;

          if (planStep.type === 'task') {
            const { result: taskResult, attempts } = await this.executeTaskStepWithRetry(
              planStep,
              options.params,
              completedSteps,
              parentOptions,
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
            if (taskResult.success && taskResult.rollback) {
              rollbackRecords.push({
                taskName: taskResult.rollback.taskName,
                payload: taskResult.rollback.payload,
              });
            }
          } else {
            const childParentOptions = this.mergeParentOptions(parentOptions, planStep.options);
            const nestedResult = await this.runWith(
              { ...options, flowName: planStep.name, plan: false },
              childParentOptions,
            );
            stepResult = {
              stepNumber: planStep.stepNumber,
              type: 'flow',
              name: planStep.name,
              result: {
                success: nestedResult.success,
                data: { stepCount: nestedResult.steps.length },
                error: nestedResult.success ? undefined : nestedResult.error,
              },
              skipped: false,
              duration: Date.now() - stepStart,
            };
            // Bubble nested rollback records up so the parent can invoke them.
            for (const s of nestedResult.steps) {
              if (s.result?.success && s.result?.rollback) {
                rollbackRecords.push({
                  taskName: s.result.rollback.taskName,
                  payload: s.result.rollback.payload,
                });
              }
            }
          }

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
        );
      }
    } else {
      const successPlan = this.planHookSteps(flow.on_success, 'on_success', skipSet, 10_000);
      for (const hookStep of successPlan) {
        await this.runHookStep(hookStep, options, completedSteps, parentOptions, undefined, hookErrors);
      }
    }

    // ---- rollback ----
    let rollbackResult: RollbackResult | undefined;
    if (flowError && rollbackEnabled && rollbackRecords.length > 0) {
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
  ): Promise<boolean> {
    if (hookStep.skipped) return true;

    // Hook steps honor `when:` too — a falsy condition skips them silently.
    if (hookStep.when !== undefined) {
      try {
        const ok = await this.evaluateWhen(hookStep.when, completedSteps, options.params, errorCtx);
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

    try {
      if (hookStep.type === 'flow') {
        const childParentOptions = this.mergeParentOptions(parentOptions, hookStep.options);
        const nested = await this.runWith(
          { ...options, flowName: hookStep.name, plan: false },
          childParentOptions,
        );
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
        options.params,
        completedSteps,
        parentOptions,
        errorCtx,
      );
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
  ): Promise<{ result: TaskResult; attempts: number }> {
    const maxAttempts = Math.max(1, 1 + (step.retries ?? 0));
    const delayMs = step.retryDelay ?? 0;
    const retryOn = step.retryOn;

    let lastResult: TaskResult = { success: false, error: new Error('no attempts executed') };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastResult = await this.executeTaskStep(
        step,
        flowParams,
        completedSteps,
        parentOptions,
        errorCtx,
      );
      if (lastResult.success) return { result: lastResult, attempts: attempt };

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
  ): Promise<TaskResult> {
    const taskDef = this.resolveTaskDefinition(step.name);
    // Precedence (low → high): task default → enclosing-flow override → step inline → runtime params.
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

    return this.executeTask(taskDef.class_path, mergedOptions);
  }

  private async performRollback(
    records: { taskName: string; payload: Record<string, unknown> }[],
  ): Promise<RollbackResult> {
    const result: RollbackResult = { attempted: 0, succeeded: 0, errors: [] };

    for (let i = records.length - 1; i >= 0; i--) {
      const rec = records[i]!;
      result.attempted++;
      try {
        const taskDef = this.resolveTaskDefinition(rec.taskName);
        const r = await this.executeTask(taskDef.class_path, { ...taskDef.options, ...rec.payload });
        if (r.success) {
          result.succeeded++;
        } else {
          result.errors.push({
            taskName: rec.taskName,
            error: r.error ?? new Error(`Rollback ${rec.taskName} returned failure`),
          });
        }
      } catch (err) {
        result.errors.push({
          taskName: rec.taskName,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    return result;
  }

  private resolveTaskDefinition(taskName: string): {
    class_path: string;
    options: Record<string, unknown>;
  } {
    const taskDef = this.tasks[taskName];
    if (taskDef) {
      return { class_path: taskDef.class_path, options: taskDef.options ?? {} };
    }
    return { class_path: taskName, options: {} };
  }
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
