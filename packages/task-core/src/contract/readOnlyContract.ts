// The contract suite of a READ-ONLY backend (design 1.7 and R3): the cases every backend that declares `writes: 'none'` runs
// unchanged. The backend cannot be filled through its own port, so the fixture seeds the system behind it (a fake forge server,
// the real forge) with a fixed scenario; the cases then check what the port READS and that every write is refused loudly.
//
//   runReadOnlyBackendContract('GitHubBackend', () => ({ backend, seed, dispose }), EXPECTED_CAPABILITIES);
//
// Rules: the backend must declare `writes: 'none'` and a hierarchy; a capability that is declared away is asserted as a refusal
// where the suite reads it (search), never skipped. Imports vitest: not part of the package barrel.
import { describe, expect, it } from 'vitest';

import { UnsupportedByBackendError } from '../backend/backendErrors.js';
import type { BackendCapabilities } from '../backend/capabilities.js';
import type { TaskBackend, VersionedRecord } from '../backend/TaskBackend.js';
import { AmbiguousTaskPrefixError, TaskNotFoundError } from '../errors.js';
import type { TaskSummary, TaskTreeNode } from '../TaskStore.js';
import { assertDeclaredCapabilities } from './backendContract.js';

/** Which of the three statuses of the scenario a seeded task has. */
export type SeedStatus = 'initial' | 'next' | 'terminal';

export interface SeedTask {
	/** Name the cases use to find the task back; the fixture returns the id the system gave it. */
	key: string;
	title: string;
	/** The long text; absent = the system holds no more than the title. */
	description?: string;
	status: SeedStatus;
	labels?: string[];
	type?: string;
	/** The key of the parent (always an earlier task of the scenario). */
	parent?: string;
	/** The keys of the tasks that block this one. */
	blockedBy?: string[];
	/** Comment texts, oldest first. */
	comments?: string[];
}

export interface ReadOnlyFixture {
	backend: TaskBackend;
	/** Creates the tasks in the system behind the backend, in order, and returns key -> task id. Called once per case. */
	seed: (tasks: readonly SeedTask[]) => Promise<Record<string, string>>;
	/** Called after the case, pass or fail. */
	dispose?: () => void | Promise<void>;
}

export interface ReadOnlyContractOptions {
	/** The statuses behind `initial`, `next` and `terminal`. Defaults: backlog, in-progress, done. */
	statuses?: { initial: string; next: string; terminal: string };
	/** The type used in the scenario (a type the backend can represent). Default `bug`. */
	type?: string;
}

/**
 * The scenario: a tree (alpha > beta > delta, alpha > gamma), a root (epsilon), a blocker pair (gamma blocked by beta), labels,
 * a type, a long text, comments and one task per status.
 */
export const READ_ONLY_SCENARIO: readonly SeedTask[] = [
	{
		key: 'alpha',
		title: 'Alpha release',
		description: 'The body of the alpha release.',
		status: 'next',
		labels: ['billing', 'urgent'],
		type: 'bug',
	},
	{ key: 'beta', title: 'Beta', status: 'initial', parent: 'alpha', labels: ['billing'] },
	{ key: 'gamma', title: 'Gamma', status: 'terminal', parent: 'alpha', blockedBy: ['beta'] },
	{ key: 'delta', title: 'Delta', status: 'initial', parent: 'beta', comments: ['first note', 'second note'] },
	{ key: 'epsilon', title: 'Epsilon', description: 'Epsilon', status: 'initial' },
];

export interface ReadHarness {
	backend: TaskBackend;
	caps: BackendCapabilities;
	statuses: { initial: string; next: string; terminal: string };
	/** key -> id of the seeded scenario. */
	id: (key: string) => string;
	ids: Record<string, string>;
}

export interface ReadOnlyCase {
	name: string;
	run: (h: ReadHarness) => Promise<void>;
}

const DEFAULT_STATUSES = { initial: 'backlog', next: 'in-progress', terminal: 'done' };

const idsOf = (tasks: readonly { id: string }[]): string[] => tasks.map(task => task.id);

