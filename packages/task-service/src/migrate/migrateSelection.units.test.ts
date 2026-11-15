import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LIST_LIMIT_MAX } from '../listTasks.js';
import { digestComments } from './mapTask.js';
import { MigrationStateError } from './migrateErrors.js';
import { readJournal, writeJournal } from './migrateJournal.js';
import type { Journal } from './migrateJournal.js';
import { SELECTION_LIMIT_MAX, isSelectionActive } from './migrateSelection.js';

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

describe('the selection', () => {
	it('--limit has the bound of `task list --limit`', () => {
		expect(SELECTION_LIMIT_MAX).toBe(LIST_LIMIT_MAX);
	});

	it('an empty selection is no selection: every task, as without one', () => {
		expect(isSelectionActive(undefined)).toBe(false);
		expect(isSelectionActive({})).toBe(false);
		expect(isSelectionActive({ statuses: [], ids: [] })).toBe(false);
		expect(isSelectionActive({ onlyOpen: true })).toBe(true);
		expect(isSelectionActive({ limit: 1 })).toBe(true);
	});
});

describe('digestComments', () => {
	it('one comment ends with its own marker; an unlimited target gets everything in one part', () => {
		const { comments, cut } = digestComments('p/t', ['a', 'b'], undefined);

		expect(cut).toBe(false);
		expect(comments).toEqual([{ key: 'digest-1', text: 'a\n\n---\n\nb\n\n[migrated from p/t#digest-1]' }]);
	});

	it('packs blocks in order under the limit, every part ends with its marker, and a block longer than the limit alone is cut', () => {
		const { comments, cut } = digestComments('p/t', ['x'.repeat(40), 'y'.repeat(40), 'z'.repeat(500)], 200);

		expect(comments.map(comment => comment.key)).toEqual(['digest-1', 'digest-2']);
		for (const comment of comments) {
			expect(comment.text.length).toBeLessThanOrEqual(200);
			expect(comment.text).toContain(`#${comment.key}]`);
		}
		expect(comments[0]!.text).toContain('x'.repeat(40));
		expect(comments[0]!.text).toContain('y'.repeat(40));
		expect(comments[1]!.text).toContain('cut by task migrate');
		expect(cut).toBe(true);
	});
});

describe('the journal keeps the relations a selection left for later', () => {
	function journal(): Journal {
		return {
			version: 1,
			from: { id: 'aaaa1111', name: 'a' },
			to: { id: 'bbbb2222', name: 'b' },
			startedAt: 'x',
			updatedAt: 'x',
			status: 'completed',
			tasks: {
				t1: {
					target: '1',
					phase: 'done',
					deferred: { parent: 'p1', links: [{ type: 'blockedBy', target: 't2' }] },
				},
				t2: { target: '2', phase: 'done' },
			},
		};
	}

	function fileWith(change: (value: Record<string, unknown>) => void): string {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'task-migrate-'));
		folders.push(folder);
		const file = path.join(folder, 'j.json');
		const value = JSON.parse(JSON.stringify(journal())) as Record<string, unknown>;
		change(value);
		fs.writeFileSync(file, JSON.stringify(value));
		return file;
	}

	it('round trips', () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'task-migrate-'));
		folders.push(folder);
		const file = path.join(folder, 'j.json');
		writeJournal(file, journal());

		expect(readJournal(file, { fromId: 'aaaa1111', toId: 'bbbb2222' })).toEqual(journal());
	});

	it.each<[string, unknown]>([
		['a deferred that is not an object', 'oops'],
		['a parent that is not a text', { parent: 3 }],
		['links that are not a list', { links: 'x' }],
		['a link without a target', { links: [{ type: 'blockedBy' }] }],
	])('refuses %s loudly: it is the only record of what is still to write', (_name, deferred) => {
		const file = fileWith(value => {
			(value['tasks'] as Record<string, Record<string, unknown>>)['t1']!['deferred'] = deferred;
		});

		expect(() => readJournal(file, { fromId: 'aaaa1111', toId: 'bbbb2222' })).toThrow(MigrationStateError);
	});
});
