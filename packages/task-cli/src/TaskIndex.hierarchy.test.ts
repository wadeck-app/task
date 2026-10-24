import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runTaskCommand } from './TaskIndex.js';
import { initLegacyProject } from './testHelpers.js';

interface Created {
	id: string;
	title?: string;
	parentId?: string;
}
interface TreeNode {
	id: string;
	children: TreeNode[];
}

let tmpDir: string;

async function newTask(title: string, ...extra: string[]): Promise<Created> {
	const result = await runTaskCommand(['new', title, ...extra], tmpDir);
	expect(result.exitCode, result.output).toBe(0);
	return JSON.parse(result.output) as Created;
}

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-hierarchy-test-'));
	initLegacyProject(tmpDir);
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runTaskCommand — new --parent', () => {
	it('creates a child of the given parent', async () => {
		const parent = await newTask('parent');
		const child = await newTask('child', '--parent', parent.id);
		expect(child.parentId).toBe(parent.id);
	});

	it('accepts --parent before the description', async () => {
		const parent = await newTask('parent');
		const result = await runTaskCommand(['new', '--parent', parent.id, 'child'], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		const child = JSON.parse(result.output) as Created;
		expect(child.parentId).toBe(parent.id);
		expect(child.title).toBe('child');
	});

	it('resolves the parent by id prefix and stores the full id', async () => {
		const parent = await newTask('parent');
		const child = await newTask('child', '--parent', parent.id.slice(0, 4));
		expect(child.parentId).toBe(parent.id);
	});

	it('fails with an actionable error when the parent does not exist, and creates nothing', async () => {
		const result = await runTaskCommand(['new', 'child', '--parent', 'zzzzzz'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('not found');
		const all = JSON.parse((await runTaskCommand(['list', '--all'], tmpDir)).output) as unknown[];
		expect(all).toHaveLength(0);
	});

	it('fails when --parent has no value', async () => {
		const result = await runTaskCommand(['new', 'child', '--parent'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('--parent');
		expect(result.output).toContain('Usage');
	});

	it('fails (does not silently ignore) on an unknown flag', async () => {
		const result = await runTaskCommand(['new', 'child', '--parnet', 'abc'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('--parnet');
	});
});

describe('runTaskCommand — list / show expose parentId', () => {
	it('list entries carry parentId for children only', async () => {
		const parent = await newTask('parent');
		const child = await newTask('child', '--parent', parent.id);
		const list = JSON.parse((await runTaskCommand(['list'], tmpDir)).output) as Created[];
		expect(list.find(t => t.id === child.id)!.parentId).toBe(parent.id);
		expect(list.find(t => t.id === parent.id)!.parentId).toBeUndefined();
	});

	it('show returns parentId', async () => {
		const parent = await newTask('parent');
		const child = await newTask('child', '--parent', parent.id);
		const shown = JSON.parse((await runTaskCommand(['show', child.id], tmpDir)).output) as Created;
		expect(shown.parentId).toBe(parent.id);
	});
});

describe('runTaskCommand — set-parent', () => {
	it('attaches an existing task to a parent (prefixes accepted)', async () => {
		const parent = await newTask('parent');
		const child = await newTask('child');
		const result = await runTaskCommand(['set-parent', child.id.slice(0, 4), parent.id.slice(0, 4)], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		expect((JSON.parse(result.output) as Created).parentId).toBe(parent.id);
	});

	it('fails with usage when arguments are missing', async () => {
		const result = await runTaskCommand(['set-parent', 'abc'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('Usage: task set-parent <id> <parent-id>');
	});

	it('rejects a cycle with an explanatory error and leaves data untouched', async () => {
		const a = await newTask('a');
		const b = await newTask('b', '--parent', a.id);
		const result = await runTaskCommand(['set-parent', a.id, b.id], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('cycle');
		const shownA = JSON.parse((await runTaskCommand(['show', a.id], tmpDir)).output) as Created;
		expect(shownA.parentId).toBeUndefined();
	});

	it('rejects self-parenting', async () => {
		const a = await newTask('a');
		const result = await runTaskCommand(['set-parent', a.id, a.id], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('own parent');
	});

	it('reports an unknown parent', async () => {
		const a = await newTask('a');
		const result = await runTaskCommand(['set-parent', a.id, 'zzzzzz'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('not found');
	});

	it('--json mode returns a JSON error', async () => {
		const a = await newTask('a');
		const result = await runTaskCommand(['--json', 'set-parent', a.id, 'zzzzzz'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect((JSON.parse(result.output) as { error: string }).error).toContain('not found');
	});
});

describe('runTaskCommand — remove-parent', () => {
	it('detaches a child', async () => {
		const parent = await newTask('parent');
		const child = await newTask('child', '--parent', parent.id);
		const result = await runTaskCommand(['remove-parent', child.id], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		expect((JSON.parse(result.output) as Created).parentId).toBeUndefined();
	});

	it('fails with a clear message when the task has no parent', async () => {
		const a = await newTask('a');
		const result = await runTaskCommand(['remove-parent', a.id], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('has no parent');
	});

	it('fails with usage when the id is missing', async () => {
		const result = await runTaskCommand(['remove-parent'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('Usage: task remove-parent <id>');
	});
});

describe('runTaskCommand — children', () => {
	it('lists direct children only', async () => {
		const root = await newTask('root');
		const c1 = await newTask('c1', '--parent', root.id);
		await newTask('grandchild', '--parent', c1.id);
		const result = await runTaskCommand(['children', root.id.slice(0, 4)], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		expect((JSON.parse(result.output) as Created[]).map(t => t.id)).toEqual([c1.id]);
	});

	it('returns [] for a leaf', async () => {
		const leaf = await newTask('leaf');
		const result = await runTaskCommand(['children', leaf.id], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual([]);
	});

	it('--recursive returns the nested subtree at any depth', async () => {
		const root = await newTask('root');
		const mid = await newTask('mid', '--parent', root.id);
		const leaf = await newTask('leaf', '--parent', mid.id);
		const result = await runTaskCommand(['children', root.id, '--recursive'], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		const nodes = JSON.parse(result.output) as TreeNode[];
		expect(nodes).toHaveLength(1);
		expect(nodes[0]!.id).toBe(mid.id);
		expect(nodes[0]!.children.map(c => c.id)).toEqual([leaf.id]);
	});

	it('fails with usage when the id is missing', async () => {
		const result = await runTaskCommand(['children'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('Usage: task children <id> [--recursive]');
	});

	it('fails when the task does not exist', async () => {
		const result = await runTaskCommand(['children', 'zzzzzz'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('not found');
	});
});

describe('runTaskCommand — delete a parent', () => {
	it('orphans the children (they are kept) and tells the user', async () => {
		const parent = await newTask('parent');
		const child = await newTask('child', '--parent', parent.id);
		const result = await runTaskCommand(['delete', parent.id], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		expect(result.output).toContain('Deleted 1 task(s)');
		expect(result.output).toContain('1 child task(s) became root');
		const shown = JSON.parse((await runTaskCommand(['show', child.id], tmpDir)).output) as Created;
		expect(shown.parentId).toBeUndefined();
	});

	it('does not mention orphans when the children are deleted too', async () => {
		const parent = await newTask('parent');
		await newTask('child', '--parent', parent.id);
		const result = await runTaskCommand(['delete', '--all'], tmpDir);
		expect(result.output).toContain('Deleted 2 task(s)');
		expect(result.output).not.toContain('became root');
	});

	it('--dry-run warns about children that would be orphaned and deletes nothing', async () => {
		const parent = await newTask('parent');
		const child = await newTask('child', '--parent', parent.id);
		const result = await runTaskCommand(['delete', '--dry-run', parent.id], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('1 child task(s) would become root');
		const shown = JSON.parse((await runTaskCommand(['show', child.id], tmpDir)).output) as Created;
		expect(shown.parentId).toBe(parent.id);
	});
});

describe('runTaskCommand — parents', () => {
	it('lists every ancestor from the direct parent up to the root', async () => {
		const root = await newTask('root');
		const mid = await newTask('mid', '--parent', root.id);
		const leaf = await newTask('leaf', '--parent', mid.id);
		const result = await runTaskCommand(['parents', leaf.id.slice(0, 4)], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		expect((JSON.parse(result.output) as Created[]).map(t => t.id)).toEqual([mid.id, root.id]);
	});

	it('returns [] for a root task', async () => {
		const root = await newTask('root');
		const result = await runTaskCommand(['parents', root.id], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual([]);
	});

	it('fails with usage when the id is missing', async () => {
		const result = await runTaskCommand(['parents'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('Usage: task parents <id>');
	});

	it('fails when the task does not exist', async () => {
		const result = await runTaskCommand(['parents', 'zzzzzz'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('not found');
	});
});

describe('runTaskCommand — tree', () => {
	it('returns the complete tree from the topmost ancestor and flags the requested task', async () => {
		const root = await newTask('root');
		const mid = await newTask('mid', '--parent', root.id);
		const sibling = await newTask('sibling', '--parent', root.id);
		const leaf = await newTask('leaf', '--parent', mid.id);
		const result = await runTaskCommand(['tree', mid.id], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		const tree = JSON.parse(result.output) as TreeNode & { selected?: boolean };
		expect(tree.id).toBe(root.id);
		expect(tree.selected).toBeUndefined();
		const midNode = tree.children.find(c => c.id === mid.id) as TreeNode & { selected?: boolean };
		expect(midNode.selected).toBe(true);
		expect(midNode.children.map(c => c.id)).toEqual([leaf.id]);
		expect(tree.children.map(c => c.id)).toContain(sibling.id);
	});

	it('works for a task without any relative', async () => {
		const alone = await newTask('alone');
		const tree = JSON.parse((await runTaskCommand(['tree', alone.id], tmpDir)).output) as TreeNode & {
			selected?: boolean;
		};
		expect(tree.id).toBe(alone.id);
		expect(tree.selected).toBe(true);
		expect(tree.children).toEqual([]);
	});

	it('fails with usage when the id is missing', async () => {
		const result = await runTaskCommand(['tree'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('Usage: task tree <id>');
	});

	it('fails when the task does not exist', async () => {
		const result = await runTaskCommand(['tree', 'zzzzzz'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('not found');
	});
});

describe('runTaskCommand — show with hierarchy', () => {
	interface Shown extends Created {
		childrenIds: string[];
		parent?: { id: string; title: string; status: string } | null;
		children?: Array<{ id: string; title: string; status: string }>;
	}
	const show = async (...args: string[]): Promise<Shown> => {
		const result = await runTaskCommand(['show', ...args], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		return JSON.parse(result.output) as Shown;
	};

	it('always includes parentId and childrenIds (direct children only)', async () => {
		const parent = await newTask('parent');
		const mid = await newTask('mid', '--parent', parent.id);
		const c1 = await newTask('c1', '--parent', mid.id);
		const c2 = await newTask('c2', '--parent', mid.id);
		await newTask('grandchild', '--parent', c1.id);
		const shown = await show(mid.id);
		expect(shown.parentId).toBe(parent.id);
		expect(shown.childrenIds.sort()).toEqual([c1.id, c2.id].sort());
		expect(shown.parent).toBeUndefined();
		expect(shown.children).toBeUndefined();
	});

	it('childrenIds is an empty array for a leaf', async () => {
		const leaf = await newTask('leaf');
		expect((await show(leaf.id)).childrenIds).toEqual([]);
	});

	it('--with-parent adds the parent summary', async () => {
		const parent = await newTask('the parent');
		const child = await newTask('child', '--parent', parent.id);
		const shown = await show(child.id, '--with-parent');
		expect(shown.parent).toMatchObject({ id: parent.id, title: 'the parent', status: 'backlog' });
		expect(shown.children).toBeUndefined();
	});

	it('--with-parent gives parent: null for a root task (explicit, not absent)', async () => {
		const root = await newTask('root');
		expect((await show(root.id, '--with-parent')).parent).toBeNull();
	});

	it('--with-children adds the children summaries', async () => {
		const parent = await newTask('parent');
		const child = await newTask('the child', '--parent', parent.id);
		const shown = await show(parent.id, '--with-children');
		expect(shown.children).toEqual([
			expect.objectContaining({ id: child.id, title: 'the child', status: 'backlog' }),
		]);
		expect(shown.parent).toBeUndefined();
	});

	it('both flags can be combined, in any order relative to the id', async () => {
		const parent = await newTask('parent');
		const mid = await newTask('mid', '--parent', parent.id);
		await newTask('leaf', '--parent', mid.id);
		const result = await runTaskCommand(['show', '--with-children', mid.id, '--with-parent'], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		const shown = JSON.parse(result.output) as Shown;
		expect(shown.id).toBe(mid.id);
		expect(shown.parent!.id).toBe(parent.id);
		expect(shown.children).toHaveLength(1);
	});

	it('fails on an unknown flag instead of ignoring it', async () => {
		const a = await newTask('a');
		const result = await runTaskCommand(['show', a.id, '--with-parnet'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('--with-parnet');
		expect(result.output).toContain('--with-parent');
	});
});

describe('runTaskCommand — delete --cascade-delete', () => {
	const listAll = async (): Promise<Created[]> =>
		JSON.parse((await runTaskCommand(['list', '--all'], tmpDir)).output) as Created[];

	it('deletes the whole subtree at any depth and nothing else', async () => {
		const root = await newTask('root');
		const mid = await newTask('mid', '--parent', root.id);
		await newTask('leaf', '--parent', mid.id);
		const other = await newTask('other');
		const result = await runTaskCommand(['delete', mid.id, '--cascade-delete'], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		expect(result.output).toContain('Deleted 2 task(s)');
		expect(result.output).not.toContain('became root');
		expect((await listAll()).map(t => t.id).sort()).toEqual([root.id, other.id].sort());
	});

	it('--dry-run lists the descendants that would be deleted and deletes nothing', async () => {
		const root = await newTask('root');
		const child = await newTask('child-title', '--parent', root.id);
		const result = await runTaskCommand(['delete', '--dry-run', '--cascade-delete', root.id], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain(child.id);
		expect(result.output).toContain('Total: 2 task(s)');
		expect(await listAll()).toHaveLength(2);
	});

	it('works with --filter and does not count a task twice when parent and child both match', async () => {
		const root = await newTask('root');
		await newTask('child', '--parent', root.id);
		const result = await runTaskCommand(['delete', '--filter', 'status=backlog', '--cascade-delete'], tmpDir);
		expect(result.output).toContain('Deleted 2 task(s)');
		expect(await listAll()).toHaveLength(0);
	});

	it('without the flag children are kept (default stays orphan)', async () => {
		const root = await newTask('root');
		await newTask('child', '--parent', root.id);
		await runTaskCommand(['delete', root.id], tmpDir);
		expect(await listAll()).toHaveLength(1);
	});
});

describe('runTaskCommand — delete --filter parentId', () => {
	it('deletes the tasks whose parentId matches; root tasks never match', async () => {
		const parent = await newTask('parent');
		const c1 = await newTask('c1', '--parent', parent.id);
		const c2 = await newTask('c2', '--parent', parent.id);
		const other = await newTask('other');
		const result = await runTaskCommand(['delete', '--filter', `parentId=${parent.id}`], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		expect(result.output).toContain('Deleted 2 task(s)');
		const left = JSON.parse((await runTaskCommand(['list', '--all'], tmpDir)).output) as Created[];
		expect(left.map(t => t.id).sort()).toEqual([parent.id, other.id].sort());
		expect(left.map(t => t.id)).not.toContain(c1.id);
		expect(left.map(t => t.id)).not.toContain(c2.id);
	});

	it('supports glob patterns', async () => {
		const parent = await newTask('parent');
		await newTask('c1', '--parent', parent.id);
		const result = await runTaskCommand(
			['delete', '--dry-run', '--filter', `parentId=${parent.id.slice(0, 3)}*`],
			tmpDir
		);
		expect(result.output).toContain('Total: 1 task(s)');
	});

	it('lists parentId among the valid fields when the field is unknown', async () => {
		const result = await runTaskCommand(['delete', '--filter', 'foo=bar'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('parentId');
	});
});

describe('runTaskCommand — list --parent', () => {
	const listJson = async (...args: string[]): Promise<Created[]> => {
		const result = await runTaskCommand(['list', ...args], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		return JSON.parse(result.output) as Created[];
	};

	it('lists only the direct children of the given task (prefix accepted)', async () => {
		const root = await newTask('root');
		const c1 = await newTask('c1', '--parent', root.id);
		await newTask('grandchild', '--parent', c1.id);
		await newTask('other root');
		expect((await listJson('--parent', root.id.slice(0, 4))).map(t => t.id)).toEqual([c1.id]);
	});

	it('still hides terminal statuses unless --all is passed', async () => {
		const root = await newTask('root');
		const active = await newTask('active', '--parent', root.id);
		const done = await newTask('done', '--parent', root.id);
		await runTaskCommand(['set-status', done.id, 'done'], tmpDir);
		expect((await listJson('--parent', root.id)).map(t => t.id)).toEqual([active.id]);
		expect((await listJson('--parent', root.id, '--all')).map(t => t.id).sort()).toEqual(
			[active.id, done.id].sort()
		);
	});

	it('fails with usage when --parent has no value', async () => {
		const result = await runTaskCommand(['list', '--parent'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('--parent requires a task id');
		expect(result.output).toContain('Usage: task list');
	});

	it('fails when the parent does not exist', async () => {
		const result = await runTaskCommand(['list', '--parent', 'zzzzzz'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('not found');
	});

	it('refuses --follow combined with --parent instead of silently ignoring the filter', async () => {
		const root = await newTask('root');
		const result = await runTaskCommand(['list', '--parent', root.id, '--follow'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('--follow');
		expect(result.output).toContain('--parent');
	});
});

describe('runTaskCommand — list --tree', () => {
	type Node = TreeNode & { status: string };
	const listTree = async (...args: string[]): Promise<Node[]> => {
		const result = await runTaskCommand(['list', '--tree', ...args], tmpDir);
		expect(result.exitCode, result.output).toBe(0);
		return JSON.parse(result.output) as Node[];
	};

	it('returns the forest of root tasks with nested children at any depth', async () => {
		const r1 = await newTask('r1');
		const c1 = await newTask('c1', '--parent', r1.id);
		const g1 = await newTask('g1', '--parent', c1.id);
		const r2 = await newTask('r2');
		const forest = await listTree();
		expect(forest.map(n => n.id).sort()).toEqual([r1.id, r2.id].sort());
		const r1Node = forest.find(n => n.id === r1.id)!;
		expect(r1Node.children[0]!.id).toBe(c1.id);
		expect(r1Node.children[0]!.children[0]!.id).toBe(g1.id);
		expect(forest.find(n => n.id === r2.id)!.children).toEqual([]);
	});

	it('hides terminal tasks, but keeps a terminal ancestor that leads to an active task', async () => {
		const doneRoot = await newTask('done root');
		const active = await newTask('active', '--parent', doneRoot.id);
		const fullyDone = await newTask('fully done');
		const doneChild = await newTask('done child', '--parent', fullyDone.id);
		for (const id of [doneRoot.id, fullyDone.id, doneChild.id]) {
			await runTaskCommand(['set-status', id, 'done'], tmpDir);
		}
		const forest = await listTree();
		expect(forest.map(n => n.id)).toEqual([doneRoot.id]);
		expect(forest[0]!.status).toBe('done');
		expect(forest[0]!.children.map(n => n.id)).toEqual([active.id]);
	});

	it('--all shows terminal tasks too', async () => {
		const root = await newTask('root');
		const child = await newTask('child', '--parent', root.id);
		await runTaskCommand(['set-status', child.id, 'done'], tmpDir);
		await runTaskCommand(['set-status', root.id, 'done'], tmpDir);
		expect(await listTree()).toEqual([]);
		const forest = await listTree('--all');
		expect(forest.map(n => n.id)).toEqual([root.id]);
		expect(forest[0]!.children.map(n => n.id)).toEqual([child.id]);
	});

	it('--parent <id> roots the tree at the children of that task', async () => {
		const root = await newTask('root');
		const c1 = await newTask('c1', '--parent', root.id);
		const g1 = await newTask('g1', '--parent', c1.id);
		await newTask('other root');
		const forest = await listTree('--parent', root.id);
		expect(forest.map(n => n.id)).toEqual([c1.id]);
		expect(forest[0]!.children.map(n => n.id)).toEqual([g1.id]);
	});

	it('returns [] when there are no tasks', async () => {
		expect(await listTree()).toEqual([]);
	});

	it('refuses --follow combined with --tree', async () => {
		const result = await runTaskCommand(['list', '--tree', '--follow'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('--follow');
		expect(result.output).toContain('--tree');
	});
});

describe('runTaskCommand — help', () => {
	it('documents the hierarchy commands', async () => {
		const result = await runTaskCommand(['--help'], tmpDir);
		for (const snippet of [
			'--parent',
			'set-parent',
			'remove-parent',
			'children',
			'parents',
			'tree',
			'--with-parent',
			'--with-children',
			'--cascade-delete',
			'list --parent',
			'list --tree',
		]) {
			expect(result.output, snippet).toContain(snippet);
		}
	});
});
