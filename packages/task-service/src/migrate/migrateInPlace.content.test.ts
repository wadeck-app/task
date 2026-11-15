import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskBackend } from '@wadeck-app/task-core';

import { acquireLock, archiveFiles } from './migrateJournal.js';
import { listAll } from './migratePlan.js';
import { runMigration } from './migrateRun.js';
import type { InPlaceHooks } from './migrateRun.js';
import type { MigrationOptions } from './migrateTypes.js';
import { localSide, optionsWith, seedSource } from './migrate.testkit.js';
import type { LocalSide, SideOptions } from './migrate.testkit.js';

// Second review, engine side: the deep source re-check (item 1), the archive as a pair (item 2), the lock owner (item 8).
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

const PROJECT_ID = 'eeee5555';

function hooks(target: LocalSide, switchConfig: InPlaceHooks['switchConfig']): InPlaceHooks {
	return {
		target: { hash: 'hash-1', parts: { type: 'a' }, location: 'kind:local' },
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

async function started(wrap: SideOptions['wrap'], firstOptions: Partial<MigrationOptions> = {}) {
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
	return { source, target, switchConfig, first: await again(firstOptions), again };
}

async function firstTaskId(backend: TaskBackend, title: string): Promise<string> {
	return (await listAll(backend)).find(summary => summary.title === title)!.id;
}

describe('item 1: the source is re-read in full before the switch', () => {
	it.each([
		[
			'description',
			'description',
			async (inner: TaskBackend, id: string) => void (await inner.setDescription(id, 'Edited while it ran')),
		],
		['labels', 'labels', async (inner: TaskBackend, id: string) => void (await inner.addLabel(id, 'late-label'))],
		['meta', 'meta', async (inner: TaskBackend, id: string) => void (await inner.setMeta(id, 'late', 'value'))],
		[
			'comments',
			'comments',
			async (inner: TaskBackend, id: string) => void (await inner.addComment(id, 'A late comment')),
		],
		['type', 'type', async (inner: TaskBackend, id: string) => void (await inner.setType(id, 'bug'))],
	])(
		'%s edited during the run: stopped, the task and the part named, nothing switched',
		async (_name, part, edit) => {
			const { first, switchConfig, source } = await started(
				changingSource(async inner => edit(inner, await firstTaskId(inner, 'Standalone')))
			);

			expect(first.status).toBe('stopped');
			expect(first.failure).toMatchObject({ step: 'source-changed' });
			const standalone = await firstTaskId(source.endpoint.backend, 'Standalone');
			expect(first.failure!.message).toMatch(new RegExp(`changed: ${standalone} \\(${part}`));
			expect(switchConfig).not.toHaveBeenCalled();
		}
	);

	it('the hint does not promise what the resume cannot do: changed tasks are re-migrated by hand or accepted', async () => {
		const { first } = await started(
			changingSource(async inner => void (await inner.addComment(await firstTaskId(inner, 'Standalone'), 'late')))
		);

		expect(first.failure!.hint).toMatch(/--resume copies the tasks that were added/);
		expect(first.failure!.hint).toMatch(/never overwritten/);
		expect(first.failure!.hint).toContain('--accept-differences');
		expect(first.failure!.hint).not.toMatch(/shows up as a read-back difference/);
	});

	it('a changed task keeps stopping the next runs (the journal remembers what was migrated); --accept-differences switches and records it', async () => {
		const { first, again, switchConfig } = await started(
			changingSource(async inner => void (await inner.addComment(await firstTaskId(inner, 'Standalone'), 'late')))
		);
		expect(first.status).toBe('stopped');

		const resumed = await again({ resume: true });
		expect(resumed.status).toBe('stopped');
		expect(resumed.failure!.message).toContain('changed: ');
		expect(switchConfig).not.toHaveBeenCalled();

		const accepted = await again({ resume: true, acceptDifferences: true });
		expect(accepted.status).toBe('completed');
		expect(switchConfig).toHaveBeenCalledTimes(1);
		expect(accepted.inPlace!.acceptedDifferences).toEqual([
			expect.objectContaining({ field: 'source-changed: comments' }),
		]);
	});

	it('a task ADDED is never accepted, even with the flag (it would be lost): --resume copies it', async () => {
		const { first, again, switchConfig } = await started(
			changingSource(inner => inner.create({ title: 'Late arrival', status: 'backlog' })),
			{ acceptDifferences: true }
		);

		expect(first.status).toBe('stopped');
		expect(first.failure!.message).toContain('added: ');
		expect(switchConfig).not.toHaveBeenCalled();

		const resumed = await again({ resume: true });
		expect(resumed.status).toBe('completed');
		expect(resumed.counts).toMatchObject({ created: 1 });
	});
});

describe('item 2: archiving a pair of files is all or nothing', () => {
	function files(): { dir: string; journal: string; idMap: string } {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
		temps.push(dir);
		const journal = path.join(dir, 'migrate-journal-x-inplace.json');
		const idMap = path.join(dir, 'migrate-idmap-x.json');
		fs.writeFileSync(journal, 'J');
		fs.writeFileSync(idMap, 'M');
		return { dir, journal, idMap };
	}

	it('renames both under the archived names, content untouched', () => {
		const { dir, journal, idMap } = files();

		const moved = archiveFiles([journal, idMap], '2026-11-15T10:00:00.000Z');

		expect(moved).toHaveLength(2);
		expect(fs.existsSync(journal) || fs.existsSync(idMap)).toBe(false);
		expect(moved.map(file => fs.readFileSync(file, 'utf8'))).toEqual(['J', 'M']);
		expect(fs.readdirSync(dir).filter(name => name.includes('.archiving-'))).toEqual([]);
	});

	it.each([1, 2, 3])('a rename that fails at call %i puts everything back as it was', call => {
		const { dir, journal, idMap } = files();
		let count = 0;
		const failing = (from: string, to: string): void => {
			count++;
			if (count === call) throw new Error('disk error');
			fs.renameSync(from, to);
		};

		expect(() => archiveFiles([journal, idMap], '2026-11-15T10:00:00.000Z', failing)).toThrow(/disk error|archive/);

		expect(fs.readFileSync(journal, 'utf8')).toBe('J');
		expect(fs.readFileSync(idMap, 'utf8')).toBe('M');
		expect(fs.readdirSync(dir).sort()).toEqual(['migrate-idmap-x.json', 'migrate-journal-x-inplace.json']);
	});
});

describe('item 8: the engine never releases a lock it did not take', () => {
	it('a lock held by the caller is still there when the run is over', async () => {
		const source = side({ id: PROJECT_ID });
		await seedSource(source.endpoint.backend);
		const target = side({ id: PROJECT_ID });
		const lock = acquireLock(target.dataDir, {
			pid: process.pid,
			startedAt: 'now',
			from: PROJECT_ID,
			to: PROJECT_ID,
		});

		const result = await runMigration({
			source: source.endpoint,
			target: target.endpoint,
			journalDir: target.dataDir,
			options: optionsWith({ allowLoss: ['history'] }),
			resumeCommand: 'resume',
			heldLock: lock,
			inPlace: hooks(target, () => undefined),
		});

		expect(result.status).toBe('completed');
		expect(fs.existsSync(lock.file)).toBe(true);
		expect(lock.release()).toBeUndefined();
		expect(fs.existsSync(lock.file)).toBe(false);
	});
});
