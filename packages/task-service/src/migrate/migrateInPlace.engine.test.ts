import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MigrationRefusedError } from './migrateErrors.js';
import { inPlaceJournalFileName } from './migrateJournal.js';
import { runMigration } from './migrateRun.js';
import type { InPlaceHooks } from './migrateRun.js';
import { localSide, optionsWith, reading, seedSource } from './migrate.testkit.js';
import type { LocalSide, SideOptions } from './migrate.testkit.js';

// Every atomic write of the SDK is recorded (and done), to look at the id map as the run goes.
const atomicWrites = vi.hoisted(() => [] as Array<{ file: string; content: string }>);
vi.mock('@wadeck-app/project-sdk', async importOriginal => {
	const actual = await importOriginal<typeof import('@wadeck-app/project-sdk')>();
	return {
		...actual,
		writeFileAtomic: (file: string, content: string): void => {
			atomicWrites.push({ file, content });
			actual.writeFileAtomic(file, content);
		},
	};
});

// The engine side of --in-place: the same project on both sides, the switch last, the id map written as the run goes.
const sides: LocalSide[] = [];
function side(options: SideOptions): LocalSide {
	const made = localSide(options);
	sides.push(made);
	return made;
}
afterEach(() => {
	for (const made of sides.splice(0)) fs.rmSync(made.root, { recursive: true, force: true });
	atomicWrites.length = 0;
});

const PROJECT_ID = 'cccc3333';

function hooks(target: LocalSide, switchConfig: InPlaceHooks['switchConfig']): InPlaceHooks {
	return {
		target: { hash: 'hash-1', parts: { type: 'a' }, location: 'kind:local' },
		idMapFile: path.join(target.dataDir, 'idmap.json'),
		switchConfig,
	};
}

describe('runMigration in place', () => {
	it('does not switch when the read-back finds a difference, and the journal is stopped', async () => {
		const source = side({ id: PROJECT_ID });
		await seedSource(source.endpoint.backend);
		// A target that shows every title with a suffix: what was written is not what is read back.
		const target = side({
			id: PROJECT_ID,
			wrap: inner => reading(inner, record => ({ ...record, title: `${record.title}!` })),
		});
		const switchConfig = vi.fn();

		const result = await runMigration({
			source: source.endpoint,
			target: target.endpoint,
			journalDir: target.dataDir,
			options: optionsWith({ allowLoss: ['history'] }),
			resumeCommand: 'resume',
			inPlace: hooks(target, switchConfig),
		});

		expect(result.status).toBe('failed');
		expect(result.failure!.step).toBe('verify');
		expect(result.failure!.hint).toContain('NOT switched');
		expect(result.resumeCommand).toBe('resume');
		expect(result.inPlace).toMatchObject({ switched: false });
		expect(switchConfig).not.toHaveBeenCalled();
		const journal = JSON.parse(
			fs.readFileSync(path.join(target.dataDir, inPlaceJournalFileName(PROJECT_ID)), 'utf8')
		) as {
			status: string;
			inPlace: { switched: boolean };
		};
		expect(journal).toMatchObject({ status: 'stopped', inPlace: { switched: false } });
	});

	it('reads back every task, not only what this run wrote, before it switches', async () => {
		const source = side({ id: PROJECT_ID });
		await seedSource(source.endpoint.backend);
		const target = side({ id: PROJECT_ID });
		const first = await runMigration({
			source: source.endpoint,
			target: target.endpoint,
			journalDir: target.dataDir,
			options: optionsWith({ allowLoss: ['history'] }),
			resumeCommand: 'resume',
			inPlace: hooks(target, () => {
				throw new Error('boom');
			}),
		});
		expect(first.failure).toMatchObject({ step: 'switch', message: 'boom' });

		const switchConfig = vi.fn();
		const second = await runMigration({
			source: source.endpoint,
			target: target.endpoint,
			journalDir: target.dataDir,
			options: optionsWith({ allowLoss: ['history'], resume: true }),
			resumeCommand: 'resume',
			inPlace: hooks(target, switchConfig),
		});

		expect(second.status).toBe('completed');
		expect(second.counts).toMatchObject({ created: 0, skipped: 6 });
		expect(second.verification!.checked).toBe(6);
		expect(switchConfig).toHaveBeenCalledTimes(1);
	});

	it('writes the id map atomically through the SDK, after every creation, in creation order', async () => {
		const source = side({ id: PROJECT_ID });
		await seedSource(source.endpoint.backend);
		const target = side({ id: PROJECT_ID });
		const idMapFile = path.join(target.dataDir, 'idmap.json');

		await runMigration({
			source: source.endpoint,
			target: target.endpoint,
			journalDir: target.dataDir,
			options: optionsWith({ allowLoss: ['history'] }),
			resumeCommand: 'resume',
			inPlace: hooks(target, () => undefined),
		});

		const sizes = atomicWrites
			.filter(write => write.file === idMapFile)
			.map(write => (JSON.parse(write.content) as unknown[]).length);
		// 0 at the start, then 1..6 as the tasks are created, then the final one before the switch.
		expect(sizes.slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 6]);
		const map = JSON.parse(fs.readFileSync(idMapFile, 'utf8')) as Array<{ from: string; to: string }>;
		expect(map).toHaveLength(6);
	});

	it('still refuses the same project without in-place', async () => {
		const source = side({ id: PROJECT_ID });
		const target = side({ id: PROJECT_ID });

		await expect(
			runMigration({
				source: source.endpoint,
				target: target.endpoint,
				journalDir: target.dataDir,
				options: optionsWith(),
				resumeCommand: 'resume',
			})
		).rejects.toThrow(MigrationRefusedError);
	});
});
