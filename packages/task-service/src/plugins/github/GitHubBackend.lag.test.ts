// Read-your-writes for creations. Measured on the real API: the issue LIST shows a new issue about 4 s after its creation (a read by
// number and an update are immediate). So a task created through task is remembered for a short while, and the reads of the whole
// list add it when the list does not have it yet.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FakeGitHub } from './fakeGitHub.testkit.js';
import { WRITE_STATUS_MAP, WRITE_STATUSES, makeGitHubBackend } from './githubBackend.testkit.js';
import type { TestBackend } from './githubBackend.testkit.js';
import { DiskResponseCache, MemoryResponseCache } from './responseCache.js';

let fake: FakeGitHub;

beforeEach(async () => {
	fake = await FakeGitHub.start({ repo: 'acme/shop', listLagRequests: 3 });
});

afterEach(async () => {
	await fake.stop();
});

function make(extra: Parameters<typeof makeGitHubBackend>[1] = {}): TestBackend {
	return makeGitHubBackend(fake, {
		statuses: WRITE_STATUSES,
		...extra,
		options: { statusMap: WRITE_STATUS_MAP, ...extra.options },
	});
}

const ids = (tasks: ReadonlyArray<{ id: string }>): string[] => tasks.map(task => task.id);

describe('a task created through task shows up in the lists at once', () => {
	it('list, listPage, the forest and the label counts include it while the list does not', async () => {
		fake.addIssue({ title: 'Old', labels: ['billing'] });
		const t = make();

		const created = await t.backend.create({ title: 'New', status: 'backlog' });
		await t.backend.addLabel(created.id, 'billing');

		expect(ids(await t.backend.list())).toEqual(['1', '2']);
		expect(ids((await t.backend.listPage()).items)).toEqual(['1', '2']);
		expect(ids(await t.backend.getForest())).toEqual(['1', '2']);
		expect(await t.backend.listLabels()).toEqual([{ label: 'billing', count: 2 }]);
	});

	it('a listPage with a limit and a status filter keeps both', async () => {
		const t = make();
		const a = await t.backend.create({ title: 'A', status: 'backlog' });
		await t.backend.create({ title: 'B', status: 'backlog' });
		await t.backend.updateStatus(a.id, 'done');

		expect(ids((await t.backend.listPage({ statusIn: ['backlog'] })).items)).toEqual(['2']);
		expect(ids((await t.backend.listPage({ limit: 1 })).items)).toEqual(['1']);
	});

	it('is never twice in a list once the list has caught up, and then costs no request of its own', async () => {
		const t = make();
		await t.backend.create({ title: 'New', status: 'backlog' });
		for (let i = 0; i < 4; i++) await t.backend.list();
		fake.requests.length = 0;

		expect(ids(await t.backend.list())).toEqual(['1']);

		expect(fake.requests.map(request => request.path)).toEqual(['/repos/acme/shop/issues']);
	});

	it('is remembered for a short while only: past 30 s the list is trusted as it is', async () => {
		const t = make();
		await t.backend.create({ title: 'New', status: 'backlog' });
		expect(ids(await t.backend.list())).toEqual(['1']);

		t.clock.ms += 31_000;

		// The fake list still lags (3 requests): a task older than the window is not added back.
		const fresh = await FakeGitHub.start({ repo: 'acme/shop', listLagRequests: 99 });
		try {
			const own = makeGitHubBackend(fresh, {
				statuses: WRITE_STATUSES,
				options: { statusMap: WRITE_STATUS_MAP },
			});
			await own.backend.create({ title: 'Lost', status: 'backlog' });
			expect(ids(await own.backend.list())).toEqual(['1']);
			own.clock.ms += 31_000;
			expect(ids(await own.backend.list())).toEqual([]);
		} finally {
			await fresh.stop();
		}
	});

	it('a remembered task that was deleted since is skipped, not an error', async () => {
		const t = make({ fills: { delete: { use: 'hard', fidelity: 'strict' } } });
		const created = await t.backend.create({ title: 'Short lived', status: 'backlog' });
		await t.backend.deleteTask(created.id);

		expect(ids(await t.backend.list())).toEqual([]);
	});

	it('a tombstone is not added back', async () => {
		const t = make({ fills: { delete: { use: 'tombstone', fidelity: 'degrade' } }, fidelity: 'degrade' });
		const created = await t.backend.create({ title: 'Short lived', status: 'backlog' });
		await t.backend.deleteTask(created.id);

		expect(ids(await t.backend.list())).toEqual([]);
	});

	it('another process sees it: the memory is a file of the cache folder', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-github-lag-'));
		try {
			const disk = (): DiskResponseCache =>
				new DiskResponseCache(
					dir,
					(file, content) => fs.writeFileSync(file, content),
					() => undefined
				);
			const writer = make({ client: { cache: disk() } });
			await writer.backend.create({ title: 'New', status: 'backlog' });

			const reader = make({ client: { cache: disk() } });
			reader.clock.ms = writer.clock.ms + 1000;

			expect(ids(await reader.backend.list())).toEqual(['1']);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('the memory of recent creations', () => {
	it.each([
		['memory', () => new MemoryResponseCache()],
		[
			'disk',
			() => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-github-lag-'));
				return new DiskResponseCache(
					dir,
					(file, content) => fs.writeFileSync(file, content),
					() => undefined
				);
			},
		],
	])('%s: lists the numbers created since an instant, oldest to newest', (_name, open) => {
		const cache = open();
		cache.remember('created', 7, '2026-11-08T12:00:00.000Z');
		cache.remember('created', 9, '2026-11-08T12:00:20.000Z');
		cache.remember('created', 8, '2026-11-08T12:00:10.000Z');
		cache.remember('dependencies', 5, '2026-11-08T12:00:15.000Z');
		cache.remember('created', 8, '2026-11-08T12:00:11.000Z');

		expect(cache.recent('created', '2026-11-08T12:00:05.000Z')).toEqual([8, 9]);
		expect(cache.recent('created', '2026-11-08T11:00:00.000Z')).toEqual([7, 8, 9]);
		expect(cache.recent('created', '2026-11-08T13:00:00.000Z')).toEqual([]);
		expect(cache.recent('dependencies', '2026-11-08T11:00:00.000Z')).toEqual([5]);
	});

	it('a disk cache that holds nothing creates nothing on a read', () => {
		const dir = path.join(os.tmpdir(), `task-github-lag-never-${Date.now()}`);
		const cache = new DiskResponseCache(
			dir,
			() => undefined,
			() => undefined
		);

		expect(cache.recent('created', '2026-11-08T11:00:00.000Z')).toEqual([]);
		expect(fs.existsSync(dir)).toBe(false);
	});

	it('a corrupt file is no memory, not an error', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-github-lag-'));
		try {
			fs.writeFileSync(path.join(dir, '.recent.json'), '{nope');
			const cache = new DiskResponseCache(
				dir,
				(file, content) => fs.writeFileSync(file, content),
				() => undefined
			);

			expect(cache.recent('created', '2026-11-08T11:00:00.000Z')).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('a dependency written through task reads back at once although GitHub counts it late', () => {
	let lagging: FakeGitHub;

	beforeEach(async () => {
		lagging = await FakeGitHub.start({ repo: 'acme/shop', dependencySummaryLagReads: 40 });
		for (const title of ['A', 'B', 'C']) lagging.addIssue({ title });
	});

	afterEach(async () => {
		await lagging.stop();
	});

	const own = (extra: Parameters<typeof makeGitHubBackend>[1] = {}): TestBackend =>
		makeGitHubBackend(lagging, { statuses: WRITE_STATUSES, ...extra, options: { statusMap: WRITE_STATUS_MAP } });

	it('the link, its inverse and the blockers show right after the write, and disappear right after the removal', async () => {
		const t = own();

		const linked = await t.backend.addLink('1', 'blockedBy', '2');
		expect(linked.links).toEqual([{ type: 'blockedBy', target: '2' }]);
		expect(ids((await t.backend.getLinks('1')).blockedBy)).toEqual(['2']);
		expect(ids((await t.backend.getLinks('2')).blocks)).toEqual(['1']);
		expect(ids(await t.backend.getOpenBlockers('1', status => status === 'done'))).toEqual(['2']);

		const unlinked = await t.backend.removeLink('1', 'blockedBy', '2');
		expect(unlinked.links).toBeUndefined();
		expect((await t.backend.getLinks('1')).blockedBy).toEqual([]);
		expect((await t.backend.getLinks('2')).blocks).toEqual([]);
	});

	it('closing the blocker unblocks the task although the counts are late', async () => {
		const t = own();
		await t.backend.addLink('1', 'blockedBy', '2');

		await t.backend.updateStatus('2', 'done');

		expect(ids(await t.backend.getUnblockedBy('2', status => status === 'done'))).toEqual(['1']);
	});

	it('another process sees it too, and after the window the counts are trusted again (no extra request)', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-github-lag-'));
		try {
			const disk = (): DiskResponseCache =>
				new DiskResponseCache(
					dir,
					(file, content) => fs.writeFileSync(file, content),
					() => undefined
				);
			const writer = own({ client: { cache: disk() } });
			await writer.backend.addLink('1', 'blockedBy', '2');

			const reader = own({ client: { cache: disk() } });
			reader.clock.ms = writer.clock.ms + 1000;
			expect(ids((await reader.backend.getLinks('1')).blockedBy)).toEqual(['2']);

			reader.clock.ms = writer.clock.ms + 12_000;
			lagging.requests.length = 0;
			await reader.backend.getLinks('3');
			expect(lagging.requests.map(request => request.path)).toEqual(['/repos/acme/shop/issues/3']);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
