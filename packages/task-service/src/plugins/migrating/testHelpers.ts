// Fixtures of the migrating strategy tests: the SAME suites run over several pairs of sides, so what the wrapper does is proved to
// depend on capabilities and on nothing else. Pair 1: two sides that store the tasks themselves. Pair 2: a side that stores the tasks
// itself and a side behind an HTTP API (the fake server), with metadata through the declared fill, which the identity block needs.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LOCAL_TRAITS, createLocalBackend } from '@wadeck-app/task-core';
import type { BackendCapabilities, BackendTraits, TaskBackend, VersionedRecord } from '@wadeck-app/task-core';

import { createTaskCopier } from '../../migrate/taskCopier.js';
import { openTaskContext } from '../../openContext.js';
import type { ResolvedStrategy } from '../../strategyResolve.js';
import type { ProjectFacts, TaskCopier } from '../kinds.js';
import { FakeGitHub } from '../github/fakeGitHub.testkit.js';
import { intersectCapabilities, heldBackBy } from './capabilityIntersection.js';
import { contentHash, identityMeta } from './identityBlock.js';
import type { Authority } from './identityBlock.js';
import { MigratingBackend } from './MigratingBackend.js';
import type { MigratingBackendInput } from './MigratingBackend.js';
import { MigrationJournal } from './migrationJournal.js';
import type { MigrationToolkit } from './migrationToolkit.js';
import type { WalFiles } from './migrationJournal.js';
import { RoutingIndex } from './routingIndex.js';
import type { IndexFiles, IndexRow, RowState } from './routingIndex.js';
import type { WorkerFiles } from './workerFiles.js';

export const SINCE = '2026-11-15T10:00:00.000Z';
export const INDEX_FILE = '/virtual/data/migrating/index.json';
export const STATUSES = ['backlog', 'in-progress', 'review', 'done', 'cancelled', 'duplicate'];

/** The facts of the project of these pairs (the same statuses and types on both sides, as in a real project). */
export const FACTS: ProjectFacts = {
	statuses: [
		{ name: 'backlog', terminal: false, default: true, outcome: undefined },
		{ name: 'in-progress', terminal: false, default: false, outcome: undefined },
		{ name: 'review', terminal: false, default: false, outcome: undefined },
		{ name: 'done', terminal: true, default: false, outcome: 'positive' },
		{ name: 'cancelled', terminal: true, default: false, outcome: 'negative' },
		{ name: 'duplicate', terminal: true, default: false, outcome: 'negative' },
	],
	types: ['bug', 'feature'],
	priorities: ['urgent', 'high', 'medium', 'low'],
};

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

/**
 * Index files in memory: deterministic, nothing on disk. `failWrites` makes the next that many writes fail (a full disk), after
 * `skipWrites` writes that succeed.
 */
export function memoryIndexFiles(
	initial?: string
): IndexFiles & { text: string | undefined; failWrites: number; skipWrites: number } {
	const files = {
		text: initial,
		failWrites: 0,
		skipWrites: 0,
		read: (): string | undefined => files.text,
		write: (_file: string, content: string): void => {
			if (files.skipWrites > 0) files.skipWrites--;
			else if (files.failWrites > 0) {
				files.failWrites--;
				throw new Error('injected fault: the routing index cannot be written');
			}
			files.text = content;
		},
		ensureDir: (): void => undefined,
	};
	return files;
}

/** The files of the migration journal in memory. `failAppend` makes the file with that name refuse appends, after `skipAppends` that succeed. */
export function memoryWalFiles(): WalFiles & {
	texts: Map<string, string>;
	failAppend: Set<string>;
	skipAppends: number;
} {
	const files = {
		texts: new Map<string, string>(),
		failAppend: new Set<string>(),
		skipAppends: 0,
		append(file: string, text: string): void {
			if ([...files.failAppend].some(name => file.endsWith(name))) {
				if (files.skipAppends > 0) files.skipAppends--;
				else throw new Error(`injected fault: ${file} is full`);
			}
			files.texts.set(file, (files.texts.get(file) ?? '') + text);
		},
		read: (file: string): string | undefined => files.texts.get(file),
		ensureDir: (): void => undefined,
		replace(file: string, text: string): void {
			files.texts.set(file, text);
		},
	};
	return files;
}

