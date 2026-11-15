import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createLocalBackend, LOCAL_CAPABILITIES, UnsupportedByBackendError } from '@wadeck-app/task-core';
import type { BackendCapabilities, TaskBackend } from '@wadeck-app/task-core';

import { openTaskContext } from '../../openContext.js';
import { FakeGitHub } from '../github/fakeGitHub.testkit.js';
import { MigratingBackend } from './MigratingBackend.js';

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const STATUSES = ['backlog', 'in-progress', 'done'];

function wrapperOver(
	capabilities: Partial<BackendCapabilities>,
	heldBackBy: ConstructorParameters<typeof MigratingBackend>[0]['heldBackBy'] = {},
	current: TaskBackend = createLocalBackend(path.join(root, 'tasks'))
): MigratingBackend {
	return new MigratingBackend({
		current,
		capabilities: { ...LOCAL_CAPABILITIES, ...capabilities },
		heldBackBy,
		statuses: STATUSES,
	});
}

async function refusal(promise: Promise<unknown>): Promise<UnsupportedByBackendError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(UnsupportedByBackendError);
		return error as UnsupportedByBackendError;
	}
	throw new Error('the call should have been refused');
}

describe('MigratingBackend: the refusals of the intersection', () => {
	it('a refusal names the operation, the capability, the migrating kind and the side that holds it back, with a way out', async () => {
		const backend = wrapperOver({ meta: false }, { meta: ['new'] });
		const task = await backend.create({ title: 'a', status: 'backlog' });

		const error = await refusal(backend.setMeta(task.id, 'k', 'v'));

		expect(error.capability).toBe('meta');
		expect(error.backendKind).toBe('migrating');
		expect(error.message).toContain('setting metadata');
		expect(error.hint).toContain('"new"');
		expect(error.hint).toContain('a task made that way could not be moved there later');
	});

	it('the refusal is a rejected promise even for a call that fails before it reaches a side', async () => {
		const backend = wrapperOver({ meta: false });
		const promise = backend.setMeta('x', 'k', 'v');
		expect(promise).toBeInstanceOf(Promise);
		await expect(promise).rejects.toBeInstanceOf(UnsupportedByBackendError);
	});

	it('a refused call changes nothing in the side', async () => {
		const side = createLocalBackend(path.join(root, 'tasks'));
		const backend = wrapperOver({ labels: false, writes: 'full' }, { labels: ['new'] }, side);
		const task = await backend.create({ title: 'a', status: 'backlog' });

		await refusal(backend.addLabel(task.id, 'x'));
		await refusal(backend.removeLabel(task.id, 'x'));
		await refusal(backend.listLabels());

		expect((await side.get(task.id)).labels).toBeUndefined();
	});

	it.each([
		['priority', (b: MigratingBackend) => b.setPriority('x', 'high'), 'priority'],
		['priority', (b: MigratingBackend) => b.clearPriority('x'), 'priority'],
		['assignee', (b: MigratingBackend) => b.setAssignee('x', 'w'), 'assignee'],
		['assignee', (b: MigratingBackend) => b.clearAssignee('x'), 'assignee'],
		[
			'claim',
			(b: MigratingBackend) =>
				b.claim('x', {
					assignee: 'w',
					leaseUntil: '2099-01-01T00:00:00.000Z',
					now: '2098-01-01T00:00:00.000Z',
				}),
			'claim',
		],
		['claim', (b: MigratingBackend) => b.release('x'), 'claim'],
		['comments', (b: MigratingBackend) => b.addComment('x', 't'), 'comments'],
		['comments', (b: MigratingBackend) => b.editComment('x', 'c', 't'), 'comments'],
		['comments', (b: MigratingBackend) => b.removeComment('x', 'c'), 'comments'],
		['labels', (b: MigratingBackend) => b.addLabel('x', 'l'), 'labels'],
		['meta', (b: MigratingBackend) => b.removeMeta('x', 'k'), 'meta'],
		['delete', (b: MigratingBackend) => b.deleteTask('x'), 'delete'],
		['hierarchy', (b: MigratingBackend) => b.setParent('x', 'y'), 'hierarchy'],
		['hierarchy', (b: MigratingBackend) => b.create({ title: 't', status: 'backlog', parentId: 'y' }), 'hierarchy'],
		['linkTypes', (b: MigratingBackend) => b.addLink('x', 'causedBy', 'y'), 'linkTypes'],
		['linkTypes', (b: MigratingBackend) => b.removeLink('x', 'causedBy', 'y'), 'linkTypes'],
		['search', (b: MigratingBackend) => b.listPage({ text: 'a' }), 'search'],
		['concurrency', (b: MigratingBackend) => b.setTitle('x', 't', { expectedRevision: 'r' }), 'concurrency'],
		['concurrency', (b: MigratingBackend) => b.updateStatus('x', 'done', { expectedRevision: 'r' }), 'concurrency'],
		['status', (b: MigratingBackend) => b.updateStatus('x', 'invented'), 'status'],
		['status', (b: MigratingBackend) => b.create({ title: 't', status: 'invented' }), 'status'],
	] as const)('%s is refused (%#)', async (_name, call, capability) => {
		const backend = wrapperOver({
			priority: false,
			assignee: false,
			claim: false,
			comments: false,
			labels: false,
			meta: false,
			delete: 'no',
			hierarchy: 'none',
			linkTypes: ['blockedBy'],
			search: 'none',
			concurrency: 'none',
			status: 'mapped',
		});

		expect((await refusal(call(backend))).capability).toBe(capability);
	});

	it('every write is refused when the intersection has no writes, and the refusal names writes', async () => {
		const backend = wrapperOver({ writes: 'none' });

		for (const call of [
			() => backend.create({ title: 't', status: 'backlog' }),
			() => backend.setTitle('x', 't'),
			() => backend.setType('x', 'bug'),
			() => backend.addLabel('x', 'l'),
			() => backend.addComment('x', 't'),
			() => backend.deleteTask('x'),
			() => backend.setPriority('x', 'high'),
			() =>
				backend.claim('x', {
					assignee: 'w',
					leaseUntil: '2099-01-01T00:00:00.000Z',
					now: '2098-01-01T00:00:00.000Z',
				}),
		]) {
			expect((await refusal(call())).capability).toBe('writes');
		}
	});

	it('what the intersection allows goes through to current unchanged', async () => {
		const backend = wrapperOver({});
		const a = await backend.create({ title: 'a', status: 'backlog' });
		const b = await backend.create({ title: 'b', status: 'backlog' });

		await backend.setMeta(a.id, 'k', 'v');
		await backend.addLink(a.id, 'blockedBy', b.id);
		await backend.updateStatus(a.id, 'invented-but-free');

		expect((await backend.get(a.id)).meta).toEqual({ k: 'v' });
		expect((await backend.getLinks(a.id)).blockedBy.map(task => task.id)).toEqual([b.id]);
		expect((await backend.get(a.id)).status).toBe('invented-but-free');
		expect((await backend.listPage({ text: 'a' })).items.map(task => task.id)).toEqual([a.id]);
	});

	it('a side that declares priority without implementing it is a loud bug report, not a silent success', async () => {
		// An own property shadows the method of the class: the side then lacks setPriority.
		const bare = Object.defineProperty(createLocalBackend(path.join(root, 'tasks')), 'setPriority', {
			value: undefined,
		}) as TaskBackend;
		const backend = wrapperOver({}, {}, bare);

		await expect(backend.setPriority('x', 'high')).rejects.toThrow(
			'declares priority, assignee and claim but does not implement setPriority'
		);
	});
});

