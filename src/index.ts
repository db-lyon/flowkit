// Config
export { deepMerge } from './config/deep-merge.js';
export {
  TaskOptionsSchema,
  TaskDefinitionSchema,
  FlowStepSchema,
  FlowDefinitionSchema,
  EngineConfigSchema,
} from './config/schema.js';
export type {
  TaskOptions,
  TaskDefinition,
  FlowStep,
  FlowDefinition,
  EngineConfig,
} from './config/schema.js';
export { loadConfig, loadRawYaml, findConfigFile } from './config/loader.js';
export type { LoadConfigOptions, LoadedConfig } from './config/loader.js';

// Task
export { BaseTask } from './task/base-task.js';
export type { TaskContext, TaskResult } from './task/base-task.js';
export { ShellTask } from './task/shell-task.js';
export type { ShellTaskOptions } from './task/shell-task.js';
export { TaskRegistry } from './task/registry.js';
export type { TaskConstructor } from './task/registry.js';

// Flow
export { FlowRunner } from './flow/runner.js';
export type {
  FlowRunOptions,
  FlowStepResult,
  FlowRunResult,
  FlowRunnerHooks,
  FlowRunnerConfig,
  PlanStep,
} from './flow/runner.js';
export { resolveReferences } from './flow/references.js';
export type { ReferenceableStep } from './flow/references.js';

// DAG
export {
  topologicalSort,
  CircularDependencyError,
  MissingDependencyError,
} from './dag/resolver.js';
export type { DagNode } from './dag/resolver.js';

// Logger
export type { Logger } from './logger.js';
export { noopLogger } from './logger.js';