async function rejection(promise: Promise<unknown>): Promise<Error> {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught, 'the call should have been refused').toBeInstanceOf(Error);
	return caught as Error;
}

async function rejectsWith<E extends Error>(promise: Promise<unknown>, type: new (...args: never[]) => E): Promise<E> {
	const error = await rejection(promise);
	expect(error, `expected ${type.name}, got ${error.name}: ${error.message}`).toBeInstanceOf(type);
	return error as E;
}

const isIso = (value: string): boolean => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

function flatten(nodes: readonly TaskTreeNode[]): string[] {
	return nodes.flatMap(node => [node.id, ...flatten(node.children)]);
}

export const READ_ONLY_CASES: readonly ReadOnlyCase[] = [
	{
		name: 'list returns every task in creation order with title, status, creation instant and parent',
		async run({ backend, id, statuses }) {
			const summaries = await backend.list();

			expect(idsOf(summaries)).toEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(id));
			const byKey = (key: string): TaskSummary => summaries.find(task => task.id === id(key))!;
			expect(byKey('alpha')).toMatchObject({ title: 'Alpha release', status: statuses.next });
			expect(byKey('gamma')).toMatchObject({ title: 'Gamma', status: statuses.terminal });
			expect(byKey('epsilon')).toMatchObject({ title: 'Epsilon', status: statuses.initial });
			expect(summaries.every(task => isIso(task.createdAt))).toBe(true);
			expect(byKey('alpha').parentId).toBeUndefined();
			expect(byKey('beta').parentId).toBe(id('alpha'));
			expect(byKey('delta').parentId).toBe(id('beta'));
		},
	},
	{
		name: 'get returns the whole record, with a revision that is stable between reads',
		async run({ backend, id, statuses, caps }) {
			const alpha = await backend.get(id('alpha'));

			expect(alpha).toMatchObject({
				id: id('alpha'),
				title: 'Alpha release',
				description: 'The body of the alpha release.',
				status: statuses.next,
			});
			expect(isIso(alpha.createdAt)).toBe(true);
			expect(isIso(alpha.updatedAt)).toBe(true);
			expect(alpha.updatedAt >= alpha.createdAt).toBe(true);
			expect(alpha.revision).toBeTypeOf('string');
			expect(alpha.revision).not.toBe('');
			expect(alpha.parentId).toBeUndefined();
			expect(alpha.labels).toEqual(expect.arrayContaining(['billing', 'urgent']));
			expect(alpha.type).toBe('bug');
			expect((await backend.get(id('alpha'))).revision).toBe(alpha.revision);
			expect((await backend.getMany([id('alpha')]))[0]!.revision).toBe(alpha.revision);

			const beta = await backend.get(id('beta'));
			expect(beta.parentId).toBe(id('alpha'));
			expect(beta.description).toBeUndefined();
			expect(beta.type).toBeUndefined();
			if (caps.history !== 'none') {
				expect(beta.history.length).toBeGreaterThan(0);
				expect(beta.history.at(-1)!.status).toBe(statuses.initial);
				expect(beta.history.every(entry => isIso(entry.timestamp))).toBe(true);
			} else {
				expect(beta.history).toEqual([]);
			}
		},
	},
	{
		name: 'a description equal to the title is not a description',
		async run({ backend, id }) {
			expect((await backend.get(id('epsilon'))).description).toBeUndefined();
		},
	},
	{
		name: 'comments come back oldest first with their text and instant',
		async run({ backend, id }) {
			const delta = await backend.get(id('delta'));

			expect((delta.comments ?? []).map(comment => comment.text)).toEqual(['first note', 'second note']);
			expect((delta.comments ?? []).every(comment => isIso(comment.at) && comment.id !== '')).toBe(true);
			expect((await backend.get(id('beta'))).comments).toBeUndefined();
		},
	},
	{
		name: 'getMany keeps the order of the ids and rejects a missing one with TaskNotFoundError',
		async run({ backend, id }) {
			const found = await backend.getMany([id('gamma'), id('alpha')]);
			expect(idsOf(found)).toEqual([id('gamma'), id('alpha')]);
			expect(await backend.getMany([])).toEqual([]);

			const error = await rejectsWith(backend.getMany([id('alpha'), '99999']), TaskNotFoundError);
			expect(error.taskId).toBe('99999');
		},
	},
	{
		name: 'an exact id resolves; an unknown one, or a prefix of a known one, is TaskNotFoundError (assigned ids)',
		async run({ backend, id, caps }) {
			expect((await backend.findByPrefix(id('beta'))).id).toBe(id('beta'));
			const error = await rejectsWith(backend.findByPrefix('99999'), TaskNotFoundError);
			expect(error.taskId).toBe('99999');
			if (caps.ids === 'assigned') {
				// "1" must not mean "10" or "11": assigned ids are matched exactly.
				const known = id('alpha');
				const prefix = known.slice(0, -1);
				if (prefix !== '') {
					const prefixError = await rejection(backend.findByPrefix(prefix));
					expect(prefixError).not.toBeInstanceOf(AmbiguousTaskPrefixError);
					expect(prefixError).toBeInstanceOf(TaskNotFoundError);
				}
			}
		},
	},
	{
		name: 'a read of an unknown task is TaskNotFoundError carrying the id',
		async run({ backend }) {
			for (const read of [
				() => backend.get('99999'),
				() => backend.getLinks('99999'),
				() => backend.getLinksLenient('99999'),
			]) {
				const error = await rejectsWith(read(), TaskNotFoundError);
				expect(error.taskId).toBe('99999');
			}
		},
	},
	{
		name: 'listPage walks every task with limit and cursor, once each, and ends without a cursor',
		async run({ backend, id }) {
			const everything = await backend.listPage();
			expect(idsOf(everything.items)).toEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(id));
			expect(everything.nextCursor).toBeUndefined();

			const seen: string[] = [];
			let cursor: string | undefined;
			let pages = 0;
			do {
				const page = await backend.listPage({ limit: 2, cursor });
				expect(page.items.length).toBeLessThanOrEqual(2);
				seen.push(...idsOf(page.items));
				cursor = page.nextCursor;
				pages += 1;
			} while (cursor !== undefined && pages < 10);
			expect(seen).toEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(id));
			expect(pages).toBe(3);
		},
	},
	{
		name: 'listPage filters on status and on parent (null = roots), together with paging',
		async run({ backend, id, statuses }) {
			const initial = await backend.listPage({ statusIn: [statuses.initial] });
			expect(idsOf(initial.items)).toEqual(['beta', 'delta', 'epsilon'].map(id));

			const roots = await backend.listPage({ parentId: null });
			expect(idsOf(roots.items)).toEqual(['alpha', 'epsilon'].map(id));

			const children = await backend.listPage({ parentId: id('alpha') });
			expect(idsOf(children.items)).toEqual(['beta', 'gamma'].map(id));

			const first = await backend.listPage({ statusIn: [statuses.initial], limit: 2 });
			expect(idsOf(first.items)).toEqual(['beta', 'delta'].map(id));
			const second = await backend.listPage({ statusIn: [statuses.initial], limit: 2, cursor: first.nextCursor });
			expect(idsOf(second.items)).toEqual([id('epsilon')]);
			expect(second.nextCursor).toBeUndefined();
		},
	},
	{
		name: 'children, descendants, ancestors, trees and forests follow the parent links',
		async run({ backend, id }) {
			expect(idsOf(await backend.getChildren(id('alpha')))).toEqual(['beta', 'gamma'].map(id));
			expect(await backend.getChildren(id('epsilon'))).toEqual([]);
			expect(idsOf(await backend.getDescendants(id('alpha'))).sort()).toEqual(
				['beta', 'delta', 'gamma'].map(id).sort()
			);
			expect(idsOf(await backend.getAncestors(id('delta')))).toEqual(['beta', 'alpha'].map(id));
			expect(await backend.getAncestors(id('alpha'))).toEqual([]);

			const tree = await backend.getTree(id('alpha'));
			expect(tree.id).toBe(id('alpha'));
			expect(flatten(tree.children).sort()).toEqual(['beta', 'delta', 'gamma'].map(id).sort());
			expect(tree.children.find(node => node.id === id('beta'))!.children.map(node => node.id)).toEqual([
				id('delta'),
			]);

			const full = await backend.getFullTree(id('delta'));
			expect(full.id).toBe(id('alpha'));
			const selected = flatten([full]).filter(taskId => taskId === id('delta'));
			expect(selected).toEqual([id('delta')]);
			const find = (node: TaskTreeNode): TaskTreeNode | undefined =>
				node.id === id('delta') ? node : node.children.map(find).find(found => found !== undefined);
			expect(find(full)!.selected).toBe(true);

			const forest = await backend.getForest();
			expect(forest.map(node => node.id)).toEqual(['alpha', 'epsilon'].map(id));
			const sub = await backend.getForest({ parentId: id('alpha') });
			expect(sub.map(node => node.id)).toEqual(['beta', 'gamma'].map(id));
			const matching = await backend.getForest({ predicate: task => task.id === id('delta') });
			expect(flatten(matching).sort()).toEqual(['alpha', 'beta', 'delta'].map(id).sort());
		},
	},
	{
		name: 'blocking links read both ways and drive the open-blocker queries',
		async run({ backend, id, statuses }) {
			const gamma = await backend.getLinks(id('gamma'));
			expect(idsOf(gamma.blockedBy)).toEqual([id('beta')]);
			expect(gamma.blocks).toEqual([]);
			const beta = await backend.getLinks(id('beta'));
			expect(idsOf(beta.blocks)).toEqual([id('gamma')]);
			expect(beta.blockedBy).toEqual([]);
			expect(await backend.getLinksLenient(id('gamma'))).toMatchObject({ dangling: [] });
			expect((await backend.get(id('gamma'))).links).toEqual([{ type: 'blockedBy', target: id('beta') }]);

			const isTerminal = (status: string): boolean => status === statuses.terminal;
			expect(idsOf(await backend.getOpenBlockers(id('gamma'), isTerminal))).toEqual([id('beta')]);
			expect(await backend.getOpenBlockers(id('beta'), isTerminal)).toEqual([]);
			// beta is not terminal, so it unblocks nothing.
			expect(await backend.getUnblockedBy(id('beta'), isTerminal)).toEqual([]);
		},
	},
	{
		name: 'listLabels counts the labels in use, most used first, then by name',
		async run({ backend }) {
			expect(await backend.listLabels()).toEqual([
				{ label: 'billing', count: 2 },
				{ label: 'urgent', count: 1 },
			]);
		},
	},
	{
		name: 'search by title text finds whole words, case-insensitively, or is refused when declared away',
		async run({ backend, id, caps }) {
			if (caps.search === 'none') {
				const error = await rejectsWith(backend.listPage({ text: 'alpha' }), UnsupportedByBackendError);
				expect(error.capability).toBe('search');
				return;
			}
			expect(idsOf((await backend.listPage({ text: 'alpha' })).items)).toEqual([id('alpha')]);
			expect(idsOf((await backend.listPage({ text: 'gamma'.toUpperCase() })).items)).toEqual([id('gamma')]);
			expect((await backend.listPage({ text: 'nosuchword' })).items).toEqual([]);
		},
	},
	{
		name: 'history and activity follow the declared capability',
		async run({ backend, id, caps }) {
			const record: VersionedRecord = await backend.get(id('alpha'));
			if (caps.activity === 'none') expect(record.activity ?? []).toEqual([]);
			else expect(Array.isArray(record.activity ?? [])).toBe(true);
			if (caps.history !== 'none') expect(record.history.length).toBeGreaterThan(0);
		},
	},
	{
		name: 'every write is refused with UnsupportedByBackendError for the writes capability, and changes nothing',
		async run({ backend, id }) {
			const before = { list: await backend.list(), alpha: await backend.get(id('alpha')) };
			const target = id('alpha');
			const other = id('epsilon');
			const writes: Array<[string, () => Promise<unknown>]> = [
				['create', () => backend.create({ title: 'New', status: 'backlog' })],
				['updateStatus', () => backend.updateStatus(target, 'done')],
				['setTitle', () => backend.setTitle(target, 'x')],
				['setDescription', () => backend.setDescription(target, 'x')],
				['setType', () => backend.setType(target, 'feature')],
				['clearType', () => backend.clearType(target)],
				['addLabel', () => backend.addLabel(target, 'x')],
				['removeLabel', () => backend.removeLabel(target, 'billing')],
				['setMeta', () => backend.setMeta(target, 'k', 'v')],
				['removeMeta', () => backend.removeMeta(target, 'k')],
				['setParent', () => backend.setParent(other, target)],
				['removeParent', () => backend.removeParent(id('beta'))],
				['addLink', () => backend.addLink(other, 'blockedBy', target)],
				['removeLink', () => backend.removeLink(id('gamma'), 'blockedBy', id('beta'))],
				['addComment', () => backend.addComment(target, 'x')],
				['editComment', () => backend.editComment(id('delta'), 'c', 'x')],
				['removeComment', () => backend.removeComment(id('delta'), 'c')],
				['deleteTask', () => backend.deleteTask(target)],
			];
			for (const [operation, call] of writes) {
				const error = await rejectsWith(call(), UnsupportedByBackendError);
				expect(error.capability, operation).toBe('writes');
				expect(error.backendKind, operation).toBe(backend.kind);
				expect(error.operation, operation).toBe(operation);
				expect(error.hint.trim(), operation).not.toBe('');
			}
			expect({ list: await backend.list(), alpha: await backend.get(target) }).toEqual(before);
		},
	},
];