describe('MigratingBackend: optional members of the port are present only when the side has them', () => {
	it('prepare and syncLabels are absent when current has neither', () => {
		const side = createLocalBackend(path.join(root, 'tasks'));
		const backend = wrapperOver({}, {}, side);

		expect(backend.prepare).toBeUndefined();
		expect(backend.syncLabels).toBeUndefined();
	});

	it('prepare and syncLabels are forwarded when current has them', async () => {
		const calls: unknown[] = [];
		const side = Object.assign(createLocalBackend(path.join(root, 'tasks')), {
			prepare: (needs: unknown) => {
				calls.push(['prepare', needs]);
				return Promise.resolve();
			},
			syncLabels: (options: unknown) => {
				calls.push(['syncLabels', options]);
				return Promise.resolve({ dryRun: true, wanted: [], created: [], existing: [], notes: [] });
			},
		});
		const backend = wrapperOver({}, {}, side);

		await backend.prepare?.({ priority: true });
		await backend.syncLabels?.({ dryRun: true });

		expect(calls).toEqual([
			['prepare', { priority: true }],
			['syncLabels', { dryRun: true }],
		]);
	});

	it('createMigrated is never offered: the wrapper has no creation of its own that folds fields', () => {
		expect((wrapperOver({}) as TaskBackend).createMigrated).toBeUndefined();
	});
});

describe('the migrating strategy in state in-a never writes to the second side', () => {
	it('after creating, changing, commenting and linking, the API of the second side saw no write', async () => {
		const fake = await FakeGitHub.start({ searchLagRequests: 0 });
		try {
			const configFile = path.join(root, 'config', 'config.yml');
			fs.mkdirSync(path.dirname(configFile), { recursive: true });
			fs.writeFileSync(
				configFile,
				`statuses:
    - backlog
    - { name: done, terminal: true }
strategy:
    type: migrating
    options:
        current: { type: local }
        new:
            type: github
            options:
                repo: ${fake.repo}
                baseUrl: ${fake.baseUrl}
                tokenEnv: MIGRATING_TEST_TOKEN
                writeSpacingSeconds: 0
                statusMap:
                    backlog: { state: open }
                    done: { state: closed }
`,
				'utf8'
			);
			const ctx = openTaskContext({
				storage: { dataDir: path.join(root, 'data'), configFiles: [configFile] },
				globalConfigDir: path.join(root, 'global'),
				project: { name: 'shop', path: root },
				env: { MIGRATING_TEST_TOKEN: fake.token },
			});
			const a = await ctx.store.create({ title: 'a', status: 'backlog' });
			const b = await ctx.store.create({ title: 'b', status: 'backlog' });
			await ctx.store.updateStatus(a.id, 'done');
			await ctx.store.addComment(a.id, 'note');
			await ctx.store.addLink(b.id, 'blockedBy', a.id);
			await ctx.store.setParent(b.id, a.id);
			await ctx.store.addLabel(a.id, 'l');
			await ctx.store.deleteTask(a.id).catch(() => undefined);

			expect(fake.writes()).toEqual([]);
			await ctx.dispose?.();
		} finally {
			await fake.stop();
		}
	});
});
