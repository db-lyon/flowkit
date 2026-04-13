export interface DagNode<T = unknown> {
  id: string;
  dependencies: string[];
  data: T;
}

export class CircularDependencyError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Circular dependency detected: ${cycle.join(' -> ')}`);
    this.name = 'CircularDependencyError';
  }
}

export class MissingDependencyError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly missingDep: string,
  ) {
    super(`Node "${nodeId}" depends on "${missingDep}" which does not exist`);
    this.name = 'MissingDependencyError';
  }
}

/** Topological sort — returns nodes in dependency order (dependencies first). */
export function topologicalSort<T>(nodes: DagNode<T>[]): DagNode<T>[] {
  const nodeMap = new Map<string, DagNode<T>>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  for (const node of nodes) {
    for (const dep of node.dependencies) {
      if (!nodeMap.has(dep)) {
        throw new MissingDependencyError(node.id, dep);
      }
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: DagNode<T>[] = [];

  function visit(nodeId: string, path: string[]): void {
    if (visited.has(nodeId)) return;

    if (visiting.has(nodeId)) {
      const cycleStart = path.indexOf(nodeId);
      throw new CircularDependencyError([...path.slice(cycleStart), nodeId]);
    }

    visiting.add(nodeId);
    path.push(nodeId);

    const node = nodeMap.get(nodeId)!;
    for (const dep of node.dependencies) {
      visit(dep, [...path]);
    }

    visiting.delete(nodeId);
    visited.add(nodeId);
    sorted.push(node);
  }

  for (const node of nodes) {
    visit(node.id, []);
  }

  return sorted;
}
