import type { Logger } from '../logger.js';
import { noopLogger } from '../logger.js';
import type { TaskDefinition, FlowDefinition, FlowStep } from '../config/schema.js';
import type { TaskResult } from '../task/base-task.js';
import type { TaskContext } from '../task/base-task.js';
import type { TaskRegistry } from '../task/registry.js';
import { resolveReferences } from './references.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FlowRunOptions {
  flowName: string;
  skip?: string[];
  plan?: boolean;
  /** Runtime parameters — merged into every step's options with highest priority. */
  params?: Record<string, unknown>;
}

export interface FlowStepResult {
  stepNumber: number;
  type: 'task' | 'flow';
  name: string;
  result?: TaskResult;
  skipped: boolean;
  duration: number;
}

export interface FlowRunResult {
  success: boolean;
  steps: FlowStepResult[];
  duration: number;
  error?: Error;
}

export interface PlanStep {
  stepNumber: number;
  type: 'task' | 'flow';
  name: string;
  skipped: boolean;
  options?: Record<string, unknown>;
}

export interface FlowRunnerHooks {
  /** Fires once before the top-level flow starts (not for nested flows). */
  beforeRun?(flowName: string, plan: PlanStep[]): Promise<void>;
  /** Fires once after the top-level flow completes (success or failure). */
  afterRun?(result: FlowRunResult): Promise<void>;
  /** Fires before every step (including steps inside nested flows). */
  beforeStep?(step: PlanStep): Promise<void>;
  /** Fires after every step. */
  afterStep?(step: PlanStep, result: FlowStepResult): Promise<void>;
  /** Fires when a step fails — before afterRun. */
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

    // Inject registry into context so tasks can resolve/call other tasks.
    // Spread to avoid mutating the caller's context object.
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

  /** Flatten a flow definition into an ordered execution plan. */
  resolveExecutionPlan(flow: FlowDefinition, skipSet: Set<string>): PlanStep[] {
    const sortedKeys = Object.keys(flow.steps)
      .map(Number)
      .sort((a, b) => a - b);

    return sortedKeys.map((key) => {
      const step = flow.steps[String(key)] as FlowStep;

      if (step.task === 'None') {
        return { stepNumber: key, type: 'task' as const, name: 'None', skipped: true };
      }

      const name = (step.task ?? step.flow)!;
      const type = step.task ? ('task' as const) : ('flow' as const);

      return {
        stepNumber: key,
        type,
        name,
        skipped: skipSet.has(name) || skipSet.has(String(key)),
        options: step.options as Record<string, unknown> | undefined,
      };
    });
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

    const flow = this.flows[options.flowName];
    if (!flow) {
      throw new Error(`Flow "${options.flowName}" not found in configuration`);
    }

    const executionPlan = this.resolveExecutionPlan(flow, skipSet);

    // Plan mode — return the plan without executing anything
    if (options.plan) {
      return {
        success: true,
        steps: executionPlan.map((s) => ({
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

    for (const planStep of executionPlan) {
      // ---- Skipped steps ----
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

      // ---- Active steps ----
      await this.hooks.beforeStep?.(planStep);
      const stepStart = Date.now();

      try {
        let stepResult: FlowStepResult;

        if (planStep.type === 'task') {
          const taskResult = await this.executeTaskStep(
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
          };
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
          if (!nestedResult.success) {
            flowError = nestedResult.error ?? new Error(`Nested flow ${planStep.name} failed`);
          }
        }

        completedSteps.push(stepResult);
        await this.hooks.afterStep?.(planStep, stepResult);

        if (!stepResult.result?.success) {
          flowError =
            flowError ?? stepResult.result?.error ?? new Error(`Step ${planStep.name} failed`);
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
        await this.hooks.onStepError?.(planStep, err, completedSteps);
        break;
      }
    }

    const result: FlowRunResult = {
      success: !flowError,
      steps: completedSteps,
      duration: Date.now() - startTime,
      error: flowError,
    };

    if (isTopLevel) {
      await this.hooks.afterRun?.(result);
    }

    return result;
  }

  private async executeTaskStep(
    step: PlanStep,
    flowParams?: Record<string, unknown>,
    completedSteps: FlowStepResult[] = [],
  ): Promise<TaskResult> {
    const taskDef = this.resolveTaskDefinition(step.name);
    // Priority: task defaults < step options < runtime params
    const rawOptions = { ...taskDef.options, ...step.options, ...flowParams };
    // Resolve ${steps.<id>.<path>} references against prior completed steps.
    const mergedOptions = resolveReferences(rawOptions, completedSteps);

    this.logger.info(
      { step: step.stepNumber, task: step.name, type: step.type },
      `Executing step ${step.stepNumber}: ${step.name}`,
    );

    const task = await this.registry.create(taskDef.class_path, this.ctx, mergedOptions);
    return task.run();
  }

  private resolveTaskDefinition(taskName: string): {
    class_path: string;
    options: Record<string, unknown>;
  } {
    const taskDef = this.tasks[taskName];
    if (taskDef) {
      return { class_path: taskDef.class_path, options: taskDef.options ?? {} };
    }

    // Allow using a class_path directly as the task reference
    return { class_path: taskName, options: {} };
  }
}
