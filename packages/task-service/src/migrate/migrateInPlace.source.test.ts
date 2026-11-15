import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskBackend } from '@wadeck-app/task-core';

import { inPlaceJournalFileName } from './migrateJournal.js';
import { listAll } from './migratePlan.js';
import { runMigration } from './migrateRun.js';
import type { InPlaceHooks } from './migrateRun.js';
import type { MigrationOptions } from './migrateTypes.js';
import { localSide, optionsWith, reading, seedSource } from './migrate.testkit.js';
import type { LocalSide, SideOptions } from './migrate.testkit.js';

// Engine side of `--in-place`: the source that moves under the run (finding 4) and the differences that can never clear (finding 5).
const sides: LocalSide[] = [];
function side(options: SideOptions): LocalSide {
	const made = localSide(options);
	sides.push(made);
	return made;
}
afterEach(() => {
	for (const made of sides.splice(0)) fs.rmSync(made.root, { recursive: true, force: true });
});

const PROJECT_ID = 'dddd4444';

function hooks(target: LocalSide, switchConfig: InPlaceHooks['switchConfig']): InPlaceHooks {
	return {
		target: { hash: 'hash-1', parts: { type: 'a' }, location: 'kind:local' },
		source: { kind: 'local', location: 'kind:local' },
		idMapFile: path.join(target.dataDir, 'idmap.json'),
		switchConfig,
	};
}

/** A source that does `change` just before it answers its second listing: the one the engine makes right before it switches. */
function changingSource(change: (inner: TaskBackend) => Promise<unknown>): SideOptions['wrap'] {
	return inner => {
		let listings = 0;
		return new Proxy(inner, {
			get(target, property, receiver) {
				if (property !== 'listPage') return Reflect.get(target, property, receiver) as unknown;
				return async (...args: Parameters<TaskBackend['listPage']>) => {
					listings++;
					if (listings === 2) await change(target);
					return target.listPage(...args);
				};
			},
		});
	};
}

async function started(wrap: SideOptions['wrap']) {
	const source = side({ id: PROJECT_ID, ...(wrap === undefined ? {} : { wrap }) });
	await seedSource(source.endpoint.backend);
	const target = side({ id: PROJECT_ID });
	const switchConfig = vi.fn();
	const again = (options: Partial<MigrationOptions> = {}): ReturnType<typeof runMigration> =>
		runMigration({
			source: source.endpoint,
			target: target.endpoint,
			journalDir: target.dataDir,
			options: optionsWith({ allowLoss: ['history'], ...options }),
			resumeCommand: 'resume',
			inPlace: hooks(target, switchConfig),
		});
	const first = await again();
	return { source, target, first, switchConfig, again };
}

