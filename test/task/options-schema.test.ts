import { describe, it, expect } from 'vitest';
import { FlowRunner } from '../../src/flow/runner.js';
import { BaseTask, type TaskResult } from '../../src/task/base-task.js';
import { TaskRegistry, type TaskConstructor } from '../../src/task/registry.js';
import {
  TaskOptionsError,
  validateTaskOptions,
  mergeOptionSpecs,
  assertTaskOptions,
} from '../../src/task/options-schema.js';
import { EngineConfigSchema, TaskDefinitionSchema, type OptionSpecs } from '../../src/config/schema.js';
import { findUnknownKeys } from '../../src/config/strict.js';

class DeployTask extends BaseTask<{ environment: string; replicas?: number }> {
  static description = 'Ship it';
  static optionsSchema: OptionSpecs = {
    environment: { type: 'string', enum: ['staging', 'prod'], required: true, description: 'Target' },
    replicas: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
  };
  static outputs = { url: { type: 'string' as const, description: 'Where it landed' } };
  static runs = 0;
  get taskName() {
    return 'deploy';
  }
  async execute(): Promise<TaskResult> {
    DeployTask.runs++;
    return { success: true, data: { ...this.options } };
  }
}

class PlainTask extends BaseTask {
  get taskName() {
    return 'plain';
  }
  async execute(): Promise<TaskResult> {
    return { success: true, data: { ...this.options } };
  }
}

function registry(): TaskRegistry {
  return new TaskRegistry()
    .registerClassPath('t.Deploy', DeployTask as unknown as TaskConstructor)
    .registerClassPath('t.Plain', PlainTask as unknown as TaskConstructor);
}

describe('option schema validation', () => {
  it('validates step options against the class schema and names the task and option', async () => {
    DeployTask.runs = 0;
    const runner = new FlowRunner({
      tasks: { deploy: { class_path: 't.Deploy', options: {} } },
      flows: { f: { description: 'f', steps: { 1: { task: 'deploy', retries: 3, options: { environment: 'dev' } } } } },
      registry: registry(),
      context: {},
    });
    const res = await runner.run({ flowName: 'f' });
    expect(res.success).toBe(false);
    const err = res.steps[0]!.result!.error!;
    expect(err).toBeInstanceOf(TaskOptionsError);
    expect(err.message).toBe('Task "deploy": option "environment" must be one of ["staging","prod"]');
    // Bad options are not retried and the task never ran.
    expect(res.steps[0]!.attempts).toBe(1);
    expect(DeployTask.runs).toBe(0);
  });

  it('reports a missing required option and applies schema defaults', async () => {
    const runner = new FlowRunner({
      tasks: { deploy: { class_path: 't.Deploy', options: {} } },
      flows: {},
      registry: registry(),
      context: {},
    });
    const missing = await runner.runTask('deploy', {});
    expect(missing.error?.message).toBe('Task "deploy": option "environment" is required');

    const ok = await runner.runTask('deploy', { environment: 'prod' });
    expect(ok.success).toBe(true);
    expect(ok.data).toEqual({ environment: 'prod', replicas: 2 });

    const range = await runner.runTask('deploy', { environment: 'prod', replicas: 9 });
    expect(range.error?.message).toBe('Task "deploy": option "replicas" must be <= 5');
  });

  it('lets a definition refine the class schema per option', async () => {
    const runner = new FlowRunner({
      tasks: {
        deploy_dev: {
          class_path: 't.Deploy',
          options: {},
          options_schema: {
            environment: { enum: ['dev'], default: 'dev' },
            region: { type: 'string', required: true },
          },
        },
      },
      flows: {},
      registry: registry(),
      context: {},
    });
    expect((await runner.runTask('deploy_dev', { region: 'eu' })).data).toEqual({
      environment: 'dev',
      replicas: 2,
      region: 'eu',
    });
    expect((await runner.runTask('deploy_dev', {})).error?.message).toBe(
      'Task "deploy_dev": option "region" is required',
    );
  });

  it('checks a definition-only schema on a class that declares none', async () => {
    const runner = new FlowRunner({
      tasks: { plain: { class_path: 't.Plain', options: {}, options_schema: { n: { type: 'number' } } } },
      flows: {},
      registry: registry(),
      context: {},
    });
    expect((await runner.runTask('plain', { n: 'x' })).error?.message).toBe(
      'Task "plain": option "n" expected type number but got string',
    );
    expect((await runner.runTask('plain', { n: 1, extra: true })).success).toBe(true);
  });

  it('leaves tasks with no schema untouched', async () => {
    const runner = new FlowRunner({
      tasks: { plain: { class_path: 't.Plain', options: { a: 1 } } },
      flows: {},
      registry: registry(),
      context: {},
    });
    expect((await runner.runTask('plain', { b: 2 })).data).toEqual({ a: 1, b: 2 });
  });

  it('helpers merge specs field by field and report nested paths', () => {
    expect(mergeOptionSpecs({ a: { type: 'string', required: true } }, { a: { default: 'x' } })).toEqual({
      a: { type: 'string', required: true, default: 'x' },
    });
    expect(
      validateTaskOptions({ list: { type: 'array', items: { type: 'string' } } }, { list: ['a', 2] }),
    ).toEqual([{ option: 'list.1', message: 'expected type string but got number' }]);
    expect(() => assertTaskOptions('t', { a: { required: true } }, {})).toThrow(TaskOptionsError);
  });
});

describe('TaskRegistry.describe', () => {
  it('folds class metadata and the definition together', async () => {
    const reg = registry();
    const tasks = {
      deploy: TaskDefinitionSchema.parse({
        class_path: 't.Deploy',
        group: 'ops',
        options: { environment: 'staging' },
        options_schema: { replicas: { default: 3 } },
        outputs: { id: { type: 'string' } },
        idempotent: true,
      }),
    };
    const d = await reg.describe('deploy', tasks);
    expect(d).toEqual({
      name: 'deploy',
      class_path: 't.Deploy',
      description: 'Ship it',
      group: 'ops',
      options: { environment: 'staging', replicas: 3 },
      options_schema: {
        environment: { type: 'string', enum: ['staging', 'prod'], required: true, description: 'Target' },
        replicas: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
      },
      outputs: { url: { type: 'string', description: 'Where it landed' }, id: { type: 'string' } },
      idempotent: true,
    });
  });

  it('describes a bare registered class, and FlowRunner.describeTask uses its definitions', async () => {
    const reg = registry();
    expect(await reg.describe('t.Plain')).toEqual({ name: 't.Plain', class_path: 't.Plain', options: {} });
    const runner = new FlowRunner({
      tasks: { p: { class_path: 't.Plain', options: { a: 1 }, description: 'P' } },
      flows: {},
      registry: reg,
      context: {},
    });
    expect(await runner.describeTask('p')).toEqual({
      name: 'p',
      class_path: 't.Plain',
      description: 'P',
      options: { a: 1 },
    });
  });
});

describe('options_schema in config', () => {
  it('parses and is covered by strict validation', () => {
    const config = {
      tasks: {
        t: { class_path: 'x', options_schema: { a: { type: 'string', requird: true } }, outputs: { o: {} } },
      },
    };
    expect(() => EngineConfigSchema.parse(config)).not.toThrow();
    expect(findUnknownKeys(EngineConfigSchema, config)).toEqual([
      { path: 'tasks.t.options_schema.a.requird', key: 'requird', suggestion: 'required' },
    ]);
  });
});
