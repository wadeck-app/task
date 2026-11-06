import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTaskCommand } from './TaskIndex.js';
import { registerTestProject } from './testHelpers.js';

interface Created {
	id: string;
	links?: Array<{ type: string; target: string }>;
}
interface DanglingEntry {
	relation: string;
	targetId: string;
	fix: string;
}
interface LinksView {
	blockedBy: Array<{ id: string }>;
	causedBy: Array<{ id: string }>;
	dangling?: DanglingEntry[];
}

let tmpDir: string;
let stderr: string[];
let dataDir: string;
// a blockedBy b (b vanished from the index), a causedBy c (c still there).
let a: string;
let b: string;
let c: string;

async function newTask(title: string): Promise<Created> {
	const result = await runTaskCommand(['new', title], tmpDir);
	expect(result.exitCode, result.output).toBe(0);
	return JSON.parse(result.output) as Created;
}

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-links-cli-test-'));
	const project = await registerTestProject(tmpDir);
	dataDir = project.storage.dataDir;
	stderr = [];
	vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
		stderr.push(String(chunk));
		return true;
	});
	a = (await newTask('a')).id;
	b = (await newTask('b')).id;
	c = (await newTask('c')).id;
	expect((await runTaskCommand(['link', a, 'blockedBy', b], tmpDir)).exitCode).toBe(0);
	expect((await runTaskCommand(['link', a, 'causedBy', c], tmpDir)).exitCode).toBe(0);
	// b leaves the index only (data edited outside task): a keeps its link to it.
	const indexPath = path.join(dataDir, 'task-index.json');
	const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { tasks: Array<{ id: string }> };
	index.tasks = index.tasks.filter(x => x.id !== b);
	fs.writeFileSync(indexPath, JSON.stringify(index));
	stderr.length = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const fix = (): string => `task unlink ${a} blockedBy ${b}`;

describe('a link to a vanished task stays reachable from the CLI', () => {
	it('links answers 0, keeps the resolvable links, lists the dangling one and warns on stderr with the fix', async () => {
		const result = await runTaskCommand(['links', a], tmpDir);

		expect(result.exitCode, result.output).toBe(0);
		const view = JSON.parse(result.output) as LinksView;
		expect(view.causedBy.map(x => x.id)).toEqual([c]);
		expect(view.blockedBy).toEqual([]);
		expect(view.dangling).toEqual([{ relation: 'blockedBy', targetId: b, fix: fix() }]);
		expect(stderr.join('')).toBe(
			`Warning: task "${a}" has a blockedBy link to "${b}", which does not exist. Fix with: ${fix()}\n`
		);
	});

	it('links of a consistent task has no dangling key and no warning', async () => {
		const result = await runTaskCommand(['links', c], tmpDir);

		expect(result.exitCode, result.output).toBe(0);
		expect('dangling' in (JSON.parse(result.output) as object)).toBe(false);
		expect(stderr).toEqual([]);
	});

	it('show answers 0 with the record, marks the dangling link and warns on stderr', async () => {
		const result = await runTaskCommand(['show', a], tmpDir);

		expect(result.exitCode, result.output).toBe(0);
		const shown = JSON.parse(result.output) as Created & { dangling?: DanglingEntry[] };
		expect(shown.links).toEqual([
			{ type: 'blockedBy', target: b },
			{ type: 'causedBy', target: c },
		]);
		expect(shown.dangling).toEqual([{ relation: 'blockedBy', targetId: b, fix: fix() }]);
		expect(stderr.join('')).toContain(`Fix with: ${fix()}`);
	});

	it('show of a consistent task has no dangling key and no warning', async () => {
		const result = await runTaskCommand(['show', c], tmpDir);

		expect(result.exitCode, result.output).toBe(0);
		expect('dangling' in (JSON.parse(result.output) as object)).toBe(false);
		expect(stderr).toEqual([]);
	});

	it('unlink by the exact id removes the dangling link and keeps the other', async () => {
		const result = await runTaskCommand(['unlink', a, 'blockedBy', b], tmpDir);

		expect(result.exitCode, result.output).toBe(0);
		expect((JSON.parse(result.output) as Created).links).toEqual([{ type: 'causedBy', target: c }]);
		const links = await runTaskCommand(['links', a], tmpDir);
		expect('dangling' in (JSON.parse(links.output) as object)).toBe(false);
	});

	it('list, tree, children and set-status of the task do not crash', async () => {
		const list = await runTaskCommand(['list'], tmpDir);
		expect(list.exitCode, list.output).toBe(0);
		expect(list.output).toContain(a);
		const tree = await runTaskCommand(['list', '--tree'], tmpDir);
		expect(tree.exitCode, tree.output).toBe(0);
		const subtree = await runTaskCommand(['tree', a], tmpDir);
		expect(subtree.exitCode, subtree.output).toBe(0);
		const status = await runTaskCommand(['set-status', a, 'in-progress'], tmpDir);
		expect(status.exitCode, status.output).toBe(0);
	});
});
