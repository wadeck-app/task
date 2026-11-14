import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import type { TaskBackend, VersionedRecord } from '@wadeck-app/task-core';

import { checkAllowLoss, isLossAllowed } from './lossLedger.js';
import { listAll, readRecords } from './migratePlan.js';
import { runMigration } from './migrateRun.js';
import type { RunMigrationInput } from './migrateRun.js';
import { LOSS_KINDS } from './migrateTypes.js';
import type { MigrationResult } from './migrateTypes.js';
import { localSide, optionsWith } from './migrate.testkit.js';
import type { LocalSide, SideOptions } from './migrate.testkit.js';

const sides: LocalSide[] = [];
function side(options: SideOptions): LocalSide {
	const made = localSide(options);
	sides.push(made);
	return made;
}
afterEach(() => {
	for (const made of sides.splice(0)) fs.rmSync(made.root, { recursive: true, force: true });
});

const SOURCE_ID = 'aaaa1111';
const TARGET_ID = 'bbbb2222';
// A task whose priority or assignee changed after creation has an activity log the port cannot replay.
// The claim of the first seeded task holds a lease, which is a loss of its own.
const ALLOW_HISTORY = optionsWith({ allowLoss: ['history', 'lease'] });

function migrate(
	source: LocalSide,
	target: LocalSide,
	options = optionsWith(),
	extra: Partial<RunMigrationInput> = {}
): Promise<MigrationResult> {
	return runMigration({
		source: source.endpoint,
		target: target.endpoint,
		journalDir: target.dataDir,
		options,
		resumeCommand: 'task migrate --from a --to b --resume',
		...extra,
	});
}

async function byTitle(backend: TaskBackend): Promise<Map<string, VersionedRecord>> {
	const summaries = await listAll(backend);
	const records = await readRecords(
		backend,
		summaries.map(summary => summary.id)
	);
	return new Map(records.map(record => [record.title, record]));
}

/** The target backend as a strategy that carries neither priority, assignee nor claim (github, gitlab, remote today). */
const withoutFields = (backend: TaskBackend): TaskBackend =>
	new Proxy(backend, {
		get(target, property) {
			if (property === 'capabilities') {
				return { ...target.capabilities, priority: false, assignee: false, claim: false };
			}
			return Reflect.get(target, property, target) as unknown;
		},
	});

/** Three tasks: one with a priority and a claim (assignee + lease), one with a priority only, one plain. */
async function seedFields(source: LocalSide): Promise<void> {
	const backend = source.endpoint.backend;
	const first = await backend.create({ title: 'Claimed one', status: 'backlog' });
	await backend.setPriority!(first.id, 'high');
	await backend.claim!(first.id, {
		assignee: 'worker-1',
		now: '2026-11-14T10:00:00.000Z',
		leaseUntil: '2026-11-14T10:30:00.000Z',
	});
	const second = await backend.create({ title: 'Prioritised one', status: 'backlog' });
	await backend.setPriority!(second.id, 'low');
	await backend.create({ title: 'Plain one', status: 'backlog' });
	source.log.writes.length = 0;
}

describe('the loss kinds priority and assignee', () => {
	it('are kinds of their own, allowed alone or with all', () => {
		expect(LOSS_KINDS).toContain('priority');
		expect(LOSS_KINDS).toContain('assignee');
		expect(LOSS_KINDS).toContain('lease');
		expect(checkAllowLoss(['priority', 'assignee'])).toEqual({ accepted: ['priority', 'assignee'], unknown: [] });
		expect(isLossAllowed('priority', ['all'])).toBe(true);
		expect(isLossAllowed('assignee', ['priority'])).toBe(false);
	});
});

describe('the lease of a claim', () => {
	it('is a loss of kind lease for every task holding one, blocking until allowed, even where the assignee is kept', async () => {
		const source = side({ id: SOURCE_ID });
		const target = side({ id: TARGET_ID });
		await seedFields(source);

		const blocked = await migrate(source, target, optionsWith({ allowLoss: ['history'] }));

		expect(blocked.status).toBe('blocked');
		expect(blocked.blocking).toEqual(['lease']);
		const row = blocked.losses.find(entry => entry.kind === 'lease')!;
		expect(row.count).toBe(1);
		expect(row.taskIds).toHaveLength(1);
		expect(row.fix).toContain('task release');
		expect(blocked.losses.some(entry => entry.kind === 'assignee')).toBe(false);
		expect(target.log.writes).toEqual([]);
	});

	it('the dry run lists it, and a lease allowed alone is enough for a source without other losses', async () => {
		const source = side({ id: SOURCE_ID });
		const target = side({ id: TARGET_ID });
		await seedFields(source);

		const plan = await migrate(source, target, optionsWith({ dryRun: true, allowLoss: ['history', 'lease'] }));

		expect(plan.losses.map(row => row.kind)).toEqual(['lease', 'history']);
		expect(plan.losses.every(row => row.allowed)).toBe(true);
		expect(isLossAllowed('lease', ['all'])).toBe(true);
		expect(isLossAllowed('lease', ['assignee'])).toBe(false);
	});

	it('a task with an assignee and no lease (set by hand) is no lease loss', async () => {
		const source = side({ id: SOURCE_ID });
		const target = side({ id: TARGET_ID });
		const created = await source.endpoint.backend.create({ title: 'By hand', status: 'backlog' });
		await source.endpoint.backend.setAssignee!(created.id, 'worker-2');

		const result = await migrate(source, target, optionsWith({ allowLoss: ['history'] }));

		expect(result.status).toBe('completed');
		expect(result.losses.some(row => row.kind === 'lease')).toBe(false);
	});
});

