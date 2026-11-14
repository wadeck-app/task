// Fixtures of the migration tests: endpoints over disposable folders, a backend that counts the writes it receives, and a backend that
// fails or lies on demand. Test-only: nothing in the shipped code imports this file.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LOCAL_TRAITS, createLocalBackend } from '@wadeck-app/task-core';
import type { BackendTraits, TaskBackend, VersionedRecord } from '@wadeck-app/task-core';
import { createRestrictedBackend } from '@wadeck-app/task-core/contract';

import type { ProjectFacts } from '../plugins/kinds.js';
import type { MigrationEndpoint, MigrationOptions } from './migrateTypes.js';
import { DEFAULT_MIGRATION_OPTIONS } from './migrateTypes.js';

export const STATUSES: ProjectFacts['statuses'] = [
	{ name: 'backlog', terminal: false, default: true, outcome: undefined },
	{ name: 'in-progress', terminal: false, default: false, outcome: undefined },
	{ name: 'done', terminal: true, default: false, outcome: 'positive' },
];

/** Every method of the port that changes something. */
export const WRITE_METHODS: ReadonlySet<string> = new Set([
	'create',
	'updateStatus',
	'setTitle',
	'setDescription',
	'setType',
	'clearType',
	'addLabel',
	'removeLabel',
	'setMeta',
	'removeMeta',
	'setParent',
	'removeParent',
	'addLink',
	'removeLink',
	'addComment',
	'editComment',
	'removeComment',
	'deleteTask',
	'syncLabels',
]);

export interface CallLog {
	/** Every call, in order: `<method> <first argument or title>`. */
	calls: string[];
	/** The calls that change something. */
	writes: string[];
}

/** A backend that behaves as `inner` and records every call. `before` may throw to make a call fail (it sees the method and the arguments). */
export function spied(
	inner: TaskBackend,
	before?: (method: string, args: unknown[], log: CallLog) => void
): { backend: TaskBackend; log: CallLog } {
	const log: CallLog = { calls: [], writes: [] };
	const backend = new Proxy(inner, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (typeof property === 'symbol' || typeof value !== 'function') return value;
			return (...args: unknown[]): unknown => {
				const first = args[0];
				const label =
					typeof first === 'string'
						? first
						: typeof first === 'object' && first !== null && 'title' in first
							? String((first as { title: unknown }).title)
							: '';
				log.calls.push(`${property} ${label}`.trim());
				if (WRITE_METHODS.has(property)) log.writes.push(`${property} ${label}`.trim());
				before?.(property, args, log);
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		},
	});
	return { backend, log };
}

/** A backend that behaves as `inner` but shows every record read through `change` (a tampered source, a target that normalises a text). */
export function reading(inner: TaskBackend, change: (record: VersionedRecord) => VersionedRecord): TaskBackend {
	return new Proxy(inner, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (property === 'get' || property === 'findByPrefix') {
				return async (...args: unknown[]): Promise<VersionedRecord> =>
					change(await (value as (...a: unknown[]) => Promise<VersionedRecord>).apply(target, args));
			}
			if (property === 'getMany') {
				return async (...args: unknown[]): Promise<VersionedRecord[]> =>
					(await (value as (...a: unknown[]) => Promise<VersionedRecord[]>).apply(target, args)).map(change);
			}
			return value;
		},
	});
}

export interface LocalSide {
	endpoint: MigrationEndpoint;
	/** The data folder (holds `tasks/`, `task-index.json`, and the journal of a target). */
	dataDir: string;
	root: string;
	log: CallLog;
}

export interface SideOptions {
	id: string;
	name?: string;
	statuses?: ProjectFacts['statuses'];
	types?: string[];
	/** The priorities the project allows, highest first: the backend refuses any other. Absent: any text is accepted. */
	priorities?: string[];
	traits?: Partial<BackendTraits>;
	/** The backend with fewer capabilities of the contract suite (no hierarchy, labels, meta, comments; blockedBy only). */
	restricted?: boolean;
	/** Wraps the backend (to fail a call or to change what is read). */
	wrap?: (backend: TaskBackend) => TaskBackend;
	before?: (method: string, args: unknown[], log: CallLog) => void;
}

/** A project side over a fresh folder. `traits` start from the local ones. */
export function localSide(options: SideOptions): LocalSide {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-migrate-'));
	const dataDir = path.join(root, 'data');
	const tasksDir = path.join(dataDir, 'tasks');
	const raw =
		options.restricted === true
			? createRestrictedBackend(tasksDir)
			: createLocalBackend(tasksDir, options.priorities === undefined ? {} : { priorities: options.priorities });
	const { backend, log } = spied(options.wrap?.(raw) ?? raw, options.before);
	return {
		endpoint: {
			project: { id: options.id, name: options.name ?? `project-${options.id}` },
			backend,
			facts: {
				statuses: options.statuses ?? STATUSES,
				types: options.types ?? [],
				...(options.priorities === undefined ? {} : { priorities: options.priorities }),
			},
			traits: { ...LOCAL_TRAITS, ...options.traits },
		},
		dataDir,
		root,
		log,
	};
}

export function optionsWith(change: Partial<MigrationOptions> = {}): MigrationOptions {
	return { ...DEFAULT_MIGRATION_OPTIONS, ...change };
}

/** Every file under `dir` with its content, to compare a folder before and after. */
export function snapshotFolder(dir: string): Record<string, string> {
	const found: Record<string, string> = {};
	const walk = (current: string): void => {
		if (!fs.existsSync(current)) return;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else found[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
		}
	};
	walk(dir);
	return found;
}

/** A source with a small, varied project: parents, children, every link type, labels, a type, meta, comments with authors, history, a terminal status. */
export async function seedSource(backend: TaskBackend): Promise<Record<string, string>> {
	const ids: Record<string, string> = {};
	const make = async (name: string, status = 'backlog', parent?: string): Promise<string> => {
		const record = await backend.create({
			title: name,
			status,
			...(parent === undefined ? {} : { parentId: ids[parent]! }),
		});
		ids[name] = record.id;
		return record.id;
	};
	await make('Epic');
	await make('Child one', 'backlog', 'Epic');
	await make('Child two', 'backlog', 'Epic');
	await make('Grandchild', 'backlog', 'Child one');
	await make('Standalone');
	await make('Shipped');
	await backend.setType(ids['Epic']!, 'feature');
	await backend.addLabel(ids['Epic']!, 'planning');
	await backend.addLabel(ids['Epic']!, 'q4');
	await backend.setMeta(ids['Child one']!, 'estimate', '3');
	await backend.setMeta(ids['Child one']!, 'owner', 'ann');
	await backend.updateStatus(ids['Child two']!, 'in-progress');
	await backend.updateStatus(ids['Shipped']!, 'done');
	await backend.setDescription(ids['Standalone']!, 'A longer description\nwith two lines');
	await backend.addLink(ids['Child two']!, 'blockedBy', ids['Child one']!);
	await backend.addLink(ids['Standalone']!, 'duplicateOf', ids['Shipped']!);
	await backend.addLink(ids['Grandchild']!, 'causedBy', ids['Standalone']!);
	await backend.addComment(ids['Epic']!, 'First note', { author: 'ann' });
	await backend.addComment(ids['Epic']!, 'Second note', { author: 'bob' });
	await backend.addComment(ids['Child one']!, 'Anonymous note');
	return ids;
}
