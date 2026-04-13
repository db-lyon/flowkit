export { deepMerge } from './deep-merge.js';

export {
  TaskOptionsSchema,
  TaskDefinitionSchema,
  FlowStepSchema,
  FlowDefinitionSchema,
  EngineConfigSchema,
} from './schema.js';

export type {
  TaskOptions,
  TaskDefinition,
  FlowStep,
  FlowDefinition,
  EngineConfig,
} from './schema.js';

export { loadConfig, loadRawYaml, findConfigFile } from './loader.js';
export type { LoadConfigOptions, LoadedConfig } from './loader.js';