/**
 * The files of the worker (state, control, heartbeat, lock) in memory, over the journal's. `writes` records every replacement and
 * `failReplace` makes the next that many replacements of a file with that name fail.
 */
export function memoryWorkerFiles(): WorkerFiles & {
	texts: Map<string, string>;
	failAppend: Set<string>;
	skipAppends: number;
	writes: string[];
	failReplace: Map<string, number>;
} {
	const base = memoryWalFiles();
	const files = Object.assign(base, {
		writes: [] as string[],
		failReplace: new Map<string, number>(),
		createExclusive(file: string, text: string): boolean {
			if (base.texts.has(file)) return false;
			base.texts.set(file, text);
			return true;
		},
		remove(file: string): void {
			base.texts.delete(file);
		},
	});
	const replace = base.replace.bind(base);
	files.replace = (file: string, text: string): void => {
		for (const [name, remaining] of files.failReplace) {
			if (file.endsWith(name) && remaining > 0) {
				files.failReplace.set(name, remaining - 1);
				throw new Error(`injected fault: ${file} cannot be written`);
			}
		}
		files.writes.push(file);
		replace(file, text);
	};
	return files;
}

export interface FaultOptions {
	/** The call that fails: the first one after the plan was made by default (1), then the 2nd... */
	nth?: number;
	/** The call IS applied and the answer is lost (the error comes after it ran): the outcome is unknown to the caller. */
	applied?: boolean;
	error?: Error;
}

/**
 * Fault injection for a side: `failOn('setTitle')` makes the next call of that method throw (before it runs, or after it ran with
 * `applied`). Every call of every side is recorded in `calls` as `a:setTitle` / `b:setTitle`, in the order they were made.
 */
export class Faults {
	readonly calls: string[] = [];
	private readonly plans: Array<{ side: string; method: string; remaining: number; options: FaultOptions }> = [];

	failOn(side: 'a' | 'b', method: string, options: FaultOptions = {}): void {
		this.plans.push({ side, method, remaining: options.nth ?? 1, options });
	}

	/** Takes the plan that fires for this call, if any. */
	take(side: string, method: string): FaultOptions | undefined {
		this.calls.push(`${side}:${method}`);
		for (const plan of this.plans) {
			if (plan.side !== side || plan.method !== method) continue;
			plan.remaining--;
			if (plan.remaining === 0) {
				this.plans.splice(this.plans.indexOf(plan), 1);
				return plan.options;
			}
		}
		return undefined;
	}

	/** The calls of one method, in order, as `a` or `b`. */
	of(method: string): string[] {
		return this.calls.filter(call => call.endsWith(`:${method}`)).map(call => call.slice(0, 1));
	}
}

/** The backend under the fault plan; every method is async in the port, so a fault is a rejected promise. */
export function faulty(backend: TaskBackend, side: 'a' | 'b', faults: Faults): TaskBackend {
	return new Proxy(backend, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (typeof value !== 'function' || typeof property !== 'string') return value;
			return async (...args: unknown[]) => {
				const fault = faults.take(side, property);
				const failure = fault?.error ?? new Error(`injected fault: ${side}.${property}`);
				if (fault !== undefined && fault.applied !== true) throw failure;
				const result = await (value as (...inner: unknown[]) => Promise<unknown>).apply(target, args);
				if (fault !== undefined) throw failure;
				return result;
			};
		},
	});
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
	/** What each side keeps (the traits of its strategy). */
	aTraits: BackendTraits;
	bTraits: BackendTraits;
	/** The fake server behind `b`, when it has one (fault injection). */
	fake?: FakeGitHub;
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
		aTraits: LOCAL_TRAITS,
		bTraits: LOCAL_TRAITS,
		bCalls,
		dispose: () => {
			fs.rmSync(root, { recursive: true, force: true });
			return Promise.resolve();
		},
	};
}

