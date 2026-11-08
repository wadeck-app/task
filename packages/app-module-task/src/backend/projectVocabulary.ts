// What the project already uses, for pickers that suggest it: metadata keys and the size of a subtree.
import type { TaskTreeNode } from '@wadeck-app/task-core';
import { listChildren } from '@wadeck-app/task-service';
import type { TaskServiceContext } from '@wadeck-app/task-service';

/**
 * Every metadata key of the project, sorted. Metadata lives in the task files, not in the index, so this reads every task
 * file (O(tasks), like task-service `listLabels`).
 */
export async function listMetaKeys(ctx: TaskServiceContext): Promise<string[]> {
	const keys = new Set<string>();
	for (const summary of await ctx.store.list()) {
		for (const key of Object.keys((await ctx.store.get(summary.id)).meta ?? {})) {
			keys.add(key);
		}
	}
	return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function countNodes(nodes: readonly TaskTreeNode[]): number {
	return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

/** The number of tasks below a task, at any depth. */
export async function countDescendants(ctx: TaskServiceContext, id: string): Promise<number> {
	return countNodes((await listChildren(ctx, { id, recursive: true })) as TaskTreeNode[]);
}
