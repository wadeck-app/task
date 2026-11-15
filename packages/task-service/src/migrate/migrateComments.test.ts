// Phase 2 of `task migrate`: how the comments are written (--comments each | digest | none). `each` is the behaviour that always was.
import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import type { TaskBackend, VersionedRecord } from '@wadeck-app/task-core';

import { MigrationRefusedError } from './migrateErrors.js';
import { listAll, readRecords } from './migratePlan.js';
import { runMigration } from './migrateRun.js';
import type { MigrationOptions, MigrationResult } from './migrateTypes.js';
import { localSide, optionsWith, reading, seedSource } from './migrate.testkit.js';
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
const ALLOW = ['history'];

function migrate(source: LocalSide, target: LocalSide, options: MigrationOptions): Promise<MigrationResult> {
	return runMigration({
		source: source.endpoint,
		target: target.endpoint,
		journalDir: target.dataDir,
		options,
		resumeCommand: 'resume',
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

async function seeded(targetOptions: Partial<SideOptions> = {}): Promise<{
	source: LocalSide;
	target: LocalSide;
	ids: Record<string, string>;
}> {
	const source = side({ id: SOURCE_ID, name: 'old-project' });
	const ids = await seedSource(source.endpoint.backend);
	const target = side({ id: TARGET_ID, name: 'new-project', ...targetOptions });
	return { source, target, ids };
}

const addComments = (side: LocalSide): string[] => side.log.writes.filter(write => write.startsWith('addComment'));

describe('--comments each (the default)', () => {
	it('is the same as not saying it: the same comments, byte for byte, one per source comment', async () => {
		const first = await seeded();
		const second = await seeded();

		await migrate(first.source, first.target, optionsWith({ allowLoss: ALLOW }));
		const explicit = await migrate(
			second.source,
			second.target,
			optionsWith({ allowLoss: ALLOW, comments: 'each' })
		);

		// Ids and instants differ between the two disposable sources; everything else must be identical.
		const textsOf = async (made: { target: LocalSide; ids: Record<string, string> }): Promise<string[]> =>
			[...(await byTitle(made.target.endpoint.backend)).values()]
				.flatMap(record => (record.comments ?? []).map(comment => comment.text))
				.map(text =>
					Object.values(made.ids)
						.reduce((out, id) => out.replaceAll(id, 'TASK'), text)
						.replace(/#[0-9a-z]{6}\]/g, '#ID]')
						.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'AT')
				)
				.sort();
		expect(await textsOf(second)).toEqual(await textsOf(first));
		expect(await textsOf(second)).toHaveLength(3);
		expect(addComments(second.target)).toHaveLength(3);
		expect(explicit.comments).toBeUndefined();
	});
});

describe('--comments none', () => {
	it('is a loss of the kind comments: blocking until allowed, naming the tasks and the saved writes', async () => {
		const { source, target, ids } = await seeded();

		const blocked = await migrate(source, target, optionsWith({ allowLoss: ALLOW, comments: 'none' }));

		expect(blocked.status).toBe('blocked');
		expect(blocked.blocking).toEqual(['comments']);
		const row = blocked.losses.find(loss => loss.kind === 'comments')!;
		expect(row.text).toContain('3 comment(s) on 2 task(s)');
		expect(row.text).toContain('--comments none');
		expect(row.taskIds.sort()).toEqual([ids['Epic']!, ids['Child one']!].sort());
		expect(row.fix).toContain('--comments');
		expect(target.log.writes).toEqual([]);
	});

	it('allowed: no comment is written, the plan says how many writes it saved, the read-back does not ask for them', async () => {
		const { source, target } = await seeded();

		const result = await migrate(
			source,
			target,
			optionsWith({ allowLoss: [...ALLOW, 'comments'], comments: 'none' })
		);

		expect(result.status).toBe('completed');
		expect(addComments(target)).toEqual([]);
		expect(result.verification!.mismatches).toEqual([]);
		expect(result.comments).toEqual({ mode: 'none', planned: 0, saved: 3 });
		expect(
			[...(await byTitle(target.endpoint.backend)).values()].every(record => (record.comments ?? []).length === 0)
		).toBe(true);
	});

	it('cannot be combined with --history-comment: the note is a comment', async () => {
		const { source, target } = await seeded();

		await expect(migrate(source, target, optionsWith({ comments: 'none', historyComment: true }))).rejects.toThrow(
			MigrationRefusedError
		);
		expect(target.log.writes).toEqual([]);
	});
});

describe('--comments digest', () => {
	it('writes ONE comment per task with all its comments in order, the author and the time of each in its header', async () => {
		const { source, target, ids } = await seeded();

		const result = await migrate(source, target, optionsWith({ allowLoss: ALLOW, comments: 'digest' }));

		expect(result.status).toBe('completed');
		expect(addComments(target)).toHaveLength(2);
		expect(result.comments).toEqual({ mode: 'digest', planned: 2, saved: 1 });
		const moved = await byTitle(target.endpoint.backend);
		const epicComments = moved.get('Epic')!.comments!;
		expect(epicComments).toHaveLength(1);
		const digest = epicComments[0]!.text;
		const original = [...(await byTitle(source.endpoint.backend)).get('Epic')!.comments!];
		expect(digest).toContain(
			`Originally posted ${original[0]!.at} by ann [migrated from ${SOURCE_ID}/${ids['Epic']}#${original[0]!.id}]`
		);
		expect(digest).toContain(
			`Originally posted ${original[1]!.at} by bob [migrated from ${SOURCE_ID}/${ids['Epic']}#${original[1]!.id}]`
		);
		expect(digest.indexOf('First note')).toBeLessThan(digest.indexOf('Second note'));
		expect(digest.trimEnd().endsWith(`[migrated from ${SOURCE_ID}/${ids['Epic']}#digest-1]`)).toBe(true);
		// The digest is written by the migrating user: the authors are in the text, not on the comment.
		expect(epicComments[0]!.author).toBeUndefined();
		expect(moved.get('Child one')!.comments).toHaveLength(1);
		expect(moved.get('Standalone')!.comments ?? []).toEqual([]);
	});

	it('is idempotent: a second run, and a run after a stop, never write a digest twice', async () => {
		const { source, target } = await seeded();
		await migrate(source, target, optionsWith({ allowLoss: ALLOW, comments: 'digest' }));
		target.log.writes.length = 0;

		const again = await migrate(source, target, optionsWith({ allowLoss: ALLOW, comments: 'digest' }));

		expect(target.log.writes).toEqual([]);
		expect(again.counts).toMatchObject({ created: 0, skipped: 6 });
	});

	it('the read-back compares the digest, not N comments: a missing digest is ONE difference', async () => {
		const source = side({ id: SOURCE_ID, name: 'old-project' });
		await seedSource(source.endpoint.backend);
		const target = side({
			id: TARGET_ID,
			name: 'new-project',
			wrap: inner => reading(inner, record => ({ ...record, comments: [] })),
		});

		const result = await migrate(source, target, optionsWith({ allowLoss: ALLOW, comments: 'digest' }));

		expect(result.verification!.mismatches.filter(item => item.field.startsWith('comment'))).toHaveLength(2);
		expect(result.verification!.mismatches.map(item => item.field)).toContain('comment digest-1');
	});

	it('splits into several comments only when the target text limit forces it, each under the limit', async () => {
		const source = side({ id: SOURCE_ID, name: 'old-project' });
		const task = await source.endpoint.backend.create({ title: 'Chatty', status: 'backlog' });
		for (let index = 1; index <= 6; index++) {
			await source.endpoint.backend.addComment(task.id, `note number ${index} ${'x'.repeat(60)}`);
		}
		const target = side({ id: TARGET_ID, name: 'new-project', traits: { commentTextMax: 400 } });

		const result = await migrate(source, target, optionsWith({ allowLoss: ALLOW, comments: 'digest' }));

		const comments = [...(await byTitle(target.endpoint.backend)).values()][0]!.comments!;
		expect(comments.length).toBeGreaterThan(1);
		expect(comments.length).toBeLessThan(6);
		for (const comment of comments) expect(comment.text.length).toBeLessThanOrEqual(400);
		const joined = comments.map(comment => comment.text).join('\n');
		for (let index = 1; index <= 6; index++) expect(joined).toContain(`note number ${index} `);
		expect(joined.indexOf('note number 1 ')).toBeLessThan(joined.indexOf('note number 6 '));
		expect(result.comments).toEqual({ mode: 'digest', planned: comments.length, saved: 6 - comments.length });
		expect(result.verification!.mismatches).toEqual([]);
	});

	it('combines the history note and the comments in ONE comment; a task with no comment keeps its note alone', async () => {
		const { source, target, ids } = await seeded();

		const result = await migrate(
			source,
			target,
			optionsWith({ allowLoss: [], comments: 'digest', historyComment: true })
		);

		expect(result.status).toBe('completed');
		const moved = await byTitle(target.endpoint.backend);
		// Epic: its two comments and the note, one comment. Standalone: no source comment, only the note.
		expect(moved.get('Epic')!.comments).toHaveLength(1);
		const text = moved.get('Epic')!.comments![0]!.text;
		expect(text).toContain('First note');
		expect(text).toContain('Second note');
		expect(text).toContain(`Migrated from ${SOURCE_ID}/${ids['Epic']} by task migrate.`);
		expect(text).toContain(`#digest-1]`);
		expect(moved.get('Standalone')!.comments).toHaveLength(1);
		expect(moved.get('Standalone')!.comments![0]!.text).toContain('#history]');
		expect(result.verification!.mismatches).toEqual([]);
	});

	it('the estimate counts the digests, fewer writes than each and than the full run', async () => {
		const { source, target } = await seeded();
		const options = optionsWith({ allowLoss: [...ALLOW, 'comments'], dryRun: true });

		const each = await migrate(source, target, options);
		const digest = await migrate(source, target, { ...options, comments: 'digest' });
		const none = await migrate(source, target, { ...options, comments: 'none' });

		expect(each.estimate.writes - digest.estimate.writes).toBe(1);
		expect(each.estimate.writes - none.estimate.writes).toBe(3);
		expect(digest.comments).toEqual({ mode: 'digest', planned: 2, saved: 1 });
	});
});

describe('--comments with an unknown mode', () => {
	it('is refused, listing the modes', async () => {
		const { source, target } = await seeded();

		await expect(migrate(source, target, optionsWith({ comments: 'weird' as never }))).rejects.toThrow(
			/each, digest, none/
		);
	});
});
