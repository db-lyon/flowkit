import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { loadConfig } from '../../src/config/loader.js';

const TestSchema = z.object({
  project: z.object({
    name: z.string(),
    timeout: z.number().default(600),
  }),
  tasks: z
    .record(
      z.object({
        class_path: z.string(),
        options: z.record(z.unknown()).default({}),
      }),
    )
    .default({}),
});

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowkit-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid config file', () => {
    fs.writeFileSync(path.join(tmpDir, 'app.yml'), 'project:\n  name: test\n');
    const { config } = loadConfig({
      filename: 'app.yml',
      schema: TestSchema,
      configDir: tmpDir,
    });
    expect(config.project.name).toBe('test');
    expect(config.project.timeout).toBe(600);
  });

  it('merges builtin defaults under the project file', () => {
    fs.writeFileSync(path.join(tmpDir, 'app.yml'), 'project:\n  name: test\n');
    const { config } = loadConfig({
      filename: 'app.yml',
      schema: TestSchema,
      defaults: { project: { timeout: 300 } },
      configDir: tmpDir,
    });
    // project file doesn't set timeout → defaults survive the merge
    expect(config.project.timeout).toBe(300);
  });

  it('project file overrides defaults', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'app.yml'),
      'project:\n  name: test\n  timeout: 120\n',
    );
    const { config } = loadConfig({
      filename: 'app.yml',
      schema: TestSchema,
      defaults: { project: { timeout: 300 } },
      configDir: tmpDir,
    });
    expect(config.project.timeout).toBe(120);
  });

  it('merges environment overlay', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'app.yml'),
      'project:\n  name: test\n  timeout: 600\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'app.ci.yml'),
      'project:\n  timeout: 60\n',
    );
    const { config } = loadConfig({
      filename: 'app.yml',
      schema: TestSchema,
      env: 'ci',
      configDir: tmpDir,
    });
    expect(config.project.name).toBe('test');
    expect(config.project.timeout).toBe(60);
  });

  it('merges local overlay on top', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'app.yml'),
      'project:\n  name: test\n  timeout: 600\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'app.local.yml'),
      'project:\n  timeout: 5\n',
    );
    const { config } = loadConfig({
      filename: 'app.yml',
      schema: TestSchema,
      configDir: tmpDir,
    });
    expect(config.project.timeout).toBe(5);
  });

  it('applies full chain: defaults → base → env → local', () => {
    fs.writeFileSync(path.join(tmpDir, 'app.yml'), 'project:\n  name: prod\n');
    fs.writeFileSync(path.join(tmpDir, 'app.ci.yml'), 'project:\n  timeout: 120\n');
    fs.writeFileSync(path.join(tmpDir, 'app.local.yml'), 'project:\n  timeout: 1\n');

    const { config } = loadConfig({
      filename: 'app.yml',
      schema: TestSchema,
      defaults: { project: { timeout: 999 } },
      env: 'ci',
      configDir: tmpDir,
    });
    // local wins over ci overlay
    expect(config.project.timeout).toBe(1);
    expect(config.project.name).toBe('prod');
  });

  it('throws on missing config file', () => {
    expect(() =>
      loadConfig({ filename: 'app.yml', schema: TestSchema, configDir: tmpDir }),
    ).toThrow('Configuration file not found');
  });

  it('throws on invalid schema', () => {
    fs.writeFileSync(path.join(tmpDir, 'app.yml'), 'project:\n  name: 123\n');
    expect(() =>
      loadConfig({ filename: 'app.yml', schema: TestSchema, configDir: tmpDir }),
    ).toThrow();
  });

  it('returns configDir', () => {
    fs.writeFileSync(path.join(tmpDir, 'app.yml'), 'project:\n  name: test\n');
    const result = loadConfig({
      filename: 'app.yml',
      schema: TestSchema,
      configDir: tmpDir,
    });
    expect(result.configDir).toBe(tmpDir);
  });
});
