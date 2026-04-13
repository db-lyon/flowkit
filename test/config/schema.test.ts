import { describe, it, expect } from 'vitest';
import {
  TaskDefinitionSchema,
  FlowStepSchema,
  FlowDefinitionSchema,
  EngineConfigSchema,
} from '../../src/config/schema.js';

describe('TaskDefinitionSchema', () => {
  it('parses with class_path', () => {
    const result = TaskDefinitionSchema.parse({ class_path: 'my.task.Foo' });
    expect(result.class_path).toBe('my.task.Foo');
    expect(result.options).toEqual({});
  });

  it('parses with options', () => {
    const result = TaskDefinitionSchema.parse({
      class_path: 'my.task.Foo',
      options: { dry_run: true },
    });
    expect(result.options).toEqual({ dry_run: true });
  });

  it('rejects missing class_path', () => {
    expect(() => TaskDefinitionSchema.parse({})).toThrow();
  });

  it('rejects empty class_path', () => {
    expect(() => TaskDefinitionSchema.parse({ class_path: '' })).toThrow();
  });
});

describe('FlowStepSchema', () => {
  it('accepts a task step', () => {
    const result = FlowStepSchema.parse({ task: 'deploy' });
    expect(result.task).toBe('deploy');
    expect(result.flow).toBeUndefined();
  });

  it('accepts a flow step', () => {
    const result = FlowStepSchema.parse({ flow: 'provision' });
    expect(result.flow).toBe('provision');
    expect(result.task).toBeUndefined();
  });

  it('accepts task: None (skip sentinel)', () => {
    expect(FlowStepSchema.parse({ task: 'None' }).task).toBe('None');
  });

  it('accepts step with options', () => {
    const result = FlowStepSchema.parse({ task: 'deploy', options: { path: 'metadata' } });
    expect(result.options).toEqual({ path: 'metadata' });
  });

  it('rejects step with both task and flow', () => {
    expect(() => FlowStepSchema.parse({ task: 'deploy', flow: 'provision' })).toThrow();
  });

  it('rejects step with neither task nor flow', () => {
    expect(() => FlowStepSchema.parse({})).toThrow();
  });
});

describe('FlowDefinitionSchema', () => {
  it('parses a valid flow', () => {
    const result = FlowDefinitionSchema.parse({
      description: 'Test flow',
      steps: { 1: { task: 'deploy' }, 2: { task: 'verify' } },
    });
    expect(result.description).toBe('Test flow');
    expect(Object.keys(result.steps)).toEqual(['1', '2']);
  });

  it('coerces numeric keys to strings', () => {
    const result = FlowDefinitionSchema.parse({
      description: 'Coerce test',
      steps: { 1: { task: 'a' } },
    });
    expect(result.steps['1']).toBeDefined();
  });
});

describe('EngineConfigSchema', () => {
  it('parses empty config with defaults', () => {
    const result = EngineConfigSchema.parse({});
    expect(result.tasks).toEqual({});
    expect(result.flows).toEqual({});
  });

  it('parses config with tasks and flows', () => {
    const result = EngineConfigSchema.parse({
      tasks: { deploy: { class_path: 'my.Deploy' } },
      flows: {
        ci: { description: 'CI', steps: { 1: { task: 'deploy' } } },
      },
    });
    expect(result.tasks.deploy.class_path).toBe('my.Deploy');
    expect(result.flows.ci.steps['1'].task).toBe('deploy');
  });
});