describe('migrating priority and assignee', () => {
	it('carries the priority and the assignee; the claim itself (claimedAt, leaseUntil) is not migrated', async () => {
		const source = side({ id: SOURCE_ID });
		const target = side({ id: TARGET_ID });
		await seedFields(source);

		const result = await migrate(source, target, ALLOW_HISTORY);

		expect(result.status).toBe('completed');
		expect(result.losses.map(row => row.kind)).toEqual(['lease', 'history']);
		const moved = await byTitle(target.endpoint.backend);
		expect(moved.get('Claimed one')).toMatchObject({ priority: 'high', assignee: 'worker-1' });
		expect(moved.get('Claimed one')).not.toHaveProperty('claimedAt');
		expect(moved.get('Claimed one')).not.toHaveProperty('leaseUntil');
		expect(moved.get('Prioritised one')).toMatchObject({ priority: 'low' });
		expect(moved.get('Prioritised one')).not.toHaveProperty('assignee');
		expect(moved.get('Plain one')).not.toHaveProperty('priority');
	});

	it('the dry run counts the priority and assignee writes, and a second run writes nothing', async () => {
		const source = side({ id: SOURCE_ID });
		const target = side({ id: TARGET_ID });
		await seedFields(source);

		const plan = await migrate(source, target, optionsWith({ dryRun: true, allowLoss: ['history', 'lease'] }));
		await migrate(source, target, ALLOW_HISTORY);
		target.log.writes.length = 0;
		const again = await migrate(source, target, ALLOW_HISTORY);

		// Per task: create + marker (3 x 2); plus 2 priorities and 1 assignee.
		expect(plan.estimate.writes).toBe(3 * 2 + 3);
		expect(again.counts).toMatchObject({ created: 0 });
		expect(target.log.writes).toEqual([]);
	});

	it('a target that carries neither is a loss of kind priority and of kind assignee, blocking until allowed', async () => {
		const source = side({ id: SOURCE_ID });
		const target = side({ id: TARGET_ID, wrap: withoutFields });
		await seedFields(source);

		const blocked = await migrate(source, target, ALLOW_HISTORY);

		expect(blocked.status).toBe('blocked');
		expect(blocked.blocking).toEqual(expect.arrayContaining(['priority', 'assignee']));
		const priority = blocked.losses.find(row => row.kind === 'priority')!;
		expect(priority.count).toBe(2);
		expect(priority.taskIds).toHaveLength(2);
		expect(priority.fix).toMatch(/local strategy/);
		expect(blocked.losses.find(row => row.kind === 'assignee')!.count).toBe(1);
		expect(target.log.writes).toEqual([]);

		const allowed = await migrate(
			source,
			target,
			optionsWith({ allowLoss: ['priority', 'assignee', 'history', 'lease'] })
		);
		expect(allowed.status).toBe('completed');
		const moved = await byTitle(target.endpoint.backend);
		expect(moved.get('Claimed one')).not.toHaveProperty('priority');
		expect(moved.get('Claimed one')).not.toHaveProperty('assignee');
	});

	it('a priority the target project does not list is a loss of kind priority naming it; allowed, it is not set', async () => {
		const source = side({ id: SOURCE_ID });
		const target = side({ id: TARGET_ID, priorities: ['high', 'normal'] });
		await seedFields(source);

		const blocked = await migrate(source, target, ALLOW_HISTORY);

		expect(blocked.status).toBe('blocked');
		const row = blocked.losses.find(entry => entry.kind === 'priority')!;
		expect(row.count).toBe(1);
		expect(row.text).toContain('low');
		expect(blocked.losses.some(entry => entry.kind === 'assignee')).toBe(false);

		const allowed = await migrate(source, target, optionsWith({ allowLoss: ['priority', 'history', 'lease'] }));
		expect(allowed.status).toBe('completed');
		const moved = await byTitle(target.endpoint.backend);
		expect(moved.get('Claimed one')).toMatchObject({ priority: 'high', assignee: 'worker-1' });
		expect(moved.get('Prioritised one')).not.toHaveProperty('priority');
	});

	it('--emit-events raises onTaskPriorityChanged and onTaskAssigneeChanged for what the run wrote', async () => {
		const source = side({ id: SOURCE_ID });
		const target = side({ id: TARGET_ID });
		await seedFields(source);

		const run = await migrate(source, target, optionsWith({ allowLoss: ['history', 'lease'], emitEvents: true }));

		const priorities = run.events.filter(event => event.name === 'onTaskPriorityChanged');
		const assignees = run.events.filter(event => event.name === 'onTaskAssigneeChanged');
		expect(priorities.map(event => (event.payload as { newPriority?: string }).newPriority).sort()).toEqual([
			'high',
			'low',
		]);
		expect(assignees).toHaveLength(1);
		expect(assignees[0]!.payload).toMatchObject({ newAssignee: 'worker-1', taskProjectId: TARGET_ID });
		expect(assignees[0]!.payload).not.toHaveProperty('outcome');
		expect(run.events[run.events.length - 1]!.name).toBe('onTasksMigrated');
	});
});
