// Byte-identity guard (design 0.1): the same scripted scenario runs through the synchronous TaskStore and through the
// LocalFileBackend in two temp dirs; the task files and `task-index.json` must be byte-identical and every answer (or
// error) of every step equal. Ids and timestamps are made deterministic (counters behind `node:crypto`, a stepped clock),
// so the comparison is on bytes, not on a normalised shape.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LocalFileBackend } from './LocalFileBackend';
import { TaskStore } from '../TaskStore';
import type { TaskRecord, TaskSummary } from '../TaskStore';

const ids = vi.hoisted(() => ({ uuid: 0, bytes: 0 }));

vi.mock('node:crypto', async importOriginal => {
	const actual = await importOriginal<typeof import('node:crypto')>();
	const randomUUID = (): string => {
		ids.uuid += 1;
		return `${ids.uuid.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
	};
	const randomBytes = (size: number): Buffer => {
		ids.bytes += 1;
		return Buffer.from(Array.from({ length: size }, (_, i) => (ids.bytes * 7 + i) % 256));
	};
	return { ...actual, default: { ...actual, randomUUID, randomBytes }, randomUUID, randomBytes };
});

type Maybe<T> = T | Promise<T>;

/** What the scenario needs; both the store (adapted) and the backend satisfy it. */
interface ScenarioApi {
	create(input: { title: string; status: string; parentId?: string; description?: string }): Maybe<TaskRecord>;
	updateStatus(id: string, status: string): Maybe<TaskRecord>;
	setTitle(id: string, title: string): Maybe<TaskRecord>;
	setDescription(id: string, description: string): Maybe<TaskRecord>;
	setType(id: string, type: string): Maybe<TaskRecord>;
	clearType(id: string): Maybe<TaskRecord>;
	addLabel(id: string, label: string): Maybe<TaskRecord>;
	removeLabel(id: string, label: string): Maybe<TaskRecord>;
	setMeta(id: string, key: string, value: string): Maybe<TaskRecord>;
	removeMeta(id: string, key: string): Maybe<TaskRecord>;
	setParent(id: string, parentId: string): Maybe<TaskRecord>;
	removeParent(id: string): Maybe<TaskRecord>;
	addLink(id: string, type: 'blockedBy' | 'duplicateOf' | 'causedBy', target: string): Maybe<TaskRecord>;
	removeLink(id: string, type: 'blockedBy' | 'duplicateOf' | 'causedBy', target: string): Maybe<TaskRecord>;
	addComment(id: string, text: string, author?: string): Maybe<{ task: TaskRecord; comment: unknown }>;
	editComment(id: string, commentId: string, text: string): Maybe<unknown>;
	removeComment(id: string, commentId: string): Maybe<unknown>;
	deleteTask(id: string): Maybe<boolean>;
	get(id: string): Maybe<TaskRecord>;
	list(): Maybe<TaskSummary[]>;
	getLinks(id: string): Maybe<unknown>;
	getTree(id: string): Maybe<unknown>;
	getAncestors(id: string): Maybe<unknown>;
}

function storeApi(store: TaskStore): ScenarioApi {
	return {
		create: i => store.create(i.title, i.status, i.parentId, i.description),
		addComment: (id, text, author) => store.addComment(id, text, author),
		updateStatus: (id, s) => store.updateStatus(id, s),
		setTitle: (id, t) => store.setTitle(id, t),
		setDescription: (id, d) => store.setDescription(id, d),
		setType: (id, t) => store.setType(id, t),
		clearType: id => store.clearType(id),
		addLabel: (id, l) => store.addLabel(id, l),
		removeLabel: (id, l) => store.removeLabel(id, l),
		setMeta: (id, k, v) => store.setMeta(id, k, v),
		removeMeta: (id, k) => store.removeMeta(id, k),
		setParent: (id, p) => store.setParent(id, p),
		removeParent: id => store.removeParent(id),
		addLink: (id, t, target) => store.addLink(id, t, target),
		removeLink: (id, t, target) => store.removeLink(id, t, target),
		editComment: (id, c, t) => store.editComment(id, c, t),
		removeComment: (id, c) => store.removeComment(id, c),
		deleteTask: id => store.deleteTask(id),
		get: id => store.get(id),
		list: () => store.list(),
		getLinks: id => store.getLinks(id),
		getTree: id => store.getTree(id),
		getAncestors: id => store.getAncestors(id),
	};
}

function backendApi(backend: LocalFileBackend): ScenarioApi {
	return {
		create: i => backend.create(i),
		addComment: (id, text, author) => backend.addComment(id, text, { author }),
		updateStatus: (id, s) => backend.updateStatus(id, s),
		setTitle: (id, t) => backend.setTitle(id, t),
		setDescription: (id, d) => backend.setDescription(id, d),
		setType: (id, t) => backend.setType(id, t),
		clearType: id => backend.clearType(id),
		addLabel: (id, l) => backend.addLabel(id, l),
		removeLabel: (id, l) => backend.removeLabel(id, l),
		setMeta: (id, k, v) => backend.setMeta(id, k, v),
		removeMeta: (id, k) => backend.removeMeta(id, k),
		setParent: (id, p) => backend.setParent(id, p),
		removeParent: id => backend.removeParent(id),
		addLink: (id, t, target) => backend.addLink(id, t, target),
		removeLink: (id, t, target) => backend.removeLink(id, t, target),
		editComment: (id, c, t) => backend.editComment(id, c, t),
		removeComment: (id, c) => backend.removeComment(id, c),
		deleteTask: id => backend.deleteTask(id),
		get: id => backend.get(id),
		list: () => backend.list(),
		getLinks: id => backend.getLinks(id),
		getTree: id => backend.getTree(id),
		getAncestors: id => backend.getAncestors(id),
	};
}

/** Strips the one field the backend adds to a record (never stored), everywhere in an answer. */
function withoutRevision(value: unknown): unknown {
	return JSON.parse(
		JSON.stringify(value ?? null, (key, v: unknown) => (key === 'revision' ? undefined : v))
	) as unknown;
}

const BASE = Date.parse('2026-11-08T10:00:00.000Z');

/** Runs the scenario; returns one entry per step: the answer, or `{ error: [name, message] }`. */
async function runScenario(api: ScenarioApi): Promise<unknown[]> {
	let step = 0;
	const log: unknown[] = [];
	const run = async (fn: () => Maybe<unknown>): Promise<unknown> => {
		step += 1;
		vi.setSystemTime(BASE + step * 1000);
		try {
			const answer = withoutRevision(await fn());
			log.push(answer);
			return answer;
		} catch (error) {
			const entry = { error: [(error as Error).name, (error as Error).message] };
			log.push(entry);
			return entry;
		}
	};
	const idOf = (answer: unknown): string => (answer as { id: string }).id;

	const root = idOf(await run(() => api.create({ title: 'Root task', status: 'backlog', description: 'Root body' })));
	const child = idOf(await run(() => api.create({ title: 'Child', status: 'backlog', parentId: root })));
	const grand = idOf(await run(() => api.create({ title: 'Grandchild', status: 'backlog', parentId: child })));
	const other = idOf(await run(() => api.create({ title: 'Other', status: 'in-progress', description: 'Other' })));
	const last = idOf(await run(() => api.create({ title: 'Last', status: 'backlog' })));
	await run(() => api.create({ title: 'Orphan child', status: 'backlog', parentId: 'missing1' }));

	await run(() => api.updateStatus(root, 'in-progress'));
	await run(() => api.updateStatus(root, 'in-progress'));
	await run(() => api.updateStatus(root, 'done'));
	await run(() => api.setTitle(other, 'Other renamed'));
	await run(() => api.setTitle(other, 'Other renamed'));
	await run(() => api.setDescription(other, 'A longer body for the other task'));
	await run(() => api.setDescription(other, ''));
	await run(() => api.setType(child, 'bug'));
	await run(() => api.setType(child, 'bug'));
	await run(() => api.setType(child, 'feature'));
	await run(() => api.clearType(child));
	await run(() => api.addLabel(child, 'urgent'));
	await run(() => api.addLabel(child, 'urgent'));
	await run(() => api.addLabel(child, 'backend'));
	await run(() => api.removeLabel(child, 'urgent'));
	await run(() => api.removeLabel(child, 'absent'));
	await run(() => api.setMeta(grand, 'owner', 'ann'));
	await run(() => api.setMeta(grand, 'owner', 'ann'));
	await run(() => api.setMeta(grand, 'owner', 'bob'));
	await run(() => api.setMeta(grand, 'constructor', 'x'));
	await run(() => api.removeMeta(grand, 'owner'));
	await run(() => api.removeMeta(grand, 'constructor'));

	await run(() => api.setParent(last, root));
	await run(() => api.setParent(root, grand));
	await run(() => api.setParent(root, root));
	await run(() => api.setParent(last, child));
	await run(() => api.removeParent(root));
	await run(() => api.removeParent(last));
	await run(() => api.setParent(last, other));

	await run(() => api.addLink(child, 'blockedBy', other));
	await run(() => api.addLink(child, 'blockedBy', other));
	await run(() => api.addLink(other, 'blockedBy', child));
	await run(() => api.addLink(grand, 'duplicateOf', other));
	await run(() => api.addLink(grand, 'duplicateOf', last));
	await run(() => api.addLink(last, 'causedBy', root));
	await run(() => api.addLink(last, 'causedBy', 'missing1'));
	await run(() => api.addLink(last, 'causedBy', last));
	await run(() => api.removeLink(grand, 'duplicateOf', other));
	await run(() => api.removeLink(grand, 'duplicateOf', other));
	await run(() => api.getLinks(other));

	const added = (await run(() => api.addComment(root, '  first note  ', 'ann'))) as { comment: { id: string } };
	await run(() => api.addComment(root, 'second note'));
	await run(() => api.addComment(root, '   '));
	await run(() => api.editComment(root, added.comment.id, 'first note, edited'));
	await run(() => api.editComment(root, added.comment.id, 'first note, edited'));
	await run(() => api.editComment(root, 'zzzzzz', 'x'));
	await run(() => api.removeComment(root, added.comment.id));

	await run(() => api.get(root));
	await run(() => api.list());
	await run(() => api.getTree(root));
	await run(() => api.getAncestors(grand));

	// Deleting a parent orphans its children; deleting a link target drops the links held towards it.
	await run(() => api.deleteTask(child));
	await run(() => api.deleteTask(other));
	await run(() => api.deleteTask(other));
	await run(() => api.get(other));
	await run(() => api.list());
	return log;
}

/** Relative path -> exact bytes of every file under `dir`. */
function snapshot(dir: string): Map<string, Buffer> {
	const files = new Map<string, Buffer>();
	const walk = (current: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else files.set(path.relative(dir, full).split(path.sep).join('/'), fs.readFileSync(full));
		}
	};
	walk(dir);
	return files;
}

describe('golden: TaskStore and LocalFileBackend leave the same bytes', () => {
	const roots: string[] = [];

	function freshData(): { dataDir: string; tasksDir: string } {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-backend-golden-'));
		roots.push(root);
		const tasksDir = path.join(root, 'data', 'tasks');
		fs.mkdirSync(tasksDir, { recursive: true });
		return { dataDir: path.join(root, 'data'), tasksDir };
	}

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(BASE);
	});

	afterEach(() => {
		vi.useRealTimers();
		for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	});

	it('produces byte-identical task files and task-index.json, and equal answers and errors at every step', async () => {
		const sync = freshData();
		ids.uuid = 0;
		ids.bytes = 0;
		const syncLog = await runScenario(storeApi(new TaskStore(sync.tasksDir)));

		const async = freshData();
		ids.uuid = 0;
		ids.bytes = 0;
		const asyncLog = await runScenario(backendApi(new LocalFileBackend(new TaskStore(async.tasksDir))));

		expect(asyncLog).toEqual(syncLog);

		const expected = snapshot(sync.dataDir);
		const actual = snapshot(async.dataDir);
		// Not vacuous: the index and several task files exist, and some steps really failed.
		expect(expected.has('task-index.json')).toBe(true);
		expect([...expected.keys()].filter(f => f.startsWith('tasks/')).length).toBeGreaterThanOrEqual(3);
		expect(syncLog.filter(e => typeof e === 'object' && e !== null && 'error' in e).length).toBeGreaterThanOrEqual(
			10
		);

		expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
		for (const [file, bytes] of expected) {
			expect(actual.get(file)!.equals(bytes), `${file} differs byte for byte`).toBe(true);
		}
	});
});
