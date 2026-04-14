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

export interface FlowRunOptions {
  flowName: string;
  skip?: string[];
  plan?: boolean;
  /** Runtime parameters — merged into every step's options with highest priority. */
  params?: Record<string, unknown>;
  /** If true, invoke rollback records from completed steps in reverse order on failure. */
  rollback_on_failure?: boolean;
}

export interface FlowStepResult {
  stepNumber: number;
  type: 'task' | 'flow';
  name: string;
  result?: TaskResult;
  skipped: boolean;
  duration: number;
  /** Number of attempts including the first try (≥1 when executed). */
  attempts?: number;
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
  /** For hook steps: the phase they belong to. Undefined for main steps. */
  phase?: HookPhase;
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
  private runDepth = 0;

  constructor(config: FlowRunnerConfig) {
    this.logger = (config.logger ?? noopLogger).child({ component: 'flow-runner' });
    this.tasks = config.tasks;
    this.flows = config.flows;
    this.registry = config.registry;
    this.hooks = config.hooks ?? {};
    this.ctx = { ...config.context, registry: config.registry };
  }

  async run(options: FlowRunOptions): Promise<FlowRunResult> {
    this.runDepth++;
    const isTopLevel = this.runDepth === 1;
    try {
      return await this.executeFlow(options, isTopLevel);
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

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async executeFlow(
    options: FlowRunOptions,
    isTopLevel: boolean,
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
      const fullPlan: PlanStep[] = [
        ...this.planHookSteps(flow.on_start, 'on_start', skipSet, -3000),
        ...executionPlan,
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
        })),
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
        if (planStep.skipped) {
          const sr: FlowStepResult = {
            stepNumber: planStep.stepNumber,
            type: planStep.type,
            name: planStep.name,
            skipped: true,
            duration: 0,
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
            const nestedResult = await this.run({
              ...options,
              flowName: planStep.name,
              plan: false,
            });
            stepResult = {
              stepNumber: planStep.stepNumber,
              type: 'flow',
              name: planStep.name,
              result: {
                success: nestedResult.success,
                data: { stepCount: nestedResult.steps.length },
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
            if (!nestedResult.success) {
              flowError = nestedResult.error ?? new Error(`Nested flow ${planStep.name} failed`);
              flowErrorStepName = planStep.name;
            }
          }

          completedSteps.push(stepResult);
          await this.hooks.afterStep?.(planStep, stepResult);

          if (!stepResult.result?.success) {
            flowError =
              flowError ?? stepResult.result?.error ?? new Error(`Step ${planStep.name} failed`);
            flowErrorStepName = flowErrorStepName ?? planStep.name;
            await this.hooks.onStepError?.(planStep, flowError, completedSteps);
            break;
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          completedSteps.push({
            stepNumber: planStep.stepNumber,
            type: planStep.type,
            name: planStep.name,
            skipped: false,
            duration: Date.now() - stepStart,
            result: { success: false, error: err },
          });
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
          { error: flowError, step: flowErrorStepName },
          hookErrors,
        );
      }
    } else {
      const successPlan = this.planHookSteps(flow.on_success, 'on_success', skipSet, 10_000);
      for (const hookStep of successPlan) {
        await this.runHookStep(hookStep, options, completedSteps, undefined, hookErrors);
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
    errorCtx: { error: Error; step?: string } | undefined,
    hookErrors: HookError[],
  ): Promise<boolean> {
    if (hookStep.skipped) return true;
    try {
      if (hookStep.type === 'flow') {
        const nested = await this.run({
          ...options,
          flowName: hookStep.name,
          plan: false,
        });
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
    errorCtx?: { error: Error; step?: string },
  ): Promise<{ result: TaskResult; attempts: number }> {
    const maxAttempts = Math.max(1, 1 + (step.retries ?? 0));
    const delayMs = step.retryDelay ?? 0;
    const retryOn = step.retryOn;

    let lastResult: TaskResult = { success: false, error: new Error('no attempts executed') };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastResult = await this.executeTaskStep(step, flowParams, completedSteps, errorCtx);
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
    errorCtx?: { error: Error; step?: string },
  ): Promise<TaskResult> {
    const taskDef = this.resolveTaskDefinition(step.name);
    const rawOptions = { ...taskDef.options, ...step.options, ...flowParams };

    const refCtx: ReferenceContext = {
      steps: completedSteps,
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

    const task = await this.registry.create(taskDef.class_path, this.ctx, mergedOptions);
    return task.run();
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
        const task = await this.registry.create(taskDef.class_path, this.ctx, {
          ...taskDef.options,
          ...rec.payload,
        });
        const r = await task.run();
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
