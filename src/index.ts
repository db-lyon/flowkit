// Config
export { deepMerge } from './config/deep-merge.js';
export {
  TaskOptionsSchema,
  TaskDefinitionSchema,
  FlowStepSchema,
  FlowDefinitionSchema,
  AgentToolSchema,
  AgentBudgetSchema,
  AgentDefinitionSchema,
  EngineConfigSchema,
} from './config/schema.js';
export type {
  TaskOptions,
  TaskDefinition,
  FlowStep,
  FlowDefinition,
  AgentTool,
  AgentBudget,
  AgentDefinition,
  EngineConfig,
} from './config/schema.js';
export { loadConfig, loadRawYaml, findConfigFile } from './config/loader.js';
export type { LoadConfigOptions, LoadedConfig } from './config/loader.js';

// Task
export { BaseTask } from './task/base-task.js';
export type { TaskContext, TaskResult, RollbackRecord } from './task/base-task.js';
export { ShellTask } from './task/shell-task.js';
export type { ShellTaskOptions } from './task/shell-task.js';
export { TaskRegistry } from './task/registry.js';
export type { TaskConstructor } from './task/registry.js';
export { AgentPromptTask } from './task/agent-prompt-task.js';
export type { AgentPromptOptions } from './task/agent-prompt-task.js';
export { AgentTask } from './task/agent-task.js';
export type { AgentTaskOptions, AgentToolSpec } from './task/agent-task.js';
export {
  runCompletion,
  pickRunOptions,
  LLMTimeoutError,
  StructuredOutputError,
} from './task/llm-runner.js';
export type { LLMRunOptions, LLMRunResult, AgentRunFields } from './task/llm-runner.js';
export { validateJson, formatErrors } from './task/json-schema.js';
export type { ValidationError, ValidationResult } from './task/json-schema.js';
export { redact, truncate, preview } from './task/redact.js';
export type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMMessage,
  LLMRole,
  LLMToolCall,
  LLMToolDefinition,
  LLMToolChoice,
  LLMToolHandler,
} from './task/llm-provider.js';

// Flow
export { FlowRunner } from './flow/runner.js';
export type {
  FlowRunOptions,
  FlowStepResult,
  FlowRunResult,
  FlowRunnerHooks,
  FlowRunnerConfig,
  PlanStep,
  HookPhase,
  HookError,
  RollbackResult,
} from './flow/runner.js';
export { resolveReferences } from './flow/references.js';
export type { ReferenceableStep, ReferenceContext } from './flow/references.js';

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