/** Runs one case against a fixture: seeds the scenario, then the case. Rejects on any deviation. */
export async function runReadOnlyCase(
	contractCase: ReadOnlyCase,
	fixture: ReadOnlyFixture,
	options: ReadOnlyContractOptions = {}
): Promise<void> {
	const { backend } = fixture;
	if (backend.capabilities.writes !== 'none') {
		throw new Error(
			`The read-only contract needs a backend that declares writes: 'none' (this one declares ${JSON.stringify(backend.capabilities.writes)}): run runBackendContract instead`
		);
	}
	if (backend.capabilities.hierarchy === 'none') {
		throw new Error('The read-only contract reads parent links: the backend must declare a hierarchy');
	}
	const statuses = options.statuses ?? DEFAULT_STATUSES;
	const scenario = READ_ONLY_SCENARIO.map(task =>
		options.type === undefined || task.type === undefined ? task : { ...task, type: options.type }
	);
	const ids = await fixture.seed(scenario);
	for (const task of scenario) {
		if (ids[task.key] === undefined)
			throw new Error(`The fixture did not return an id for the seeded task "${task.key}"`);
	}
	await contractCase.run({
		backend,
		caps: backend.capabilities,
		statuses,
		ids,
		id: key => {
			const found = ids[key];
			if (found === undefined) throw new Error(`The scenario has no task "${key}"`);
			return found;
		},
	});
}

/**
 * Registers the read-only contract as a vitest `describe` for one backend. `factory` runs once per case (a fresh system).
 * `expectedCapabilities` is what the backend must declare.
 */
export function runReadOnlyBackendContract(
	name: string,
	factory: () => ReadOnlyFixture | Promise<ReadOnlyFixture>,
	expectedCapabilities: BackendCapabilities,
	options: ReadOnlyContractOptions = {}
): void {
	describe(`read-only backend contract: ${name}`, () => {
		it('declares the expected capabilities, with writes refused', async () => {
			const fixture = await factory();
			try {
				assertDeclaredCapabilities(fixture.backend, expectedCapabilities);
				expect(expectedCapabilities.writes).toBe('none');
			} finally {
				await fixture.dispose?.();
			}
		});

		for (const contractCase of READ_ONLY_CASES) {
			it(contractCase.name, async () => {
				const fixture = await factory();
				try {
					await runReadOnlyCase(contractCase, fixture, options);
				} finally {
					await fixture.dispose?.();
				}
			});
		}
	});
}
