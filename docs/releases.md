# Release notes

## 0.14.0

Flowkit now exposes a generic execution-lifecycle contract on every task:

```typescript
interface TaskContext {
  readonly executionPhase:
    | 'task'
    | 'on_start'
    | 'on_success'
    | 'on_failure'
    | 'finally'
    | 'rollback';
}
```

The runner derives a fresh context for each invocation. Ordinary work,
including nested flows, direct task calls, task-to-task calls, agents, and
tools, receives `task`; hooks and rollback invocations receive their matching
phase. A nested flow or sub-agent cannot carry its caller's phase into its own
ordinary work.

This is additive for hosts: existing consumers do not need to change their
runner context. Consumers that distinguish normal work from compensation or
cleanup can read `ctx.executionPhase` inside a task.

`TaskRegistry.create()` continues to accept host-style context without an
`executionPhase`; Flowkit derives `task` before construction. Code that calls
`registry.resolve()` and directly instantiates the returned constructor should
pass a complete `TaskContext`, for example `{ executionPhase: 'task', ...ctx }`,
or use `registry.create()` when it wants Flowkit to supply the phase.
