export { deepMerge } from './deep-merge.js';

export {
  TaskOptionsSchema,
  TaskDefinitionSchema,
  FlowStepSchema,
  FlowDefinitionSchema,
  AgentToolSchema,
  AgentBudgetSchema,
  AgentDefinitionSchema,
  EngineConfigSchema,
} from './schema.js';

export type {
  TaskOptions,
  TaskDefinition,
  FlowStep,
  FlowDefinition,
  AgentTool,
  AgentBudget,
  AgentDefinition,
  EngineConfig,
} from './schema.js';

export { loadConfig, loadRawYaml, findConfigFile } from './loader.js';
export type { LoadConfigOptions, LoadedConfig } from './loader.js';
