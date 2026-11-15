import * as path from 'node:path';

import { BackendDataError } from '@wadeck-app/task-core';

import { MigrationJournal } from './migrationJournal.js';
import type { WalFiles } from './migrationJournal.js';

const DIR = '/data/migrating';
const WAL = path.join(DIR, 'wal.ndjson');
const LOG = path.join(DIR, 'log.ndjson');

/** Files in memory; `failAppend` makes the named file refuse the appends. */
function memoryWal(): WalFiles & { texts: Map<string, string>; failAppend: Set<string>; replaced: string[] } {
	const files = {
		texts: new Map<string, string>(),
		failAppend: new Set<string>(),
		replaced: [] as string[],
		append(file: string, text: string): void {
			if (files.failAppend.has(file)) throw new Error(`disk full (${file})`);
			files.texts.set(file, (files.texts.get(file) ?? '') + text);
		},
		read: (file: string): string | undefined => files.texts.get(file),
		ensureDir: (): void => undefined,
		replace(file: string, text: string): void {
			files.replaced.push(file);
			files.texts.set(file, text);
		},
	};
	return files;
}

function open(files = memoryWal(), problems: string[] = []) {
	let tick = 0;
	let tx = 0;
	const journal = new MigrationJournal({
		dir: DIR,
		files,
		now: () => new Date(Date.UTC(2026, 10, 16, 8, 0, tick++)).toISOString(),
		newTx: () => `tx${++tx}`,
		onLogProblem: text => problems.push(text),
	});
	return { journal, files, problems };
}

const lines = (text: string | undefined): Array<Record<string, unknown>> =>
	(text ?? '')
		.split('\n')
		.filter(line => line !== '')
		.map(line => JSON.parse(line) as Record<string, unknown>);

