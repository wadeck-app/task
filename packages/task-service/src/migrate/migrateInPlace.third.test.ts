import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskBackend } from '@wadeck-app/task-core';

import type { ReadNotice } from '../plugins/kinds.js';
import { canonical, sha256Hex } from './canonicalJson.js';
import { MigrationRefusedError, MigrationStateError } from './migrateErrors.js';
import { recoverArchives } from './migrateJournal.js';
import { listAll } from './migratePlan.js';
import { runMigration } from './migrateRun.js';
import type { InPlaceHooks } from './migrateRun.js';
import type { MigrationOptions } from './migrateTypes.js';
import { localSide, optionsWith, seedSource } from './migrate.testkit.js';
import type { LocalSide, SideOptions } from './migrate.testkit.js';
import { contentHash, contentParts } from './sourceContent.js';

// Third review of `task migrate --in-place`, engine side: stale reads (1), unclaimed target tasks (2+3), the source identity (5),
// the archive crash window (6), the journal that cannot be saved after the switch (9), the shared hash helper (10).
const sides: LocalSide[] = [];
const temps: string[] = [];
function side(options: SideOptions): LocalSide {
	const made = localSide(options);
	sides.push(made);
	return made;
}
afterEach(() => {
	for (const made of sides.splice(0)) fs.rmSync(made.root, { recursive: true, force: true });
	for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const PROJECT_ID = 'ffff6666';
const STALE: ReadNotice = { kind: 'stale', text: 'served from the cache because the server was unreachable' };

function hooks(
	target: LocalSide,
	switchConfig: InPlaceHooks['switchConfig'],
	source: InPlaceHooks['source'] = { kind: 'local', location: 'kind:local' }
): InPlaceHooks {
	return {
		target: { hash: 'hash-1', parts: { type: 'a' }, location: 'kind:local' },
		source,
		idMapFile: path.join(target.dataDir, 'idmap.json'),
		switchConfig,
	};
}

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

async function setup(wrap?: SideOptions['wrap']) {
	const source = side({ id: PROJECT_ID, ...(wrap === undefined ? {} : { wrap }) });
	await seedSource(source.endpoint.backend);
	const target = side({ id: PROJECT_ID });
	return { source, target };
}

function run(
	made: { source: LocalSide; target: LocalSide },
	switchConfig: InPlaceHooks['switchConfig'],
	options: Partial<MigrationOptions> = {},
	extra: {
		sourceEndpoint?: LocalSide['endpoint'];
		targetEndpoint?: LocalSide['endpoint'];
		source?: InPlaceHooks['source'];
	} = {}
) {
	return runMigration({
		source: extra.sourceEndpoint ?? made.source.endpoint,
		target: extra.targetEndpoint ?? made.target.endpoint,
		journalDir: made.target.dataDir,
		options: optionsWith({ allowLoss: ['history'], ...options }),
		resumeCommand: 'resume',
		inPlace: hooks(made.target, switchConfig, extra.source),
	});
}

const journalFileOf = (target: LocalSide): string =>
	path.join(target.dataDir, `migrate-journal-${PROJECT_ID}-inplace.json`);

describe('item 1: a read answered from a cache is never trusted before the switch', () => {
	it('a stale notice on the target during the read-back: stopped, step stale-read, no switch', async () => {
		const made = await setup();
		const switchConfig = vi.fn();
		const staleTarget = { ...made.target.endpoint, takeNotices: () => [STALE] };

		const result = await run(made, switchConfig, {}, { targetEndpoint: staleTarget });

		expect(result.status).toBe('stopped');
		expect(result.failure).toMatchObject({ step: 'stale-read' });
		expect(result.failure!.message).toMatch(/cache/);
		expect(result.failure!.hint).toMatch(/retry|reachable/i);
		expect(switchConfig).not.toHaveBeenCalled();
	});

	it('a stale notice on the source during the re-check: stopped, no switch', async () => {
		const made = await setup();
		const switchConfig = vi.fn();
		// The plan refuses a source read from a cache; the re-check before the switch is the one under test: it answers stale only then.
		let calls = 0;
		const staleSource = { ...made.source.endpoint, takeNotices: () => (++calls > 1 ? [STALE] : []) };

		const result = await run(made, switchConfig, {}, { sourceEndpoint: staleSource });

		expect(result.status).toBe('stopped');
		expect(result.failure).toMatchObject({ step: 'stale-read' });
		expect(switchConfig).not.toHaveBeenCalled();
	});

	it('another notice (ignored, emulated) is a warning, not a stop', async () => {
		const made = await setup();
		const switchConfig = vi.fn();
		const other = {
			...made.target.endpoint,
			takeNotices: () => [{ kind: 'ignored' as const, text: 'something ignored' }],
		};

		const result = await run(made, switchConfig, {}, { targetEndpoint: other });

		expect(result.status).toBe('completed');
		expect(result.warnings.join(' ')).toContain('something ignored');
	});
});

describe('items 2+3: tasks on the target that nothing claims are a blocker', () => {
	async function withForeignTask() {
		const made = await setup();
		await made.target.endpoint.backend.create({ title: 'Already here', status: 'backlog' });
		return made;
	}

	it('a real run refuses before any write: the count, the ids, the hint and the flag', async () => {
		const made = await withForeignTask();
		const switchConfig = vi.fn();

		const error = await run(made, switchConfig).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toMatch(/1 task/);
		expect((error as MigrationRefusedError).hint).toContain('--allow-non-empty-target');
		expect(await listAll(made.target.endpoint.backend)).toHaveLength(1);
		expect(fs.existsSync(journalFileOf(made.target))).toBe(false);
		expect(switchConfig).not.toHaveBeenCalled();
	});

	it('a dry run reports it as a blocker and writes nothing', async () => {
		const made = await withForeignTask();

		const result = await run(made, vi.fn(), { dryRun: true });

		expect(result.targetNotEmpty).toMatchObject({ count: 1 });
		expect(result.targetNotEmpty!.hint).toContain('--allow-non-empty-target');
		expect(await listAll(made.target.endpoint.backend)).toHaveLength(1);
	});

	it('--allow-non-empty-target goes on and is recorded in the journal; a resume does not need it again', async () => {
		const made = await setup(changingSource(inner => inner.create({ title: 'Late arrival', status: 'backlog' })));
		await made.target.endpoint.backend.create({ title: 'Already here', status: 'backlog' });
		const switchConfig = vi.fn();

		const first = await run(made, switchConfig, { allowNonEmptyTarget: true });
		expect(first.status).toBe('stopped');
		const journal = JSON.parse(fs.readFileSync(journalFileOf(made.target), 'utf8')) as {
			inPlace: { acceptedForeignIds?: string[] };
		};
		expect(journal.inPlace.acceptedForeignIds).toHaveLength(1);

		const resumed = await run(made, switchConfig, { resume: true });
		expect(resumed.status).toBe('completed');
		expect(switchConfig).toHaveBeenCalledTimes(1);
	});

	it('what the journal claims is not foreign: a resume with a valid journal is unaffected', async () => {
		const made = await setup(changingSource(inner => inner.create({ title: 'Late arrival', status: 'backlog' })));
		const switchConfig = vi.fn();
		const first = await run(made, switchConfig);
		expect(first.status).toBe('stopped');

		const resumed = await run(made, switchConfig, { resume: true });

		expect(resumed.status).toBe('completed');
	});
});

describe('item 5: the source storage is part of the journal', () => {
	it('a resume with a source that is somewhere else is refused, naming both', async () => {
		const made = await setup(changingSource(inner => inner.create({ title: 'Late arrival', status: 'backlog' })));
		const first = await run(made, vi.fn(), {}, { source: { kind: 'local', location: 'kind:local' } });
		expect(first.status).toBe('stopped');

		const error = await run(
			made,
			vi.fn(),
			{ resume: true },
			{ source: { kind: 'github', location: 'github https://api.github.com acme/other' } }
		).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toMatch(/source/);
		expect((error as Error).message).toContain('acme/other');
		expect((error as MigrationRefusedError).hint).toMatch(/config\.yml/);
	});
});

describe('item 6: an archive that crashed halfway is completed at the start of the next run', () => {
	function pair() {
		const dir = fs.mkdtempSync(path.join(process.env['TEMP'] ?? '/tmp', 'task-service-open-'));
		temps.push(dir);
		return {
			dir,
			journal: path.join(dir, 'migrate-journal-x-inplace.json'),
			idMap: path.join(dir, 'migrate-idmap-x.json'),
		};
	}
	const STAMP = '2026-11-15T10-00-00-000Z';

	it('both temp names are renamed to the archived names, content kept, and reported', () => {
		const { dir, journal, idMap } = pair();
		fs.writeFileSync(`${journal}.archiving-${STAMP}`, 'J');
		fs.writeFileSync(`${idMap}.archiving-${STAMP}`, 'M');

		const done = recoverArchives([journal, idMap]);

		expect(done).toHaveLength(2);
		expect(fs.readFileSync(path.join(dir, `migrate-journal-x-inplace.archived-${STAMP}.json`), 'utf8')).toBe('J');
		expect(fs.readFileSync(path.join(dir, `migrate-idmap-x.archived-${STAMP}.json`), 'utf8')).toBe('M');
		expect(fs.readdirSync(dir).filter(name => name.includes('.archiving-'))).toEqual([]);
	});

	it('a pair half moved: the file that stayed is archived with the same stamp', () => {
		const { dir, journal, idMap } = pair();
		fs.writeFileSync(`${journal}.archiving-${STAMP}`, 'J');
		fs.writeFileSync(idMap, 'M');

		recoverArchives([journal, idMap]);

		expect(fs.existsSync(idMap)).toBe(false);
		expect(fs.readFileSync(path.join(dir, `migrate-idmap-x.archived-${STAMP}.json`), 'utf8')).toBe('M');
	});

	it('nothing stray: nothing done', () => {
		const { journal, idMap } = pair();
		fs.writeFileSync(journal, 'J');

		expect(recoverArchives([journal, idMap])).toEqual([]);
		expect(fs.readFileSync(journal, 'utf8')).toBe('J');
	});

	it('an archived name that already exists is an error naming it, nothing overwritten', () => {
		const { dir, journal, idMap } = pair();
		fs.writeFileSync(`${journal}.archiving-${STAMP}`, 'J');
		fs.writeFileSync(path.join(dir, `migrate-journal-x-inplace.archived-${STAMP}.json`), 'OLD');

		expect(() => recoverArchives([journal, idMap])).toThrow(MigrationStateError);
		expect(fs.readFileSync(path.join(dir, `migrate-journal-x-inplace.archived-${STAMP}.json`), 'utf8')).toBe('OLD');
	});
});

describe('item 9: the journal cannot be saved after the config was replaced', () => {
	it('the answer says switched, tells how to finish, defers the event to the resume and flags the bookkeeping', async () => {
		const made = await setup();
		const journalFile = journalFileOf(made.target);
		// After the config is replaced, the journal path becomes a folder: the next atomic write cannot rename over it.
		const switchConfig = (): void => {
			fs.rmSync(journalFile);
			fs.mkdirSync(journalFile);
		};

		const result = await run(made, switchConfig);

		expect(result.inPlace).toMatchObject({ switched: true, bookkeepingPending: true });
		expect(result.warnings.join(' ')).toMatch(
			/switched but the journal could not be saved: run the same command with --resume/
		);
		expect(result.events).toEqual([]);
		expect(result.warnings.join(' ')).toMatch(/summary event/);
	});

	it('a journal that cannot be saved BEFORE the switch is still an ordinary failure', async () => {
		const made = await setup();
		const result = await run(made, () => {
			throw new Error('disk full');
		});

		expect(result.status).toBe('failed');
		expect(result.inPlace?.switched).toBe(false);
		expect(result.inPlace?.bookkeepingPending).toBeUndefined();
	});
});

describe('item 10: one hash helper', () => {
	it('canonical + sha256Hex keep their exact output (golden)', () => {
		const text = canonical({ n: null, b: [2, 1], a: 'x' });
		expect(text).toBe('{"a":"x","b":[2,1],"n":null}');
		expect(sha256Hex(text)).toBe('e934b32dafafda2b6f37fd9b982156d4f9bb1f0b1bd733a29a25c561dd42acc2');
	});

	it('the content hash of a fixed record is unchanged (golden)', () => {
		const record = {
			id: 'a',
			title: 'T',
			status: 'backlog',
			labels: ['b', 'a'],
			meta: { k: 'v' },
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			history: [],
		} as unknown as Parameters<typeof contentParts>[0];

		expect(contentHash(contentParts(record))).toBe('61be8dcaf3fe');
	});
});
