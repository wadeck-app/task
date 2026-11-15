import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskBackend } from '@wadeck-app/task-core';

import type { ReadNotice } from '../plugins/kinds.js';
import { MigrationRefusedError, MigrationStateError } from './migrateErrors.js';
import { recoverArchives } from './migrateJournal.js';
import { listAll } from './migratePlan.js';
import { runMigration } from './migrateRun.js';
import type { InPlaceHooks } from './migrateRun.js';
import type { MigrationEndpoint, MigrationOptions } from './migrateTypes.js';
import { localSide, optionsWith, seedSource } from './migrate.testkit.js';
import type { LocalSide, SideOptions } from './migrate.testkit.js';

// Fourth review of `task migrate --in-place`, engine side.
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

const PROJECT_ID = 'bbbb8888';
const STALE: ReadNotice = { kind: 'stale', text: 'served from the cache because the server was unreachable' };
const STAMP = '2026-11-15T10-00-00-000Z';

function hooks(target: LocalSide, switchConfig: InPlaceHooks['switchConfig'] = () => undefined): InPlaceHooks {
	return {
		target: { hash: 'hash-1', parts: { type: 'a' }, location: 'kind:local' },
		source: { kind: 'local', location: 'kind:local' },
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

async function setup(wrap?: SideOptions['wrap'], targetOptions: Partial<SideOptions> = {}) {
	const source = side({ id: PROJECT_ID, ...(wrap === undefined ? {} : { wrap }) });
	await seedSource(source.endpoint.backend);
	const target = side({ id: PROJECT_ID, ...targetOptions });
	return { source, target };
}

function run(
	made: { source: LocalSide; target: LocalSide },
	options: Partial<MigrationOptions> = {},
	extra: { targetEndpoint?: MigrationEndpoint; hooks?: InPlaceHooks } = {}
) {
	return runMigration({
		source: made.source.endpoint,
		target: extra.targetEndpoint ?? made.target.endpoint,
		journalDir: made.target.dataDir,
		options: optionsWith({ allowLoss: ['history'], ...options }),
		resumeCommand: 'resume',
		inPlace: extra.hooks ?? hooks(made.target),
	});
}

const journalFileOf = (target: LocalSide): string =>
	path.join(target.dataDir, `migrate-journal-${PROJECT_ID}-inplace.json`);
const readJournal = (target: LocalSide): { inPlace: Record<string, unknown>; pending?: unknown } =>
	JSON.parse(fs.readFileSync(journalFileOf(target), 'utf8')) as ReturnType<typeof readJournal>;

function pair() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
	temps.push(dir);
	return {
		dir,
		journal: path.join(dir, 'migrate-journal-x-inplace.json'),
		idMap: path.join(dir, 'migrate-idmap-x.json'),
	};
}

describe('item 1: completing an interrupted archive is all or nothing', () => {
	it.each([1, 2])('a rename that fails at call %i puts everything back and stops with an actionable error', call => {
		const { dir, journal, idMap } = pair();
		fs.writeFileSync(`${journal}.archiving-${STAMP}`, 'J');
		fs.writeFileSync(`${idMap}.archiving-${STAMP}`, 'M');
		let count = 0;
		const failing = (from: string, to: string): void => {
			count++;
			if (count === call) throw new Error('disk error');
			fs.renameSync(from, to);
		};

		let thrown: unknown;
		try {
			recoverArchives([journal, idMap], failing);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(MigrationStateError);
		expect((thrown as MigrationStateError).message).toContain('disk error');
		expect((thrown as MigrationStateError).hint).toMatch(/where they were|nothing was changed/i);
		expect(fs.readdirSync(dir).sort()).toEqual([
			`migrate-idmap-x.json.archiving-${STAMP}`,
			`migrate-journal-x-inplace.json.archiving-${STAMP}`,
		]);
	});
});

describe('item 2: a folder that cannot be listed stops the run', () => {
	it('names the folder, the cause and the fix', () => {
		const { dir } = pair();
		const blocker = path.join(dir, 'not-a-folder');
		fs.writeFileSync(blocker, 'x');

		let thrown: unknown;
		try {
			recoverArchives([path.join(blocker, 'migrate-journal-x-inplace.json')]);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(MigrationStateError);
		expect((thrown as Error).message).toContain(blocker);
		expect((thrown as MigrationStateError).hint).toMatch(/permission|folder/i);
	});

	it('a folder that does not exist yet has no stray: nothing done', () => {
		const { dir } = pair();

		expect(recoverArchives([path.join(dir, 'missing', 'migrate-journal-x-inplace.json')])).toEqual([]);
	});
});

describe('item 3: the summary event is raised once', () => {
	it('a switch whose journal could not be saved defers the event to the --resume that finishes the bookkeeping', async () => {
		const made = await setup();
		const journalFile = journalFileOf(made.target);
		const switchConfig = (): void => {
			fs.rmSync(journalFile);
			fs.mkdirSync(journalFile);
		};

		const result = await run(made, {}, { hooks: hooks(made.target, switchConfig) });

		expect(result.inPlace).toMatchObject({ switched: true, bookkeepingPending: true });
		expect(result.events).toEqual([]);
		expect(result.warnings.join(' ')).toMatch(/summary event .* --resume/);
	});

	it('a completed run records that the event was raised', async () => {
		const made = await setup();

		const result = await run(made);

		expect(result.events.map(event => event.name)).toEqual(['onTasksMigrated']);
		expect(readJournal(made.target).inPlace['summaryEventRaised']).toBe(true);
	});
});

describe('item 6: the foreign tasks accepted are the ones recorded, nothing else', () => {
	async function withForeign(wrap?: SideOptions['wrap']) {
		const made = await setup(wrap);
		const foreign = await made.target.endpoint.backend.create({ title: 'Already here', status: 'backlog' });
		return { made, foreign };
	}

	it('the first run records the accepted ids; a resume needs nothing for them', async () => {
		const { made, foreign } = await withForeign(
			changingSource(inner => inner.create({ title: 'Late arrival', status: 'backlog' }))
		);

		const first = await run(made, { allowNonEmptyTarget: true });
		expect(first.status).toBe('stopped');
		expect(readJournal(made.target).inPlace['acceptedForeignIds']).toEqual([foreign.id]);

		const resumed = await run(made, { resume: true });
		expect(resumed.status).toBe('completed');
	});

	it('a foreign task that appeared since is a blocker again, and the flag then records it too', async () => {
		const { made, foreign } = await withForeign(
			changingSource(inner => inner.create({ title: 'Late arrival', status: 'backlog' }))
		);
		await run(made, { allowNonEmptyTarget: true });
		const newcomer = await made.target.endpoint.backend.create({ title: 'Appeared meanwhile', status: 'backlog' });

		const error = await run(made, { resume: true }).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toContain(newcomer.id);
		expect((error as Error).message).not.toContain(foreign.id);

		const again = await run(made, { resume: true, allowNonEmptyTarget: true });
		expect(again.status).toBe('completed');
		expect(readJournal(made.target).inPlace['acceptedForeignIds']).toEqual([foreign.id, newcomer.id]);
	});

	it('an accepted foreign task is never taken for the creation a crash left pending', async () => {
		let armed = false;
		const made = await setup(undefined, {
			traits: { keepsCreatedAt: false },
			wrap: inner =>
				new Proxy(inner, {
					get(real, property, receiver) {
						if (property !== 'create') return Reflect.get(real, property, receiver) as unknown;
						return (...args: Parameters<TaskBackend['create']>) => {
							if (armed && args[0].title === 'Epic') {
								armed = false;
								return Promise.reject(new Error('lost answer'));
							}
							return real.create(...args);
						};
					},
				}),
		});
		const foreign = await made.target.endpoint.backend.create({ title: 'Epic', status: 'backlog' });
		armed = true;
		const first = await run(made, { allowNonEmptyTarget: true, allowLoss: ['history', 'created-at'] });
		expect(first.status).toBe('failed');
		expect(readJournal(made.target).pending).toBeDefined();

		const resumed = await run(made, { resume: true, allowLoss: ['history', 'created-at'] });

		expect(resumed.status).toBe('completed');
		const titles = (await listAll(made.target.endpoint.backend)).filter(summary => summary.title === 'Epic');
		expect(titles).toHaveLength(2);
		expect(titles.some(summary => summary.id === foreign.id)).toBe(true);
	});
});

describe('item 7: a stale read at plan time stops before the first write', () => {
	it('a real run: stopped, step stale-read, nothing written, no journal', async () => {
		const made = await setup();
		const switchConfig = vi.fn();
		const staleTarget = { ...made.target.endpoint, takeNotices: () => [STALE] };

		const result = await run(made, {}, { targetEndpoint: staleTarget, hooks: hooks(made.target, switchConfig) });

		expect(result.status).toBe('stopped');
		expect(result.failure).toMatchObject({ step: 'stale-read' });
		expect(result.failure!.message).toMatch(/cache/);
		expect(await listAll(made.target.endpoint.backend)).toHaveLength(0);
		expect(fs.existsSync(journalFileOf(made.target))).toBe(false);
		expect(switchConfig).not.toHaveBeenCalled();
	});

	it('a dry run reports it as a blocker', async () => {
		const made = await setup();
		const staleTarget = { ...made.target.endpoint, takeNotices: () => [STALE] };

		const result = await run(made, { dryRun: true }, { targetEndpoint: staleTarget });

		expect(result.blocked).toBe(true);
		expect(result.blockers).toContain('stale-read');
	});
});

describe('item 8: a journal without a recorded source is refused', () => {
	it('it predates source recording: the hint says to move it aside', async () => {
		const made = await setup(changingSource(inner => inner.create({ title: 'Late arrival', status: 'backlog' })));
		const first = await run(made);
		expect(first.status).toBe('stopped');
		const journal = readJournal(made.target);
		delete journal.inPlace['source'];
		fs.writeFileSync(journalFileOf(made.target), JSON.stringify(journal));

		const error = await run(made, { resume: true }).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toMatch(/does not record|predates/);
		expect((error as MigrationRefusedError).hint).toContain(journalFileOf(made.target));
		// Not stamped with the current source.
		expect(readJournal(made.target).inPlace['source']).toBeUndefined();
	});
});

describe('item 9: the dry run says whether a real run would be refused', () => {
	it('no blocker: blocked false, no blockers', async () => {
		const made = await setup();

		const result = await run(made, { dryRun: true });

		expect(result.blocked).toBe(false);
		expect(result.blockers).toEqual([]);
	});

	it('a target that is not empty: targetNotEmpty', async () => {
		const made = await setup();
		await made.target.endpoint.backend.create({ title: 'Already here', status: 'backlog' });

		const result = await run(made, { dryRun: true });

		expect(result.blocked).toBe(true);
		expect(result.blockers).toContain('targetNotEmpty');
	});

	it('a loss that is not allowed: its kind', async () => {
		const made = await setup();

		const result = await run(made, { dryRun: true, allowLoss: [] });

		expect(result.blocked).toBe(true);
		expect(result.blockers!.length).toBeGreaterThan(0);
		expect(result.blockers).toEqual(result.blocking);
	});
});