describe('MigrationJournal: the write-ahead log and the log of a migration', () => {
	it('writes the begin, every step and the end to the write-ahead log, one JSON line each, numbered', () => {
		const { journal, files } = open();

		const tx = journal.begin('move', '12', { from: 'current' });
		tx.step('copy', 'new', 'intent');
		tx.step('copy', 'new', 'done', { b: '77' });
		tx.end('ok');

		const wal = lines(files.texts.get(WAL));
		expect(
			wal.map(entry => [entry['seq'], entry['event'], entry['step'], entry['phase'], entry['outcome']])
		).toEqual([
			[1, 'begin', undefined, undefined, undefined],
			[2, 'step', 'copy', 'intent', undefined],
			[3, 'step', 'copy', 'done', undefined],
			[4, 'end', undefined, undefined, 'ok'],
		]);
		expect(wal.every(entry => entry['tx'] === 'tx1' && entry['task'] === '12' && entry['op'] === 'move')).toBe(
			true
		);
		expect(wal[2]?.['data']).toEqual({ b: '77' });
		expect(typeof wal[0]?.['at']).toBe('string');
	});

	it('writes the same transitions to the human log with a sentence, and the error text of a failed step', () => {
		const { journal, files } = open();

		const tx = journal.begin('write', '12');
		tx.step('mirror', 'new', 'failed', undefined, new Error('boom: the server said no'));
		tx.end('ok');

		const log = lines(files.texts.get(LOG));
		expect(log).toHaveLength(3);
		expect(log[1]).toMatchObject({ level: 'warn', task: '12', step: 'mirror', side: 'new', phase: 'failed' });
		expect(log[1]?.['error']).toBe('boom: the server said no');
		expect(String(log[1]?.['message'])).toContain('mirror');
		expect(String(log[1]?.['message'])).toContain('12');
	});

	it('logs a note that is not a step (a recovery, a skipped task) to the human log only', () => {
		const { journal, files } = open();

		journal.info('warn', 'task 12 skipped: it is claimed', { task: '12', op: 'move', outcome: 'skipped-claimed' });

		expect(files.texts.get(WAL)).toBeUndefined();
		expect(lines(files.texts.get(LOG))[0]).toMatchObject({
			level: 'warn',
			task: '12',
			outcome: 'skipped-claimed',
			message: 'task 12 skipped: it is claimed',
		});
	});

	it('refuses to go on when the write-ahead log cannot be written: nothing may be applied that was not logged first', () => {
		const { journal, files } = open();
		files.failAppend.add(WAL);

		let thrown: unknown;
		try {
			journal.begin('move', '12');
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(BackendDataError);
		expect((thrown as BackendDataError).message).toContain('disk full');
		expect((thrown as BackendDataError).message).toContain('wal.ndjson');
		expect((thrown as BackendDataError).hint).toContain('Nothing was changed');
	});

	it('does not fail an operation because the human log cannot be written: it reports the problem and goes on', () => {
		const problems: string[] = [];
		const { journal, files } = open(undefined, problems);
		files.failAppend.add(LOG);

		const tx = journal.begin('write', '12');
		tx.step('apply', 'current', 'done');
		tx.end('ok');

		expect(lines(files.texts.get(WAL))).toHaveLength(3);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toContain('log.ndjson');
	});

	describe('reading it back', () => {
		it('lists the transactions that began and did not end, with their steps, oldest first', () => {
			const files = memoryWal();
			const { journal } = open(files);
			journal.begin('write', '1').end('ok');
			const interrupted = journal.begin('move', '2');
			interrupted.step('copy', 'new', 'intent');
			interrupted.step('copy', 'new', 'done', { b: '9' });
			journal.begin('delete', '3');

			const unfinished = open(files).journal.openTransactions();

			expect(unfinished.map(tx => [tx.op, tx.task])).toEqual([
				['move', '2'],
				['delete', '3'],
			]);
			expect(unfinished[0]?.steps.map(step => [step.step, step.phase])).toEqual([
				['copy', 'intent'],
				['copy', 'done'],
			]);
			expect(unfinished[0]?.done('copy')?.data).toEqual({ b: '9' });
			expect(unfinished[0]?.attempted('copy')).toBe(true);
			expect(unfinished[0]?.done('switch')).toBeUndefined();
			expect(unfinished[0]?.attempted('switch')).toBe(false);
		});

		it('keeps numbering where the last process stopped', () => {
			const files = memoryWal();
			open(files).journal.begin('move', '2');

			open(files).journal.begin('move', '3');

			expect(lines(files.texts.get(WAL)).map(entry => entry['seq'])).toEqual([1, 2]);
		});

		it('ignores a torn last line (a crash in the middle of an append) and says so', () => {
			const files = memoryWal();
			open(files).journal.begin('move', '2');
			files.texts.set(WAL, `${files.texts.get(WAL) ?? ''}{"seq":2,"at":"2026-11`);
			const problems: string[] = [];

			const unfinished = open(files, problems).journal.openTransactions();

			expect(unfinished.map(tx => tx.task)).toEqual(['2']);
			expect(problems.join('\n')).toContain('torn');
		});

		it('is a loud error naming the file and the line for a damaged line that is not the last', () => {
			const files = memoryWal();
			files.texts.set(
				WAL,
				'{"seq":1,"at":"x","tx":"t","task":"1","op":"move","event":"begin"}\nnot json\n{"seq":3}\n'
			);

			let thrown: unknown;
			try {
				open(files).journal.openTransactions();
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(BackendDataError);
			expect((thrown as BackendDataError).message).toContain('wal.ndjson');
			expect((thrown as BackendDataError).message).toContain('line 2');
			expect((thrown as BackendDataError).hint).toContain('Do not delete');
		});
	});

	describe('compaction', () => {
		it('empties the write-ahead log when nothing is open, atomically, and keeps the human log', () => {
			const { journal, files } = open();
			journal.begin('write', '1').end('ok');

			expect(journal.compact()).toBe(true);

			expect(files.replaced).toEqual([WAL]);
			expect(files.texts.get(WAL)).toBe('');
			expect(lines(files.texts.get(LOG)).length).toBeGreaterThan(0);
		});

		it('does nothing while a transaction is open', () => {
			const { journal, files } = open();
			journal.begin('move', '1');

			expect(journal.compact()).toBe(false);
			expect(files.replaced).toEqual([]);
		});
	});
});
