// Fixtures of the migrating strategy tests: the SAME suites run over several pairs of sides, so what the wrapper does is proved to
// depend on capabilities and on nothing else. Pair 1: two sides that store the tasks themselves. Pair 2: a side that stores the tasks
// itself and a side behind an HTTP API (the fake server), with metadata through the declared fill, which the identity block needs.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createLocalBackend } from '@wadeck-app/task-core';
import type { TaskBackend, VersionedRecord } from '@wadeck-app/task-core';

import { openTaskContext } from '../../openContext.js';
import { FakeGitHub } from '../github/fakeGitHub.testkit.js';
import { intersectCapabilities, heldBackBy } from './capabilityIntersection.js';
import { contentHash, identityMeta } from './identityBlock.js';
import { MigratingBackend } from './MigratingBackend.js';
import { RoutingIndex } from './routingIndex.js';
import type { IndexFiles, IndexRow, RowState } from './routingIndex.js';

export const SINCE = '2026-11-15T10:00:00.000Z';
export const INDEX_FILE = '/virtual/data/migrating/index.json';
export const STATUSES = ['backlog', 'in-progress', 'review', 'done', 'cancelled', 'duplicate'];

const STATUS_CONFIG = `statuses:
    - backlog
    - in-progress
    - review
    - { name: done, terminal: true }
    - { name: cancelled, terminal: true, outcome: negative }
    - { name: duplicate, terminal: true, outcome: negative }
types:
    - bug
    - feature
`;

/** Index files in memory: deterministic, nothing on disk. */
export function memoryIndexFiles(initial?: string): IndexFiles & { text: string | undefined } {
	const files = {
		text: initial,
		read: (): string | undefined => files.text,
		write: (_file: string, content: string): void => {
			files.text = content;
		},
		ensureDir: (): void => undefined,
	};
	return files;
}

/** Wraps a backend so the names of the methods called on it are recorded (to prove a side was or was not asked). */
function spied(backend: TaskBackend, calls: string[]): TaskBackend {
	return new Proxy(backend, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (typeof value !== 'function' || typeof property !== 'string') return value;
			return (...args: unknown[]) => {
				calls.push(property);
				return (value as (...inner: unknown[]) => unknown).apply(target, args);
			};
		},
	});
}

export interface Pair {
	name: string;
	/** The side the tasks are in. */
	a: TaskBackend;
	/** The side they move to (every call recorded in `bCalls`). */
	b: TaskBackend;
	bCalls: string[];
	/** The same side without the spy, to seed and to check. */
	bRaw: TaskBackend;
	dispose: () => Promise<void>;
}

export interface PairKind {
	name: string;
	open: () => Promise<Pair>;
}

function tempRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
}

async function openLocalPair(): Promise<Pair> {
	const root = tempRoot();
	const bRaw = createLocalBackend(path.join(root, 'b', 'tasks'));
	const bCalls: string[] = [];
	return {
		name: 'local + local',
		a: createLocalBackend(path.join(root, 'a', 'tasks')),
		b: spied(bRaw, bCalls),
		bRaw,
		bCalls,
		dispose: () => {
			fs.rmSync(root, { recursive: true, force: true });
			return Promise.resolve();
		},
	};
}