function traitsOf(strategy: ResolvedStrategy | undefined): BackendTraits {
	const traits = strategy?.plugin.traitsFor?.(strategy.options, strategy.fills, FACTS);
	if (traits === undefined) throw new Error('the API side declares no traits: this is a bug of the test fixture');
	return traits;
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
            delete: hard
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
		aTraits: LOCAL_TRAITS,
		bTraits: traitsOf(ctx.strategy),
		fake,
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
	journal: MigrationJournal;
	wal: ReturnType<typeof memoryWalFiles>;
	faults: Faults;
	/** The sides as the wrapper holds them (under the fault plan). */
	current: TaskBackend;
	next: TaskBackend;
	copier: TaskCopier;
	/** The log notes a problem of the human log or of a recovery was reported to. */
	problems: string[];
}

export interface WrapOptions {
	files?: ReturnType<typeof memoryIndexFiles>;
	wal?: ReturnType<typeof memoryWalFiles>;
	faults?: Faults;
	clock?: () => number;
	/** Told at every boundary of a transaction (to simulate a crash there by throwing). */
	boundary?: (name: string) => void | Promise<void>;
}

/** The wrapper over a pair, with its routing index in memory. The capabilities are the intersection, computed the way the plugin does. */
export function wrap(pair: Pair, options: WrapOptions = {}): Wrapped {
	const files = options.files ?? memoryIndexFiles();
	const wal = options.wal ?? memoryWalFiles();
	const faults = options.faults ?? new Faults();
	const problems: string[] = [];
	const a = faulty(pair.a, 'a', faults);
	const b = faulty(pair.b, 'b', faults);
	const { capabilities } = intersectCapabilities(pair.a.capabilities, pair.b.capabilities);
	const held = heldBackBy({ current: pair.a.capabilities, new: pair.b.capabilities }, capabilities);
	const index = new RoutingIndex({ file: INDEX_FILE, files });
	let tx = 0;
	const journal = new MigrationJournal({
		dir: path.dirname(INDEX_FILE),
		files: wal,
		now: () => new Date(options.clock?.() ?? Date.now()).toISOString(),
		newTx: () => `tx${++tx}-${Math.random().toString(36).slice(2, 8)}`,
		onLogProblem: text => problems.push(text),
	});
	const copier = createTaskCopier({
		project: { id: 'abcd1234', name: 'shop' },
		facts: FACTS,
		from: { backend: a, traits: pair.aTraits },
		to: { backend: b, traits: pair.bTraits },
	});
	const backend = new MigratingBackend({
		current: a,
		next: b,
		index,
		capabilities,
		heldBackBy: held,
		statuses: STATUSES,
		nextTraits: pair.bTraits,
		journal,
		copier,
		...(options.clock === undefined ? {} : { now: options.clock }),
		...(options.boundary === undefined ? {} : { boundary: options.boundary }),
	});
	return { backend, index, files, journal, wal, faults, current: a, next: b, copier, problems };
}

/** What a MigratingBackend over two plain backends needs besides them (tests that do not use a pair). */
export function engineParts(
	a: TaskBackend,
	b: TaskBackend,
	traits: { a: BackendTraits; b: BackendTraits } = { a: LOCAL_TRAITS, b: LOCAL_TRAITS }
): Pick<MigratingBackendInput, 'nextTraits' | 'journal' | 'copier'> {
	return {
		nextTraits: traits.b,
		journal: new MigrationJournal({ dir: path.dirname(INDEX_FILE), files: memoryWalFiles() }),
		copier: createTaskCopier({
			project: { id: 'abcd1234', name: 'shop' },
			facts: FACTS,
			from: { backend: a, traits: traits.a },
			to: { backend: b, traits: traits.b },
		}),
	};
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
	/** The loss kinds accepted for this copy (kept in the row of a moving task). */
	accepted?: readonly string[];
	/** The authority marker of the identity block (absent: a block written before the marker existed). */
	authority?: Authority;
}

