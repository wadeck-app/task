// Creation order and parents of a migration: tasks are created parents first, so a parent's target id exists when its children are
// created. The source is not trusted to be a clean forest: a parent that is not in the source, a cycle, a target without hierarchy or a
// target limit (GitHub: 8 levels, 100 children) each drop the parent link of the tasks concerned, and every drop is a row of the loss table.
import type { HierarchySupport } from '@wadeck-app/task-core';

import type { LossLedger } from './lossLedger.js';

export interface HierarchyLimits {
	hierarchy: HierarchySupport;
	/** Deepest nesting (a root is level 1). Absent: unlimited. */
	depth?: number;
	/** Most direct children of one task. Absent: unlimited. */
	children?: number;
}

export interface HierarchyPlan {
	/** Source ids, parents before children: the roots in the order of the source, each followed (breadth first) by its descendants. */
	order: string[];
	/** The parent a task keeps on the target (source id); absent: it is created as a root. */
	parentOf: Map<string, string>;
}

/** Walks up from `start` through `parents`: the first task met twice (a task of a cycle), or undefined when the chain ends. */
function cycleMember(start: string, parents: ReadonlyMap<string, string>): string | undefined {
	const seen = new Set<string>();
	let current: string | undefined = start;
	while (current !== undefined) {
		if (seen.has(current)) return current;
		seen.add(current);
		current = parents.get(current);
	}
	return undefined;
}

export function planHierarchy(
	tasks: ReadonlyArray<{ id: string; parentId?: string }>,
	limits: HierarchyLimits,
	ledger: LossLedger
): HierarchyPlan {
	const ids = new Set(tasks.map(task => task.id));
	const parents = new Map<string, string>();
	for (const task of tasks) {
		if (task.parentId === undefined) continue;
		if (limits.hierarchy === 'none') {
			ledger.add('hierarchy:unsupported', task.id);
		} else if (!ids.has(task.parentId)) {
			ledger.add('hierarchy:orphan', task.id, `parent ${task.parentId}`);
		} else {
			parents.set(task.id, task.parentId);
		}
	}

	const childrenOf = new Map<string, string[]>();
	for (const task of tasks) {
		const parent = parents.get(task.id);
		if (parent === undefined) continue;
		const siblings = childrenOf.get(parent);
		if (siblings === undefined) childrenOf.set(parent, [task.id]);
		else siblings.push(task.id);
	}

	// Breadth first from the roots; what is left unplaced is on a cycle or below one.
	const order: string[] = [];
	const placed = new Set<string>();
	const drain = (queue: string[]): void => {
		for (let index = 0; index < queue.length; index++) {
			const id = queue[index]!;
			order.push(id);
			placed.add(id);
			queue.push(...(childrenOf.get(id) ?? []));
		}
	};
	drain(tasks.filter(task => !parents.has(task.id)).map(task => task.id));
	while (placed.size < tasks.length) {
		const stuck = tasks.find(task => !placed.has(task.id));
		const member = stuck === undefined ? undefined : cycleMember(stuck.id, parents);
		const dropped = member === undefined ? undefined : parents.get(member);
		if (member === undefined || dropped === undefined) {
			// Unreachable for a finite forest; failing loudly beats an infinite loop.
			throw new Error('internal error: the hierarchy of the source could not be ordered');
		}
		parents.delete(member);
		childrenOf.set(
			dropped,
			(childrenOf.get(dropped) ?? []).filter(id => id !== member)
		);
		ledger.add('hierarchy:cycle', member, `${member} under ${dropped}`);
		drain([member]);
	}

	// Target limits, top down: a task whose parent was dropped starts a new tree at level 1.
	const depth = new Map<string, number>();
	const childCount = new Map<string, number>();
	for (const id of order) {
		const parent = parents.get(id);
		if (parent === undefined) {
			depth.set(id, 1);
			continue;
		}
		const parentDepth = depth.get(parent) ?? 1;
		if (limits.depth !== undefined && parentDepth + 1 > limits.depth) {
			parents.delete(id);
			depth.set(id, 1);
			ledger.add('hierarchy:depth', id, `level ${parentDepth + 1} of at most ${limits.depth}`);
			continue;
		}
		if (limits.children !== undefined && (childCount.get(parent) ?? 0) >= limits.children) {
			parents.delete(id);
			depth.set(id, 1);
			ledger.add('hierarchy:children', id, `parent ${parent} has ${limits.children} children already`);
			continue;
		}
		childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
		depth.set(id, parentDepth + 1);
	}
	return { order, parentOf: parents };
}
