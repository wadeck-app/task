import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Set-up of the cost tests: a local source project with typical tasks, a GitHub target project (fake server, labels as priority storage,
// metadata in the body block), and a meter that attributes the requests of a run to the stage and the task that made them. The fake
// mirrors the request shape of the real API (it is checked against recorded exchanges), but it is a fake: request COUNTS, not times.
import * as fs from 'node:fs';
import * as path from 'node:path';

import { FakeGitHub } from '../plugins/github/fakeGitHub.testkit.js';
import type { FakeGitHubOptions } from '../plugins/github/fakeGitHub.testkit.js';
import { openResolvedProject } from '../openContext.js';
import { resolveProject } from '../resolveProject.js';
import type { ResolvedProject } from '../resolveProject.js';
import { ownConfigFile } from '../storage.js';
import { createSharedRegistrySandbox } from '../testHelpers.js';
import type { SharedRegistrySandbox } from '../testHelpers.js';
import { migrateProjects } from './migrateProjects.js';
import { DEFAULT_MIGRATION_OPTIONS } from './migrateTypes.js';
import type { MigrationOptions, MigrationProgress, MigrationResult } from './migrateTypes.js';

const TOKEN_VARIABLE = 'TASK_MIGRATE_COST_TOKEN';

const STATUSES_CONFIG = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
types:
    - bug
    - feature
`;

interface GithubTargetOptions {
	/** `priorityStorage` of the target (default label). */
	priorityStorage?: 'label' | 'field' | 'auto';
	/** The meta fill: `body-block` (default), `labels`, or none (the target holds no metadata). */
	meta?: 'body-block' | 'labels' | 'none';
	/** Lines added under `options:` (8 spaces of indentation each). */
	extra?: string;
}

interface TypicalTasks {
	plain?: string;
	closed?: string;
	parent?: string;
	blocker?: string;
	child?: string;
}

interface Measured {
	result: MigrationResult;
	total: { requests: number; writes: number };
	/** Requests and writes up to the last progress line of each stage (the planning reads come before the first line). */
	byStage: Partial<Record<MigrationProgress['stage'], { requests: number; writes: number }>>;
	/** The create, links and comments stages of each source task (the verify stage is read in chunks: see byStage). */
	byTask: Record<string, { requests: number; writes: number }>;
}

class CostWorld {
	readonly sandbox: SharedRegistrySandbox = createSharedRegistrySandbox();
	fake!: FakeGitHub;
	private readonly globalDir: string;

	constructor() {
		this.globalDir = path.join(this.sandbox.root, 'global');
	}

	async start(fake: FakeGitHubOptions = {}): Promise<void> {
		this.fake = await FakeGitHub.start({ repo: 'acme/shop', ...fake });
	}

	async stop(): Promise<void> {
		await this.fake?.stop();
		this.sandbox.cleanup();
	}

	env(): NodeJS.ProcessEnv {
		return { ...this.sandbox.env, [TOKEN_VARIABLE]: this.fake?.token ?? '' };
	}

	async project(name: string, config = ''): Promise<ResolvedProject> {
		const dir = this.sandbox.dir(name);
		const added = await this.sandbox.register(name, dir);
		const resolved = resolveProject({ cwd: dir, projectRef: added.id, env: this.sandbox.env });
		fs.mkdirSync(path.dirname(ownConfigFile(resolved.storage)), { recursive: true });
		fs.writeFileSync(ownConfigFile(resolved.storage), STATUSES_CONFIG + config);
		return resolved;
	}

	githubProject(name: string, options: GithubTargetOptions = {}): Promise<ResolvedProject> {
		const storage = options.priorityStorage ?? 'label';
		const meta = options.meta ?? 'body-block';
		const fills =
			meta === 'none'
				? ''
				: meta === 'labels'
					? '        fills:\n            meta: labels\n'
					: '        fills:\n            meta: { use: body-block, fidelity: degrade }\n';
		return this.project(
			name,
			`strategy:
    type: github
    fidelity: degrade
    options:
        repo: acme/shop
        baseUrl: ${this.fake.baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        writeSpacingSeconds: 0
        timeoutSeconds: 3
        cache: { ttlSeconds: 0 }
        priorityStorage: ${storage}
${storage === 'field' ? '        priorityFieldId: 7\n' : ''}${options.extra ?? ''}        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status:in-progress' }
            done: { state: closed }
${fills}`
		);
	}

	/** The typical tasks; returns their source ids. */
	async seedTypical(
		from: ResolvedProject,
		which: ReadonlyArray<'plain' | 'closed' | 'child'>
	): Promise<TypicalTasks> {
		const ctx = openResolvedProject(from, this.globalDir);
		const ids: TypicalTasks = {};
		try {
			if (which.includes('plain')) {
				ids.plain = (await ctx.store.create({ title: 'Plain task', status: 'backlog' })).id;
			}
			if (which.includes('closed')) {
				// Opened, worked on, closed: three history entries, so the history note is worth writing.
				const closed = await ctx.store.create({
					title: 'Closed task',
					status: 'backlog',
					description: 'What was done and why',
				});
				await ctx.store.updateStatus(closed.id, 'in-progress');
				await ctx.store.updateStatus(closed.id, 'done');
				await ctx.store.setType(closed.id, 'bug');
				await ctx.store.addLabel(closed.id, 'planning');
				await ctx.store.setPriority!(closed.id, 'high');
				ids.closed = closed.id;
			}
			if (which.includes('child')) {
				const parent = await ctx.store.create({ title: 'Parent', status: 'backlog' });
				const blocker = await ctx.store.create({ title: 'Blocker', status: 'backlog' });
				const child = await ctx.store.create({ title: 'Child', status: 'backlog', parentId: parent.id });
				await ctx.store.addLink(child.id, 'blockedBy', blocker.id);
				ids.parent = parent.id;
				ids.blocker = blocker.id;
				ids.child = child.id;
			}
		} finally {
			await ctx.dispose?.();
		}
		return ids;
	}

	/** Two tasks nothing links: a root with every field, and its child (they become issues 1 and 2). */
	async seedFull(from: ResolvedProject): Promise<void> {
		const ctx = openResolvedProject(from, this.globalDir);
		try {
			const root = await ctx.store.create({ title: 'Full one', status: 'backlog', description: 'The details' });
			await ctx.store.setType(root.id, 'bug');
			await ctx.store.addLabel(root.id, 'planning');
			await ctx.store.setPriority!(root.id, 'high');
			await ctx.store.setMeta(root.id, 'owner', 'ann');
			await ctx.store.create({ title: 'Full child', status: 'backlog', parentId: root.id });
		} finally {
			await ctx.dispose?.();
		}
	}

	migrate(
		from: ResolvedProject,
		to: ResolvedProject,
		options: Partial<MigrationOptions> = {},
		onProgress?: (progress: MigrationProgress) => void
	): Promise<MigrationResult> {
		return migrateProjects({
			from,
			to,
			options: { ...DEFAULT_MIGRATION_OPTIONS, ...options },
			resumeCommand: 'task migrate --resume',
			globalConfigDir: this.globalDir,
			env: this.env(),
			...(onProgress === undefined ? {} : { onProgress }),
		});
	}

	/** Runs a migration and counts the requests (and the writes among them) of each stage, and of each task within it. */
	async measure(
		from: ResolvedProject,
		to: ResolvedProject,
		options: Partial<MigrationOptions> = {}
	): Promise<Measured> {
		const fake = this.fake;
		const marks: Array<{ progress: MigrationProgress; requests: number; writes: number }> = [];
		const startRequests = fake.requests.length;
		const startWrites = fake.writes().length;
		const result = await this.migrate(from, to, options, progress => {
			marks.push({ progress, requests: fake.requests.length, writes: fake.writes().length });
		});
		const total = { requests: fake.requests.length - startRequests, writes: fake.writes().length - startWrites };
		const byStage: Measured['byStage'] = {};
		const byTask: Measured['byTask'] = {};
		let before = { requests: startRequests, writes: startWrites };
		for (const mark of marks) {
			const stage = mark.progress.stage;
			const delta = { requests: mark.requests - before.requests, writes: mark.writes - before.writes };
			before = { requests: mark.requests, writes: mark.writes };
			const entry = (byStage[stage] ??= { requests: 0, writes: 0 });
			entry.requests += delta.requests;
			entry.writes += delta.writes;
			const sourceId = mark.progress.sourceId;
			if (sourceId !== undefined && (stage === 'create' || stage === 'links' || stage === 'comments')) {
				const task = (byTask[sourceId] ??= { requests: 0, writes: 0 });
				task.requests += delta.requests;
				task.writes += delta.writes;
			}
		}
		return { result, total, byStage, byTask };
	}
}

/** One line per scenario for the report of a change; printed only when MIGRATE_COST_REPORT is set. */
function report(title: string, measured: Measured, ids: TypicalTasks = {}): void {
	if (process.env['MIGRATE_COST_REPORT'] === undefined) return;
	const names = new Map(Object.entries(ids).map(([name, id]) => [id, name]));
	const task = Object.entries(measured.byTask)
		.map(([id, cost]) => `${names.get(id) ?? id}: ${cost.writes}w/${cost.requests}r`)
		.join(', ');
	const stage = Object.entries(measured.byStage)
		.map(([name, cost]) => `${name} ${cost.writes}w/${cost.requests}r`)
		.join(', ');
	process.stdout.write(
		`[cost] ${title}: total ${measured.total.writes} writes / ${measured.total.requests} requests; estimated ${measured.result.estimate.writes}w/${measured.result.estimate.requests}r; stages: ${stage}; tasks: ${task}\n`
	);
}

// What a migration into a GitHub project costs in writes and requests, counted on the FAKE server for the three typical tasks (the fake
// mirrors the request shape of the real API, but these are counts, not times). The numbers below are a budget: a change that adds a
// write or a request fails here, a change that removes one lowers the number.
let world: CostWorld;

beforeEach(async () => {
	world = new CostWorld();
	await world.start();
});

afterEach(async () => {
	await world.stop();
});

/** The labels of the typical tasks exist already: the steady state of a migration, where a label is created once for all its tasks. */
function seedLabels(): void {
	for (const label of ['type:bug', 'planning', 'priority:high', 'status:in-progress']) world.fake.addRepoLabel(label);
}

describe('cost of a migration into GitHub (fake server request counts, labels already in the repository)', () => {
	beforeEach(seedLabels);

	it('a plain open task is ONE write (the create carries the migration marker in the body block)', async () => {
		const from = await world.project('old');
		const to = await world.githubProject('shop');
		const ids = await world.seedTypical(from, ['plain']);

		const measured = await world.measure(from, to, { allowLoss: ['all'] });

		report('plain open', measured, ids);
		expect(measured.result.status).toBe('completed');
		expect(measured.total.writes).toBe(1);
		expect(measured.total.requests).toBeLessThanOrEqual(5);
		expect(world.fake.writes().map(request => request.method + ' ' + request.path)).toEqual([
			'POST /repos/acme/shop/issues',
		]);
	});

	it('a closed task with type, label, priority label, marker and the history note is THREE writes: create, close, note', async () => {
		const from = await world.project('old');
		const to = await world.githubProject('shop');
		const ids = await world.seedTypical(from, ['closed']);

		const measured = await world.measure(from, to, { allowLoss: ['all'], historyComment: true });

		report('closed full', measured, ids);
		expect(measured.result.status).toBe('completed');
		expect(measured.result.verification!.mismatches).toEqual([]);
		expect(measured.total.writes).toBe(3);
		expect(
			world.fake.writes().map(request => request.method + ' ' + request.path.replace('/repos/acme/shop', ''))
		).toEqual(['POST /issues', 'PATCH /issues/1', 'POST /issues/1/comments']);
		expect(measured.total.requests).toBeLessThanOrEqual(16);
		const issue = world.fake.issues.get(1)!;
		expect(issue.labels.sort()).toEqual(['planning', 'priority:high', 'type:bug']);
		expect(issue.body).toContain('"migratedFrom"');
	});

	it('a child with a parent and a blockedBy link: the creates are one write each, the attach and the link are one each', async () => {
		const from = await world.project('old');
		const to = await world.githubProject('shop');
		const ids = await world.seedTypical(from, ['child']);

		const measured = await world.measure(from, to, { allowLoss: ['all'] });

		report('child + parent + blocker', measured, ids);
		expect(measured.result.status).toBe('completed');
		expect(measured.total.writes).toBe(5);
		expect(measured.byTask[ids.parent!]!.writes).toBe(1);
		expect(measured.byTask[ids.child!]!.writes).toBe(3);
		expect(measured.total.requests).toBeLessThanOrEqual(31);
	});
});

describe('a migration into GitHub that carries fields in the create stays correct', () => {
	beforeEach(seedLabels);

	it('a second run writes nothing and creates nothing', async () => {
		const from = await world.project('old');
		const to = await world.githubProject('shop');
		await world.seedTypical(from, ['closed', 'child']);
		await world.migrate(from, to, { allowLoss: ['all'], historyComment: true });
		const writes = world.fake.writes().length;
		const issues = world.fake.issues.size;

		const again = await world.migrate(from, to, { allowLoss: ['all'], historyComment: true });

		expect(again.counts).toMatchObject({ created: 0, skipped: 4 });
		expect(world.fake.writes().length).toBe(writes);
		expect(world.fake.issues.size).toBe(issues);
	});

	it('a run stopped right after the create resumes by writing only what is missing, and creates no second issue', async () => {
		const from = await world.project('old');
		const to = await world.githubProject('shop');
		await world.seedTypical(from, ['closed']);
		// The create is applied, the close that follows is refused: the issue exists with its labels and its block, open.
		world.fake.failNext({ status: 422, method: 'PATCH', body: { message: 'Validation Failed' } });
		const first = await world.migrate(from, to, { allowLoss: ['all'] });
		expect(first.status).toBe('failed');
		expect(first.failure!.step).toBe('create');
		expect(world.fake.issues.get(1)).toMatchObject({ state: 'open' });
		expect(world.fake.issues.get(1)!.labels.sort()).toEqual(['planning', 'priority:high', 'type:bug']);
		const before = world.fake.writes().length;

		const resumed = await world.migrate(from, to, { allowLoss: ['all'], resume: true });

		expect(resumed.verification!.mismatches).toEqual([]);
		expect(resumed.failure).toBeUndefined();
		expect(resumed.status).toBe('completed');
		expect(resumed.verification!.mismatches).toEqual([]);
		expect(world.fake.issues.size).toBe(1);
		expect(world.fake.issues.get(1)).toMatchObject({ state: 'closed' });
		// The close only: the type, the label, the priority and the marker were written by the create.
		expect(
			world.fake
				.writes()
				.slice(before)
				.map(request => request.method)
		).toEqual(['PATCH']);
	});

	it('--emit-events raises the same events, in the same order, as when each field was a write of its own', async () => {
		const from = await world.project('old');
		const to = await world.githubProject('shop');
		await world.seedTypical(from, ['closed']);

		const result = await world.migrate(from, to, { allowLoss: ['all'], emitEvents: true });

		expect(result.events.map(event => event.name)).toEqual([
			'onTaskCreated',
			'onTaskTypeChanged',
			'onTaskPriorityChanged',
			'onTaskLabelAdded',
			'onTasksMigrated',
		]);
		const created = result.events[0]!.payload as { type?: string; labels: string[]; status: string };
		// The creation event describes the task as the creation made it, the field events follow: what a subscriber saw before.
		expect(created).toMatchObject({ status: 'done', labels: [] });
		expect(created.type).toBeUndefined();
		expect(result.events[3]!.payload).toMatchObject({ label: 'planning' });
	});

	it('a priority kept in the issue field is not in the create: it is written afterwards, and still arrives', async () => {
		await world.stop();
		world = new CostWorld();
		await world.start({ issueFields: [{ id: 7, name: 'Priority', options: ['urgent', 'high', 'medium', 'low'] }] });
		seedLabels();
		const from = await world.project('old');
		const to = await world.githubProject('shop', { priorityStorage: 'field' });
		await world.seedTypical(from, ['closed']);

		const result = await world.migrate(from, to, { allowLoss: ['all'] });

		expect(result.status).toBe('completed');
		expect(result.verification!.mismatches).toEqual([]);
		expect(world.fake.fieldValuesOf(1)).toEqual({ Priority: 'high' });
		expect(world.fake.issues.get(1)!.labels.sort()).toEqual(['planning', 'type:bug']);
		expect(world.fake.writes().map(request => request.path.replace('/repos/acme/shop', ''))).toContain(
			'/issues/1/issue-field-values'
		);
	});

	it('labels the repository lacks are created once, before the creates that use them', async () => {
		await world.stop();
		world = new CostWorld();
		await world.start();
		const from = await world.project('old');
		const to = await world.githubProject('shop');
		await world.seedTypical(from, ['plain', 'closed']);

		const result = await world.migrate(from, to, { allowLoss: ['all'], historyComment: true });

		expect(result.status).toBe('completed');
		const creations = world.fake.writes().filter(request => request.path.endsWith('/labels'));
		expect(creations.map(request => (request.body as { name: string }).name)).toEqual([
			'type:bug',
			'planning',
			'priority:high',
		]);
		const order = world.fake.writes().map(request => request.path.replace('/repos/acme/shop', ''));
		expect(order.indexOf('/labels')).toBeLessThan(order.lastIndexOf('/issues'));
	});

	it('metadata kept as labels rides in the create too, and the unique marker label is created for the task', async () => {
		const from = await world.project('old');
		const to = await world.githubProject('shop', { meta: 'labels' });
		const ids = await world.seedTypical(from, ['plain']);

		const result = await world.migrate(from, to, { allowLoss: ['all'] });

		expect(result.status).toBe('completed');
		expect(world.fake.issues.get(1)!.labels).toEqual([`meta:migratedFrom=${from.id}/${ids.plain!}`]);
		expect(world.fake.writes().map(request => request.path.replace('/repos/acme/shop', ''))).toEqual([
			'/labels',
			'/issues',
		]);
	});
});

describe('the final check reads a task with ONE request unless it has links or comments', () => {
	beforeEach(seedLabels);

	it('one request per task with neither, the whole record for one with a link or the note', async () => {
		const from = await world.project('old');
		const to = await world.githubProject('shop');
		await world.seedTypical(from, ['plain', 'child']);

		const measured = await world.measure(from, to, { allowLoss: ['all'] });

		// Four tasks, one of them (the child) holds a link: three one-request reads and one whole-record read (issue, timeline, blockers).
		expect(measured.byStage.verify!.requests).toBe(3 + 3);
	});

	it.each<[string, (fake: CostWorld['fake'], numbers: { plain: number; child: number }) => void, string]>([
		['title', (fake, n) => fake.updateIssue(n.plain, { title: 'tampered' }), 'title'],
		[
			'description',
			(fake, n) => fake.updateIssue(n.plain, { body: `tampered\n\n${fake.issues.get(n.plain)!.body ?? ''}` }),
			'description',
		],
		['status', (fake, n) => fake.updateIssue(n.plain, { state: 'closed' }), 'status'],
		[
			'type',
			(fake, n) =>
				fake.updateIssue(n.plain, { labels: fake.issues.get(n.plain)!.labels.filter(l => l !== 'type:bug') }),
			'type',
		],
		[
			'labels',
			(fake, n) =>
				fake.updateIssue(n.plain, { labels: fake.issues.get(n.plain)!.labels.filter(l => l !== 'planning') }),
			'labels',
		],
		['meta', (fake, n) => fake.updateIssue(n.plain, { body: '' }), 'meta.migratedFrom'],
		[
			'priority',
			(fake, n) =>
				fake.updateIssue(n.plain, {
					labels: fake.issues.get(n.plain)!.labels.filter(l => l !== 'priority:high'),
				}),
			'priority',
		],
		['parent', (fake, n) => fake.setParent(n.child, null), 'parent'],
	])('a difference in the %s is still reported', async (_name, tamper, field) => {
		const from = await world.project('old');
		const to = await world.githubProject('shop');
		await world.seedFull(from);
		const numbers = { plain: 1, child: 2 };
		let tampered = false;
		let mark = 0;

		const result = await world.migrate(from, to, { allowLoss: ['all'] }, progress => {
			// After the last task is created (nothing has a link or a comment: every one is read with one request), before the check.
			if (progress.stage === 'create' && progress.done === progress.total && !tampered) {
				tampered = true;
				tamper(world.fake, numbers);
				mark = world.fake.requests.length;
			}
		});

		expect(tampered).toBe(true);
		// What follows the tampering is the check alone, and it is ONE request per task (two tasks): the difference was seen through it.
		expect(world.fake.requests.length - mark).toBe(2);
		// A difference is reported, never repaired: the run ends `failed` at the verify step, with every difference listed.
		expect(result.status).toBe('failed');
		expect(result.failure!.step).toBe('verify');
		expect(result.verification!.mismatches.map(mismatch => mismatch.field)).toContain(field);
	});
});

describe('the dry-run estimate against what the fake server counted (no label exists yet: the plan counts them as new)', () => {
	it.each<[string, Array<'plain' | 'closed' | 'child'>, boolean]>([
		['a plain open task', ['plain'], false],
		['a closed task with its fields and the history note', ['closed'], true],
		['a child with a parent and a blockedBy link', ['child'], false],
		['all of them together', ['plain', 'closed', 'child'], true],
	])('%s', async (_name, which, historyComment) => {
		const from = await world.project('old');
		const to = await world.githubProject('shop');
		await world.seedTypical(from, which);
		const options = { allowLoss: ['all'], historyComment };

		const dry = await world.migrate(from, to, { ...options, dryRun: true });
		const measured = await world.measure(from, to, options);

		report(`estimate ${which.join('+')}`, measured);
		expect(measured.result.status).toBe('completed');
		// Writes are counted exactly. Requests within 3 or 5%: a link also makes the reads of the task at its OTHER end read the blockers
		// for a few seconds (the dependency counts lag), which the plan does not model.
		expect(dry.estimate.writes).toBe(measured.total.writes);
		const tolerance = Math.max(3, Math.ceil(measured.total.requests * 0.05));
		expect(Math.abs(dry.estimate.requests - measured.total.requests)).toBeLessThanOrEqual(tolerance);
		expect(dry.estimate.hours).toBeDefined();
	});
});

describe('adoption: only our own interrupted creation is forced back to the plan', () => {
	beforeEach(seedLabels);

	it('a copy found by its marker, with no journal entry, is NOT touched: what a person closed or detached stays, and the plan says so', async () => {
		const from = await world.project('old');
		const to = await world.githubProject('shop');
		const ids = await world.seedTypical(from, ['child']);
		const first = await world.migrate(from, to, { allowLoss: ['all'] });
		const child = [...world.fake.issues.values()].find(issue => issue.title === 'Child')!;
		// A person works on GitHub, and the journal is lost.
		world.fake.updateIssue(child.number, { state: 'closed' });
		world.fake.setParent(child.number, null);
		fs.rmSync(first.journal);
		const writes = world.fake.writes().length;

		const again = await world.migrate(from, to, { allowLoss: ['all'] });

		expect(world.fake.writes().length).toBe(writes);
		expect(world.fake.issues.get(child.number)).toMatchObject({ state: 'closed', parent: null });
		const note = again.notes.find(text => text.includes('found by marker, not touched'));
		expect(note).toBeDefined();
		expect(note).toContain(ids.child!);
		expect(note).toContain('their status/parent were not re-applied');
		// The differences are reported, as before: never repaired.
		expect(again.verification!.mismatches.map(mismatch => mismatch.field)).toEqual(
			expect.arrayContaining(['status', 'parent'])
		);
	});

	it('a journal entry left at the phase `created` (our own interrupted run) has its status put back', async () => {
		const from = await world.project('old');
		const to = await world.githubProject('shop');
		await world.seedTypical(from, ['closed']);
		const first = await world.migrate(from, to, { allowLoss: ['all'] });
		world.fake.updateIssue(1, { state: 'open' });
		const journal = JSON.parse(fs.readFileSync(first.journal, 'utf8')) as {
			status: string;
			tasks: Record<string, { phase: string }>;
		};
		journal.status = 'stopped';
		for (const entry of Object.values(journal.tasks)) entry.phase = 'created';
		fs.writeFileSync(first.journal, JSON.stringify(journal));

		const resumed = await world.migrate(from, to, { allowLoss: ['all'], resume: true });

		expect(resumed.failure).toBeUndefined();
		expect(world.fake.issues.get(1)).toMatchObject({ state: 'closed' });
	});
});

describe('labels are compared as GitHub does: case-insensitively', () => {
	async function requestsWith(existing: string): Promise<{ requests: number; added: number; labels: string[] }> {
		await world.stop();
		world = new CostWorld();
		await world.start();
		world.fake.addRepoLabel(existing);
		const from = await world.project('old');
		const to = await world.githubProject('shop');
		const ctx = openResolvedProject(from, path.join(world.sandbox.root, 'global'));
		const task = await ctx.store.create({ title: 'Labelled', status: 'backlog' });
		await ctx.store.addLabel(task.id, 'bug');
		await ctx.dispose?.();
		const before = world.fake.requests.length;
		const result = await world.migrate(from, to, { allowLoss: ['all'], emitEvents: true });
		expect(result.verification!.mismatches).toEqual([]);
		return {
			requests: world.fake.requests.length - before,
			added: result.events.filter(event => event.name === 'onTaskLabelAdded').length,
			labels: world.fake.issues.get(1)!.labels,
		};
	}

	it('a label that exists as `Bug` and a source label `bug` cost no extra call, and raise one event', async () => {
		const same = await requestsWith('bug');
		const other = await requestsWith('Bug');

		expect(other.requests).toBe(same.requests);
		expect(other.added).toBe(1);
		expect(same.added).toBe(1);
	});
});
