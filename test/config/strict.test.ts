import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { loadConfig } from '../../src/config/loader.js';
import { EngineConfigSchema } from '../../src/config/schema.js';
import {
  findUnknownKeys,
  assertKnownKeys,
  UnknownConfigKeyError,
} from '../../src/config/strict.js';

describe('findUnknownKeys', () => {
  it('reports nothing for a clean engine config', () => {
    const config = {
      tasks: { build: { class_path: 'x', options: { anything: { goes: 1 } }, description: 'd' } },
      flows: {
        ci: {
          description: 'ci',
          steps: { 1: { task: 'build', when: true, ignore_failure: true, retries: 1 } },
          on_failure: [{ task: 'build' }],
        },
      },
      agents: { a: { tools: [{ task: 'build' }], budget: { maxIterations: 2 } } },
    };
    expect(findUnknownKeys(EngineConfigSchema, config)).toEqual([]);
  });

  it('reports each unknown key with a path and a suggestion', () => {
    const config = {
      tasks: { 'asset.list': { class_path: 'x', descripton: 'typo' } },
      flows: {
        ci: {
          steps: { 2: { task: 'build', retires: 3 } },
          finally: [{ task: 'x', ignore_failur: true }],
          rollback: true,
        },
      },
      agents: { a: { budget: { maxIteration: 2 } } },
      bogus: {},
    };
    const found = findUnknownKeys(EngineConfigSchema, config);
    expect(found).toEqual([
      { path: 'tasks["asset.list"].descripton', key: 'descripton', suggestion: 'description' },
      { path: 'flows.ci.steps.2.retires', key: 'retires', suggestion: 'retries' },
      { path: 'flows.ci.finally[0].ignore_failur', key: 'ignore_failur', suggestion: 'ignore_failure' },
      { path: 'flows.ci.rollback', key: 'rollback', suggestion: undefined },
      { path: 'agents.a.budget.maxIteration', key: 'maxIteration', suggestion: 'maxIterations' },
      { path: 'bogus', key: 'bogus', suggestion: undefined },
    ]);
  });

  it('checks host sections declared by an extended schema, and honours passthrough', () => {
    const Host = EngineConfigSchema.extend({
      project: z.object({ name: z.string() }).optional(),
      meta: z.object({}).passthrough().optional(),
    });
    const config = { project: { name: 'p', nmae: 'x' }, meta: { free: 1 }, bridge: { port: 1 } };
    expect(findUnknownKeys(Host, config).map((k) => k.path)).toEqual(['project.nmae', 'bridge']);
    expect(findUnknownKeys(Host, config, { passthroughKeys: ['bridge'] }).map((k) => k.path)).toEqual([
      'project.nmae',
    ]);
  });

  it('only skips passthrough keys at the top level', () => {
    const config = { flows: { ci: { steps: { 1: { task: 'a', bridge: 1 } } } }, bridge: 1 };
    expect(findUnknownKeys(EngineConfigSchema, config, { passthroughKeys: ['bridge'] })).toEqual([
      expect.objectContaining({ path: 'flows.ci.steps.1.bridge' }),
    ]);
  });

  it('follows the union branch the value parses as', () => {
    const S = z.object({
      v: z.union([z.object({ a: z.number() }), z.object({ b: z.string(), c: z.string().optional() })]),
    });
    expect(findUnknownKeys(S, { v: { b: 'x', d: 1 } }).map((k) => k.path)).toEqual(['v.d']);
    expect(findUnknownKeys(S, { v: { a: 1 } })).toEqual([]);
  });

  it('assertKnownKeys throws an UnknownConfigKeyError listing every path', () => {
    try {
      assertKnownKeys(EngineConfigSchema, { flows: { ci: { steps: { 1: { task: 'a', retires: 1 } } } } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownConfigKeyError);
      expect((err as Error).message).toContain('flows.ci.steps.1.retires (did you mean "retries"?)');
      expect((err as UnknownConfigKeyError).keys).toHaveLength(1);
    }
  });
});

describe('loadConfig strict', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowkit-strict-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const yaml = [
    'flows:',
    '  ci:',
    '    steps:',
    '      1: { task: build, retires: 2 }',
    'bridge:',
    '  port: 1',
    '',
  ].join('\n');

  it('drops unknown keys silently by default, as before', () => {
    fs.writeFileSync(path.join(tmpDir, 'app.yml'), yaml);
    const { config } = loadConfig({ filename: 'app.yml', schema: EngineConfigSchema, configDir: tmpDir });
    expect(config.flows.ci!.steps['1']).toEqual({ task: 'build' });
  });

  it('fails at load with strict: true', () => {
    fs.writeFileSync(path.join(tmpDir, 'app.yml'), yaml);
    expect(() =>
      loadConfig({ filename: 'app.yml', schema: EngineConfigSchema, configDir: tmpDir, strict: true }),
    ).toThrow(/flows\.ci\.steps\.1\.retires[\s\S]*bridge/);
  });

  it('checks the merged layers, and passthroughKeys exempts host sections', () => {
    fs.writeFileSync(path.join(tmpDir, 'app.yml'), 'flows:\n  ci:\n    steps:\n      1: { task: build }\nbridge: {}\n');
    fs.writeFileSync(path.join(tmpDir, 'app.local.yml'), 'flows:\n  ci:\n    steps:\n      1: { whne: true }\n');
    expect(() =>
      loadConfig({
        filename: 'app.yml',
        schema: EngineConfigSchema,
        configDir: tmpDir,
        strict: { passthroughKeys: ['bridge'] },
      }),
    ).toThrow(/^Unknown config key:\n {2}flows\.ci\.steps\.1\.whne \(did you mean "when"\?\)$/);

    fs.writeFileSync(path.join(tmpDir, 'app.local.yml'), 'flows: {}\n');
    const { config } = loadConfig({
      filename: 'app.yml',
      schema: EngineConfigSchema,
      configDir: tmpDir,
      strict: { passthroughKeys: ['bridge'] },
    });
    expect(config.flows.ci).toBeDefined();
  });
});