describe('runMigration in place: the source changes before the switch (finding 4)', () => {
	it('a task added: stopped, nothing switched, the ids named; --resume copies it and switches', async () => {
		const { first, switchConfig, again, target } = await started(
			changingSource(inner => inner.create({ title: 'Late arrival', status: 'backlog' }))
		);

		expect(first.status).toBe('stopped');
		expect(first.failure).toMatchObject({ step: 'source-changed', message: expect.stringContaining('added: ') });
		expect(first.failure!.hint).toContain('--resume');
		expect(first.resumeCommand).toBe('resume');
		expect(first.inPlace).toMatchObject({ switched: false });
		expect(switchConfig).not.toHaveBeenCalled();
		const journalFile = path.join(target.dataDir, inPlaceJournalFileName(PROJECT_ID));
		expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toMatchObject({
			status: 'stopped',
			inPlace: { verified: false },
		});

		const second = await again({ resume: true });

		expect(second.status).toBe('completed');
		expect(second.counts).toMatchObject({ created: 1, skipped: 6 });
		expect(second.verification!.checked).toBe(7);
		expect(switchConfig).toHaveBeenCalledTimes(1);
	});

	it('a task changed: stopped again by the resume (the journal remembers the copy); --accept-differences lets it through', async () => {
		const { first, switchConfig, again } = await started(
			changingSource(async inner => {
				const [one] = await listAll(inner);
				await inner.setTitle(one!.id, 'Renamed at the last moment');
			})
		);
		expect(first.status).toBe('stopped');
		expect(first.failure!.message).toContain('changed: ');
		expect(switchConfig).not.toHaveBeenCalled();

		const resumed = await again({ resume: true });
		expect(resumed.status).toBe('stopped');
		expect(resumed.failure).toMatchObject({ step: 'source-changed' });
		expect(resumed.failure!.message).toMatch(/changed: .*\(title/);
		expect(switchConfig).not.toHaveBeenCalled();

		const accepted = await again({ resume: true, acceptDifferences: true });
		expect(accepted.status).toBe('completed');
		expect(switchConfig).toHaveBeenCalledTimes(1);
	});

	it('a task removed: stopped, and stopped again (a link of another task went with it) until --accept-differences; its copy stays', async () => {
		const { first, switchConfig, again, target } = await started(
			changingSource(async inner => {
				const summaries = await listAll(inner);
				await inner.deleteTask(summaries.find(summary => summary.title === 'Standalone')!.id);
			})
		);
		expect(first.status).toBe('stopped');
		expect(first.failure!.message).toContain('removed: ');

		const resumed = await again({ resume: true });
		expect(resumed.status).toBe('stopped');
		expect(switchConfig).not.toHaveBeenCalled();

		const second = await again({ resume: true, acceptDifferences: true });

		expect(second.status).toBe('completed');
		expect(switchConfig).toHaveBeenCalledTimes(1);
		expect((await listAll(target.endpoint.backend)).some(summary => summary.title === 'Standalone')).toBe(true);
	});

	it('a source that did not change is switched', async () => {
		const { first, switchConfig } = await started(undefined);

		expect(first.status).toBe('completed');
		expect(switchConfig).toHaveBeenCalledTimes(1);
	});
});

describe('runMigration in place: differences that can never clear (finding 5)', () => {
	async function normalising(options: Partial<MigrationOptions>) {
		const source = side({ id: PROJECT_ID });
		await seedSource(source.endpoint.backend);
		// A forge that normalises every title it shows.
		const target = side({
			id: PROJECT_ID,
			wrap: inner => reading(inner, record => ({ ...record, title: record.title.toUpperCase() })),
		});
		const switchConfig = vi.fn();
		const result = await runMigration({
			source: source.endpoint,
			target: target.endpoint,
			journalDir: target.dataDir,
			options: optionsWith({ allowLoss: ['history'], ...options }),
			resumeCommand: 'resume',
			inPlace: hooks(target, switchConfig),
		});
		return { result, switchConfig, target };
	}

	it('without the flag the stop names the flag and the risk, and nothing is switched', async () => {
		const { result, switchConfig } = await normalising({});

		expect(result.status).toBe('failed');
		expect(result.failure!.hint).toContain('--accept-differences');
		expect(result.failure!.hint).toMatch(/target keeps the text as the forge holds it/);
		expect(switchConfig).not.toHaveBeenCalled();
		expect(result.inPlace!.acceptedDifferences).toBeUndefined();
	});

	it('with the flag the switch proceeds, and the differences are in the result and in the journal', async () => {
		const { result, switchConfig, target } = await normalising({ acceptDifferences: true });

		expect(result.status).toBe('completed');
		expect(switchConfig).toHaveBeenCalledTimes(1);
		expect(result.verification!.mismatches.length).toBeGreaterThanOrEqual(6);
		expect(result.inPlace!.acceptedDifferences).toEqual(result.verification!.mismatches);
		const journal = JSON.parse(
			fs.readFileSync(path.join(target.dataDir, inPlaceJournalFileName(PROJECT_ID)), 'utf8')
		) as { status: string; inPlace: { switched: boolean; verified: boolean; acceptedDifferences: unknown[] } };
		expect(journal).toMatchObject({ status: 'completed', inPlace: { switched: true, verified: true } });
		expect(journal.inPlace.acceptedDifferences).toEqual(result.verification!.mismatches);
	});
});
