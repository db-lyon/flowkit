import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { z } from 'zod';
import { deepMerge } from './deep-merge.js';

/**
 * Walk up parent directories looking for `filename`.
 */
export function findConfigFile(filename: string, startDir?: string): string {
  let dir = startDir ?? process.cwd();
  const root = path.parse(dir).root;

  while (dir !== root) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }

  throw new Error(`Could not find ${filename} in any parent directory`);
}

export function loadRawYaml(filePath: string): unknown {
  const content = fs.readFileSync(filePath, 'utf8');
  return yaml.load(content);
}

export interface LoadConfigOptions<T extends z.ZodType> {
  /** Primary config filename, e.g. `'myapp.yml'` */
  filename: string;
  /** Zod schema — applied after all layers are merged */
  schema: T;
  /** Builtin defaults merged under the project file */
  defaults?: unknown;
  /** Environment name — loads `{base}.{env}.{ext}` overlay */
  env?: string;
  /** Env var to read environment name from when `env` is not passed */
  envVar?: string;
  /** Directory to search for config files (default: cwd) */
  configDir?: string;
}

export interface LoadedConfig<T> {
  config: T;
  configDir: string;
}

/**
 * Layered config loader:
 *
 *     defaults  →  {filename}  →  {base}.{env}.{ext}  →  {base}.local.{ext}
 *
 * Each layer is deep-merged left-to-right, then validated through the Zod schema.
 */
export function loadConfig<T extends z.ZodType>(
  options: LoadConfigOptions<T>,
): LoadedConfig<z.infer<T>> {
  const configDir = options.configDir ?? process.cwd();
  const ext = path.extname(options.filename);
  const base = path.basename(options.filename, ext);
  const rootPath = path.join(configDir, options.filename);

  if (!fs.existsSync(rootPath)) {
    throw new Error(`Configuration file not found: ${rootPath}`);
  }

  // Layer 1: builtin defaults
  let config: unknown = options.defaults ?? {};

  // Layer 2: project file
  const projectConfig = loadRawYaml(rootPath);
  config = deepMerge(config, projectConfig);

  // Layer 3: environment overlay
  const env = options.env ?? (options.envVar ? process.env[options.envVar] : undefined);
  if (env) {
    const envPath = path.join(configDir, `${base}.${env}${ext}`);
    if (fs.existsSync(envPath)) {
      config = deepMerge(config, loadRawYaml(envPath));
    }
  }

  // Layer 4: local overrides (never committed)
  const localPath = path.join(configDir, `${base}.local${ext}`);
  if (fs.existsSync(localPath)) {
    config = deepMerge(config, loadRawYaml(localPath));
  }

  return { config: options.schema.parse(config), configDir };
}