/** What the move will do in a later phase, done by hand: a copy of a task of `current` in `new` with its identity block, and its row. */
export async function copyToNew(pair: Pair, task: VersionedRecord, options: CopyOptions): Promise<IndexRow> {
	const created = await pair.bRaw.create({
		title: options.title ?? task.title,
		status: options.status ?? task.status,
		...(options.parentB === undefined ? {} : { parentId: options.parentB }),
	});
	for (const label of options.labels ?? task.labels ?? []) await pair.bRaw.addLabel(created.id, label);
	const meta = identityMeta({
		publicId: task.id,
		fromId: task.id,
		hash: contentHash(task),
		...(options.authority === undefined ? {} : { authority: options.authority }),
	});
	for (const [key, value] of Object.entries(meta)) await pair.bRaw.setMeta(created.id, key, value);
	return {
		publicId: task.id,
		a: task.id,
		b: created.id,
		state: options.state,
		since: SINCE,
		version: 1,
		...(options.state === 'moving' && options.accepted !== undefined ? { accepted: [...options.accepted] } : {}),
	};
}

/** A task that exists in `new` only (made there), with its identity block and its row. */
export async function createInNew(
	pair: Pair,
	input: { title: string; status?: string; parentB?: string; labels?: readonly string[]; authority?: Authority }
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
		...(input.authority === undefined ? {} : { authority: input.authority }),
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

/** A clock a test drives: `sleep` advances it (nothing waits), and every pause the worker asked for is recorded in `sleeps`. */
export class FakeClock {
	readonly sleeps: number[] = [];
	/** Told after every sleep (a test acts "while the worker sleeps": a pause request, a lease that ends...). */
	onSleep?: (ms: number) => void | Promise<void>;
	constructor(private t = Date.UTC(2026, 10, 16, 9, 0, 0)) {}
	readonly now = (): number => this.t;
	advance(ms: number): void {
		this.t += ms;
	}
	readonly sleep = async (ms: number): Promise<void> => {
		this.sleeps.push(ms);
		this.t += ms;
		await this.onSleep?.(ms);
	};
}

export const MIGRATING_DIR = path.dirname(INDEX_FILE);

export interface ToolkitOptions {
	clock?: FakeClock;
	files?: ReturnType<typeof memoryWorkerFiles>;
	budget?: { requestsPerMinute?: number };
	/** What the process table says about a pid (default: every pid is alive). */
	isAlive?: (pid: number) => boolean;
	pid?: number;
	host?: string;
	nextCapabilities?: BackendCapabilities;
	nextTraits?: BackendTraits;
}

/**
 * The toolkit of an opened migrating strategy, over a wrapped pair, with the files of the worker in memory. The journal's own files
 * are the wrapper's (`wrapped.wal`), so the log the commands read is the one the moves write.
 */
export type MemoryWorkerFiles = ReturnType<typeof memoryWorkerFiles>;

export function toolkitOf(
	wrapped: Wrapped,
	pair: Pair,
	options: ToolkitOptions = {}
): MigrationToolkit & { files: MemoryWorkerFiles } {
	const clock = options.clock ?? new FakeClock();
	const files = options.files ?? memoryWorkerFiles();
	// The journal writes into `wrapped.wal`; the worker's files must show the same log, so the two share their texts.
	files.texts = wrapped.wal.texts;
	return {
		dir: MIGRATING_DIR,
		files,
		current: wrapped.current,
		nextCapabilities: options.nextCapabilities ?? pair.b.capabilities,
		nextTraits: options.nextTraits ?? pair.bTraits,
		index: wrapped.index,
		journal: wrapped.journal,
		copier: wrapped.copier,
		moves: wrapped.backend.moves,
		...(options.budget === undefined ? {} : { budget: options.budget }),
		now: clock.now,
		isAlive: options.isAlive ?? (() => true),
		host: options.host ?? 'box',
		pid: options.pid ?? 4242,
	};
}
