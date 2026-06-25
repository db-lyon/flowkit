import { describe, it, expect } from 'vitest';
import {
  TaskDefinitionSchema,
  FlowStepSchema,
  FlowDefinitionSchema,
  AgentDefinitionSchema,
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

  it('accepts an option-only entry (no class_path) — a valid override that layers onto a base', () => {
    const result = TaskDefinitionSchema.parse({ options: { suites: 'robot/Tests' } });
    expect(result.class_path).toBeUndefined();
    expect(result.options).toEqual({ suites: 'robot/Tests' });
  });

  it('rejects an empty-string class_path', () => {
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

  it('accepts a `when` condition as string or boolean', () => {
    expect(FlowStepSchema.parse({ task: 'deploy', when: 'org.scratch' }).when).toBe('org.scratch');
    expect(FlowStepSchema.parse({ task: 'deploy', when: false }).when).toBe(false);
  });

  it('accepts ignore_failure', () => {
    expect(FlowStepSchema.parse({ task: 'deploy', ignore_failure: true }).ignore_failure).toBe(true);
  });

  it('leaves when/ignore_failure undefined by default', () => {
    const result = FlowStepSchema.parse({ task: 'deploy' });
    expect(result.when).toBeUndefined();
    expect(result.ignore_failure).toBeUndefined();
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

  it('accepts an override flow with no description and no steps', () => {
    const result = FlowDefinitionSchema.parse({ steps: { 1: { task: 'a' } } });
    expect(result.description).toBeUndefined();
    const bare = FlowDefinitionSchema.parse({});
    expect(bare.steps).toEqual({});
  });

  it('tolerates a null description (override that clears it)', () => {
    const result = FlowDefinitionSchema.parse({ description: null, steps: { 1: { flow: 'x' } } });
    expect(result.description).toBeNull();
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

  it('defaults agents to an empty record', () => {
    const result = EngineConfigSchema.parse({ tasks: {}, flows: {} });
    expect(result.agents).toEqual({});
  });
});

describe('AgentDefinitionSchema', () => {
  it('parses a full agent with tool refs and budget', () => {
    const result = AgentDefinitionSchema.parse({
      model: 'opus',
      system: 'do the thing',
      tools: [
        { task: 'shell', name: 'run', parameters: { type: 'object' } },
        { flow: 'ci' },
        { agent: 'qa' },
      ],
      schema: { type: 'object' },
      budget: { maxIterations: 6, tokenBudget: 100000, maxConcurrency: 3 },
    });
    expect(result.tools).toHaveLength(3);
    expect(result.budget?.tokenBudget).toBe(100000);
  });

  it('defaults tools to an empty array', () => {
    expect(AgentDefinitionSchema.parse({}).tools).toEqual([]);
  });

  it('rejects a tool with no reference or name', () => {
    expect(() => AgentDefinitionSchema.parse({ tools: [{ description: 'x' }] })).toThrow();
  });
});
