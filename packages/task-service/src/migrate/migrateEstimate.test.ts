import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BackendTraits, MigrationCostModelResult, MigrationTaskFacts } from '@wadeck-app/task-core';

import { localSide, optionsWith, seedSource } from './migrate.testkit.js';
import type { LocalSide, SideOptions } from './migrate.testkit.js';
import { runMigration } from './migrateRun.js';
import type { MigrationResult } from './migrateTypes.js';

// The estimate `task migrate --dry-run` prints: from the plan, through the cost model of the target when it has one (GitHub), else per write.
const sides: LocalSide[] = [];
function side(options: SideOptions): LocalSide {
	const made = localSide(options);
	sides.push(made);
	return made;
}
afterEach(() => {
	for (const made of sides.splice(0)) fs.rmSync(made.root, { recursive: true, force: true });
});

async function dryRun(
	cost: NonNullable<BackendTraits['cost']>,
	sourceCost?: BackendTraits['cost']
): Promise<MigrationResult> {
	const source = side({ id: 'aaaa1111', ...(sourceCost === undefined ? {} : { traits: { cost: sourceCost } }) });
	const target = side({ id: 'bbbb2222', traits: { cost } });
	await seedSource(source.endpoint.backend);
	return runMigration({
		source: source.endpoint,
		target: target.endpoint,
		journalDir: target.dataDir,
		options: optionsWith({ dryRun: true, allowLoss: ['history'] }),
		resumeCommand: 'task migrate --resume',
	});
}

const answer = (
	writes: number,
	requests = writes * 4,
	verifyRequests = 0,
	notes: string[] = []
): MigrationCostModelResult => ({
	writes,
	requests,
	verifyRequests,
	notes,
});

describe('the estimate uses the cost model of the target when it has one', () => {
	it('hands it the facts of every task still to write, and takes its writes and requests instead of a flat cost per write', async () => {
		const model = vi.fn((_tasks: readonly MigrationTaskFacts[]) => answer(10, 50, 6, ['counted from the plan']));

		const result = await dryRun({ requests: 4, seconds: 3, read: { requests: 2, seconds: 1 }, model });

		const facts = model.mock.calls[0]![0];
		expect(facts).toHaveLength(6);
		expect(facts.every(task => task.state === 'new' && task.marker)).toBe(true);
		const epic = facts.find(task => task.type === 'feature')!;
		expect(epic).toMatchObject({ labels: ['planning', 'q4'], comments: 2, status: 'backlog', hasParent: false });
		expect(facts.filter(task => task.hasParent)).toHaveLength(3);
		expect(facts.flatMap(task => task.links).sort()).toEqual(['blockedBy', 'causedBy', 'duplicateOf'].sort());
		expect(result.estimate.writes).toBe(10);
		// The model's requests (the check's included) and the one request that listed the target; no flat cost per write, no second count of the read-back.
		expect(result.estimate.requests).toBe(50 + 1);
		// 10 writes x 3 s, and the 6 check reads at half a second each (the read costs 1 s for 2 requests).
		expect(result.estimate.seconds).toBe(10 * 3 + 6 * 0.5);
		expect(result.notes.join('\n')).toContain('counted from the plan');
	});

	it("adds the reads of the source and of the scan for markers to the model's requests", async () => {
		const result = await dryRun(
			{ requests: 4, seconds: 3, read: { requests: 2, seconds: 1 }, model: () => answer(10, 50, 0) },
			{ requests: 0, seconds: 0, read: { requests: 3, seconds: 0.5 } }
		);

		// 6 source tasks read at 3 requests each.
		expect(result.estimate.requests).toBe(50 + 1 + 6 * 3);
	});

	it('without a model every write costs the same, as before', async () => {
		const result = await dryRun({ requests: 4, seconds: 3 });

		expect(result.estimate.requests).toBe(result.estimate.writes * 4);
	});
});

describe('the hourly cap on requests that change the target', () => {
	const cap = {
		perHour: 500,
		perMinute: 80,
		source: 'GitHub documents 80 content-generating requests a minute and 500 an hour',
	};

	it('over the cap, the estimate gives the hours and a warning says what to expect and how to continue', async () => {
		const result = await dryRun({
			requests: 4,
			seconds: 3,
			quotaPerHour: 5000,
			contentCap: cap,
			model: () => answer(1200, 4800, 0),
		});

		expect(result.estimate.hours).toBe(2.4);
		expect(result.estimate.contentCapPerHour).toBe(500);
		const warning = result.warnings.find(text => text.includes('at least 2.4 h'));
		expect(warning).toBeDefined();
		expect(warning).toContain('1200 writes');
		expect(warning).toContain('500 content-generating requests an hour');
		expect(warning).toContain('--resume');
		expect(warning).toContain('per task');
		expect(warning).toContain('5000');
		expect(warning).toContain('GitHub documents');
	});

	it('within the cap there is no warning, and the hours are the time at the pace of the writes', async () => {
		const result = await dryRun({
			requests: 4,
			seconds: 36,
			contentCap: cap,
			model: () => answer(100, 400, 0),
		});

		expect(result.warnings.join('\n')).not.toMatch(/content-generating/);
		// 100 writes at 36 s: one hour, which is more than the cap alone asks (0.2 h).
		expect(result.estimate.hours).toBe(1);
	});

	it('a target with no cost declares no hours', async () => {
		const target = side({ id: 'bbbb2222' });
		const source = side({ id: 'aaaa1111' });
		await seedSource(source.endpoint.backend);

		const result = await runMigration({
			source: source.endpoint,
			target: target.endpoint,
			journalDir: target.dataDir,
			options: optionsWith({ dryRun: true, allowLoss: ['history'] }),
			resumeCommand: 'task migrate --resume',
		});

		expect(result.estimate.hours).toBeUndefined();
	});
});