async function openApiPair(): Promise<Pair> {
	const root = tempRoot();
	const fake = await FakeGitHub.start({ searchLagRequests: 0 });
	const configFile = path.join(root, 'api-config', 'config.yml');
	fs.mkdirSync(path.dirname(configFile), { recursive: true });
	fs.writeFileSync(
		configFile,
		`${STATUS_CONFIG}strategy:
    type: github
    options:
        repo: ${fake.repo}
        baseUrl: ${fake.baseUrl}
        tokenEnv: MIGRATING_TESTKIT_TOKEN
        cache: { ttlSeconds: 0 }
        priorityStorage: label
        timeoutSeconds: 2
        writeSpacingSeconds: 0
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status:in-progress' }
            review: { state: open, label: 'status:review' }
            done: { state: closed }
            cancelled: { state: closed, reason: not_planned }
            duplicate: { state: closed, reason: duplicate }
        fills:
            meta: labels
`,
		'utf8'
	);
	const ctx = openTaskContext({
		storage: { dataDir: path.join(root, 'api-data'), configFiles: [configFile] },
		globalConfigDir: path.join(root, 'global'),
		project: { name: 'api', path: root },
		env: { MIGRATING_TESTKIT_TOKEN: fake.token },
	});
	const bCalls: string[] = [];
	return {
		name: 'local + API (fake server)',
		a: createLocalBackend(path.join(root, 'a', 'tasks')),
		b: spied(ctx.store, bCalls),
		bRaw: ctx.store,
		bCalls,
		dispose: async () => {
			await ctx.dispose?.();
			await fake.stop();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

export const PAIR_KINDS: readonly PairKind[] = [
	{ name: 'local + local', open: openLocalPair },
	{ name: 'local + API (fake server)', open: openApiPair },
];

export interface Wrapped {
	backend: MigratingBackend;
	index: RoutingIndex;
	files: ReturnType<typeof memoryIndexFiles>;
}

/** The wrapper over a pair, with its routing index in memory. The capabilities are the intersection, computed the way the plugin does. */
export function wrap(pair: Pair, files = memoryIndexFiles()): Wrapped {
	const { capabilities } = intersectCapabilities(pair.a.capabilities, pair.b.capabilities);
	const held = heldBackBy({ current: pair.a.capabilities, new: pair.b.capabilities }, capabilities);
	const index = new RoutingIndex({ file: INDEX_FILE, files });
	const backend = new MigratingBackend({
		current: pair.a,
		next: pair.b,
		index,
		capabilities,
		heldBackBy: held,
		statuses: STATUSES,
	});
	return { backend, index, files };
}

export interface Seed {
	/** A parent with two children. */
	parent: VersionedRecord;
	child1: VersionedRecord;
	child2: VersionedRecord;
	/** A root task that is blocked by child1. */
	loose: VersionedRecord;
}

/** The project in `current`: P(C1, C2) and L blockedBy C1. */
export async function seedCurrent(a: TaskBackend): Promise<Seed> {
	const parent = await a.create({ title: 'Parent', status: 'backlog' });
	const child1 = await a.create({ title: 'Child one', status: 'backlog', parentId: parent.id });
	await a.addLabel(child1.id, 'x');
	await a.addLabel(child1.id, 'y');
	const child2 = await a.create({ title: 'Child two', status: 'in-progress', parentId: parent.id });
	await a.addLabel(child2.id, 'x');
	const loose = await a.create({ title: 'Loose', status: 'backlog' });
	await a.addLink(loose.id, 'blockedBy', child1.id);
	return {
		parent: await a.get(parent.id),
		child1: await a.get(child1.id),
		child2: await a.get(child2.id),
		loose: await a.get(loose.id),
	};
}

export interface CopyOptions {
	state: Extract<RowState, 'moving' | 'in-b'>;
	/** The copy in `new` differs from the task in `current` (proves which one is read). */
	title?: string;
	status?: string;
	labels?: readonly string[];
	/** The id in `new` of the parent's copy. */
	parentB?: string;
}

/** What the move will do in a later phase, done by hand: a copy of a task of `current` in `new` with its identity block, and its row. */
export async function copyToNew(pair: Pair, task: VersionedRecord, options: CopyOptions): Promise<IndexRow> {
	const created = await pair.bRaw.create({
		title: options.title ?? task.title,
		status: options.status ?? task.status,
		...(options.parentB === undefined ? {} : { parentId: options.parentB }),
	});
	for (const label of options.labels ?? task.labels ?? []) await pair.bRaw.addLabel(created.id, label);
	const meta = identityMeta({ publicId: task.id, fromId: task.id, hash: contentHash(task) });
	for (const [key, value] of Object.entries(meta)) await pair.bRaw.setMeta(created.id, key, value);
	return { publicId: task.id, a: task.id, b: created.id, state: options.state, since: SINCE, version: 1 };
}

/** A task that exists in `new` only (made there), with its identity block and its row. */
export async function createInNew(
	pair: Pair,
	input: { title: string; status?: string; parentB?: string; labels?: readonly string[] }
): Promise<IndexRow> {
	const created = await pair.bRaw.create({
		title: input.title,
		status: input.status ?? 'backlog',
		...(input.parentB === undefined ? {} : { parentId: input.parentB }),
	});
	for (const label of input.labels ?? []) await pair.bRaw.addLabel(created.id, label);
	const meta = identityMeta({
		publicId: created.id,
		hash: contentHash({ title: input.title, status: input.status ?? 'backlog', labels: input.labels ?? [] }),
	});
	for (const [key, value] of Object.entries(meta)) await pair.bRaw.setMeta(created.id, key, value);
	return { publicId: created.id, b: created.id, state: 'in-b', since: SINCE, version: 1 };
}

/** A row for a task that is only in `current` (explicit, for the cases that want one). */
export function rowInCurrent(id: string, state: 'in-a' | 'deleted' = 'in-a'): IndexRow {
	return { publicId: id, a: id, state, since: SINCE, version: 1 };
}

/** Test-only seeding of the index (phase P1 has no writer of its own). */
export function seedRows(wrapped: Wrapped, rows: readonly IndexRow[]): void {
	wrapped.index.mutate(() => rows);
}
