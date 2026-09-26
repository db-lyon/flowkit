export { deepMerge } from './deep-merge.js';

export {
  TaskOptionsSchema,
  OptionSpecSchema,
  OptionSpecsSchema,
  OutputSpecSchema,
  OutputSpecsSchema,
  TaskDefinitionSchema,
  FlowStepSchema,
  StepCheckSchema,
  FlowStepObjectSchema,
  FlowStepsSchema,
  refineFlowStep,
  FlowDefinitionSchema,
  AgentToolSchema,
  AgentBudgetSchema,
  AgentDefinitionSchema,
  EngineConfigSchema,
} from './schema.js';

export type {
  TaskOptions,
  OptionSpec,
  OptionSpecs,
  OutputSpec,
  OutputSpecs,
  TaskDefinition,
  FlowStep,
  StepCheck,
  FlowDefinition,
  AgentTool,
  AgentBudget,
  AgentDefinition,
  EngineConfig,
} from './schema.js';

export { loadConfig, loadRawYaml, findConfigFile } from './loader.js';
export type { LoadConfigOptions, LoadedConfig } from './loader.js';
export { findUnknownKeys, assertKnownKeys, UnknownConfigKeyError } from './strict.js';
export type { UnknownConfigKey, FindUnknownKeysOptions } from './strict.js';
