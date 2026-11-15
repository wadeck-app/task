import { BackendDataError } from '@wadeck-app/task-core';

import { RoutingIndex } from './routingIndex.js';
import type { IndexFiles, IndexRow } from './routingIndex.js';

const FILE = '/data/migrating/index.json';
const SINCE = '2026-11-15T10:00:00.000Z';

/** In-memory files: deterministic, and every write is recorded. */
function memoryFiles(initial?: string): IndexFiles & { text: string | undefined; writes: string[]; ensured: string[] } {
	const files = {
		text: initial,
		writes: [] as string[],
		ensured: [] as string[],
		read: (file: string): string | undefined => {
			expect(file).toBe(FILE);
			return files.text;
		},
		write: (file: string, content: string): void => {
			if (file !== FILE) {
				expect(file.startsWith(`${FILE}.damaged-`)).toBe(true);
				return;
			}
			files.writes.push(content);
			files.text = content;
		},
		ensureDir: (dir: string): void => {
			files.ensured.push(dir);
		},
	};
	return files;
}

function row(change: Partial<IndexRow> & Pick<IndexRow, 'publicId' | 'state'>): IndexRow {
	return { since: SINCE, version: 1, ...change };
}

function fileWith(rows: unknown, format: unknown = 1): string {
	return JSON.stringify({ format, rows });
}

async function problemOf(action: () => unknown): Promise<BackendDataError> {
	try {
		await Promise.resolve(action());
	} catch (error) {
		expect(error).toBeInstanceOf(BackendDataError);
		return error as BackendDataError;
	}
	throw new Error('the call should have failed');
}

describe('RoutingIndex: reading', () => {
	it('a missing file is an index with no row, and reading it creates nothing', () => {
		const files = memoryFiles(undefined);
		const index = new RoutingIndex({ file: FILE, files });

		const snapshot = index.snapshot();

		expect(snapshot.rows).toEqual([]);
		expect(snapshot.isTrivial).toBe(true);
		expect(files.writes).toEqual([]);
		expect(files.ensured).toEqual([]);
	});

	it('finds a row by public id, by the id in current and by the id in new', () => {
		const rows = [
			row({ publicId: 'a1', a: 'a1', state: 'in-a' }),
			row({ publicId: 'a2', a: 'a2', b: '7', state: 'moving' }),
			row({ publicId: 'n9', b: '9', state: 'in-b' }),
		];
		const index = new RoutingIndex({ file: FILE, files: memoryFiles(fileWith(rows)) });

		const snapshot = index.snapshot();

		expect(snapshot.byPublicId('a2')).toEqual(rows[1]);
		expect(snapshot.byA('a2')).toEqual(rows[1]);
		expect(snapshot.byB('9')).toEqual(rows[2]);
		expect(snapshot.byPublicId('zz')).toBeUndefined();
		expect(snapshot.byA('7')).toBeUndefined();
		expect(snapshot.byB('a2')).toBeUndefined();
	});

	it('is trivial only while no row sends a read to the new side or hides a task', () => {
		const trivial = [row({ publicId: 'a1', a: 'a1', state: 'in-a' })];
		expect(new RoutingIndex({ file: FILE, files: memoryFiles(fileWith(trivial)) }).snapshot().isTrivial).toBe(true);

		const moving = [row({ publicId: 'a1', a: 'a1', b: '1', state: 'moving' })];
		expect(new RoutingIndex({ file: FILE, files: memoryFiles(fileWith(moving)) }).snapshot().isTrivial).toBe(false);

		const deleted = [row({ publicId: 'a1', a: 'a1', state: 'deleted' })];
		expect(new RoutingIndex({ file: FILE, files: memoryFiles(fileWith(deleted)) }).snapshot().isTrivial).toBe(
			false
		);
	});

	it('sees a change made by another process between two reads', () => {
		const files = memoryFiles(fileWith([]));
		const index = new RoutingIndex({ file: FILE, files });
		expect(index.snapshot().rows).toEqual([]);

		files.text = fileWith([row({ publicId: 'n1', b: '1', state: 'in-b' })]);

		expect(index.snapshot().byPublicId('n1')?.state).toBe('in-b');
	});
});

describe('RoutingIndex: a damaged index is a loud error, never replaced', () => {
	it('names the file, what is wrong and a way out when the text is not JSON', async () => {
		const files = memoryFiles('{ not json');
		const index = new RoutingIndex({ file: FILE, files });

		const error = await problemOf(() => index.snapshot());

		expect(error.message).toContain(FILE);
		expect(error.message).toContain('not valid JSON');
		expect(error.hint).toContain('Do not delete it');
		expect(error.hint).toContain('backup');
		expect(error.subject).toBe(FILE);
	});

	it('does not rewrite the file when a change is attempted on a damaged index', async () => {
		const files = memoryFiles('{ not json');
		const index = new RoutingIndex({ file: FILE, files });

		await problemOf(() => index.mutate(rows => rows));

		expect(files.writes).toEqual([]);
		expect(files.text).toBe('{ not json');
	});

	it.each([
		['an unknown format', JSON.stringify({ format: 2, rows: [] }), 'format 2'],
		['a missing format', JSON.stringify({ rows: [] }), 'format'],
		['rows that are not a list', JSON.stringify({ format: 1, rows: {} }), 'rows'],
		['a row that is not an object', fileWith(['x']), 'row 1'],
		[
			'an unknown key in a row',
			fileWith([{ ...row({ publicId: 'a1', a: 'a1', state: 'in-a' }), extra: 1 }]),
			'extra',
		],
		['a row without a public id', fileWith([{ state: 'in-a', a: 'a1', since: SINCE, version: 1 }]), 'publicId'],
		[
			'an unknown state',
			fileWith([{ publicId: 'a1', a: 'a1', state: 'gone', since: SINCE, version: 1 }]),
			'state "gone"',
		],
		[
			'a since that is not a date',
			fileWith([row({ publicId: 'a1', a: 'a1', state: 'in-a', since: 'yesterday' })]),
			'since',
		],
		[
			'a version that is not a positive whole number',
			fileWith([row({ publicId: 'a1', a: 'a1', state: 'in-a', version: 0 })]),
			'version',
		],
		['an in-a row without the id in current', fileWith([row({ publicId: 'a1', state: 'in-a' })]), 'in-a'],
		['an in-a row with a copy in new', fileWith([row({ publicId: 'a1', a: 'a1', b: '1', state: 'in-a' })]), 'in-a'],
		[
			'a moving row without the copy in new',
			fileWith([row({ publicId: 'a1', a: 'a1', state: 'moving' })]),
			'moving',
		],
		['an in-b row without the id in new', fileWith([row({ publicId: 'a1', a: 'a1', state: 'in-b' })]), 'in-b'],
		[
			'a public id that is not the id in current',
			fileWith([row({ publicId: 'x', a: 'a1', state: 'in-a' })]),
			'publicId "x"',
		],
		[
			'two rows with the same public id',
			fileWith([row({ publicId: 'n1', b: '1', state: 'in-b' }), row({ publicId: 'n1', b: '2', state: 'in-b' })]),
			'twice',
		],
		[
			'two rows with the same id in new',
			fileWith([row({ publicId: 'n1', b: '1', state: 'in-b' }), row({ publicId: 'n2', b: '1', state: 'in-b' })]),
			'id "1" in "new"',
		],
		[
			'two rows with the same id in current',
			fileWith([
				row({ publicId: 'a1', a: 'a1', state: 'in-a' }),
				row({ publicId: 'a1', a: 'a1', state: 'in-a' }),
			]),
			'twice',
		],
	])('refuses %s, naming the file and the row', async (_name, text, expected) => {
		const index = new RoutingIndex({ file: FILE, files: memoryFiles(text) });

		const error = await problemOf(() => index.snapshot());

		expect(error.message).toContain(FILE);
		expect(error.message).toContain(expected);
		expect(error.hint.length).toBeGreaterThan(20);
	});
});

describe('RoutingIndex: changing it', () => {
	it('writes the whole file atomically in one call, creating its folder first, and returns the new snapshot', () => {
		const files = memoryFiles(undefined);
		const index = new RoutingIndex({ file: FILE, files });

		const snapshot = index.mutate(() => [row({ publicId: 'n1', b: '1', state: 'in-b' })]);

		expect(files.ensured).toEqual(['/data/migrating']);
		expect(files.writes).toHaveLength(1);
		expect(JSON.parse(files.writes[0]!)).toEqual({
			format: 1,
			rows: [{ publicId: 'n1', b: '1', state: 'in-b', since: SINCE, version: 1 }],
		});
		expect(snapshot.byPublicId('n1')?.b).toBe('1');
		expect(index.snapshot().byB('1')?.publicId).toBe('n1');
	});

	it('hands the rows as they are on disk NOW to the change, inside the lock', () => {
		const order: string[] = [];
		const files = memoryFiles(fileWith([row({ publicId: 'a1', a: 'a1', state: 'in-a' })]));
		const lock = {
			run: <T>(operation: () => T): T => {
				order.push('lock');
				try {
					return operation();
				} finally {
					order.push('unlock');
				}
			},
		};
		const index = new RoutingIndex({ file: FILE, files, lock });
		// Another process adds a row after this one read the file for the first time.
		index.snapshot();
		files.text = fileWith([
			row({ publicId: 'a1', a: 'a1', state: 'in-a' }),
			row({ publicId: 'n2', b: '2', state: 'in-b' }),
		]);

		index.mutate(rows => {
			order.push(`sees ${rows.map(r => r.publicId).join(',')}`);
			return rows;
		});

		expect(order).toEqual(['lock', 'sees a1,n2', 'unlock']);
	});

	it('refuses rows that break the rules and writes nothing', async () => {
		const files = memoryFiles(undefined);
		const index = new RoutingIndex({ file: FILE, files });

		const error = await problemOf(() => index.mutate(() => [row({ publicId: 'a1', state: 'in-a' })]));

		expect(error.message).toContain('in-a');
		expect(files.writes).toEqual([]);
	});

	it('lets a failing write through, keeps what was there and writes nothing else', async () => {
		const files = memoryFiles(fileWith([row({ publicId: 'a1', a: 'a1', state: 'in-a' })]));
		const failing = {
			...files,
			write: (): void => {
				throw new Error('disk full');
			},
		};
		const index = new RoutingIndex({ file: FILE, files: failing });

		await expect(
			Promise.resolve().then(() => index.mutate(() => [row({ publicId: 'n1', b: '1', state: 'in-b' })]))
		).rejects.toThrow('disk full');

		expect(index.snapshot().rows.map(r => r.publicId)).toEqual(['a1']);
	});

	it('releases the lock when the change throws', () => {
		const order: string[] = [];
		const lock = {
			run: <T>(operation: () => T): T => {
				order.push('lock');
				try {
					return operation();
				} finally {
					order.push('unlock');
				}
			},
		};
		const index = new RoutingIndex({ file: FILE, files: memoryFiles(undefined), lock });

		expect(() =>
			index.mutate(() => {
				throw new Error('boom');
			})
		).toThrow('boom');

		expect(order).toEqual(['lock', 'unlock']);
	});
});

describe('RoutingIndex: replacing it from a rebuild', () => {
	const rows = [row({ publicId: 'n1', b: '1', state: 'in-b' })];

	it('replaces a healthy index or none, setting nothing aside', () => {
		const files = memoryFiles(fileWith([row({ publicId: 'a1', a: 'a1', state: 'in-a' })]));
		const index = new RoutingIndex({ file: FILE, files });

		const result = index.replaceFromRebuild(rows, '2026-11-16T08:00:00.000Z');

		expect(result.setAside).toBeUndefined();
		expect(files.writes).toHaveLength(1);
		expect(index.snapshot().rows).toEqual(rows);
	});

	it('keeps a damaged file under a name with the instant, byte for byte, BEFORE writing the new one', () => {
		const files = memoryFiles('{ broken');
		const written: string[] = [];
		const index = new RoutingIndex({
			file: FILE,
			files: {
				...files,
				write: (file: string, content: string) => {
					written.push(file);
					files.write(file, content);
				},
			},
		});

		const result = index.replaceFromRebuild(rows, '2026-11-16T08:00:00.000Z');

		expect(result.setAside).toBe(`${FILE}.damaged-2026-11-16T08-00-00.000Z`);
		expect(written).toEqual([`${FILE}.damaged-2026-11-16T08-00-00.000Z`, FILE]);
		expect(index.snapshot().rows).toEqual(rows);
	});

	it('does not replace anything when the rows break the rules, even from a damaged file', async () => {
		const files = memoryFiles('{ broken');
		const index = new RoutingIndex({ file: FILE, files });

		await problemOf(() => index.replaceFromRebuild([row({ publicId: 'a1', state: 'in-a' })], SINCE));

		expect(files.text).toBe('{ broken');
		expect(files.writes).toEqual([]);
	});
});

describe('RoutingIndex: the stale flag of a moving row (phase P2)', () => {
	it('keeps `stale: true` on a moving row through a write and a read', () => {
		const files = memoryFiles(undefined);
		const index = new RoutingIndex({ file: FILE, files });

		index.mutate(() => [row({ publicId: 'a1', a: 'a1', b: 'b1', state: 'moving', stale: true })]);

		expect(new RoutingIndex({ file: FILE, files }).snapshot().byPublicId('a1')?.stale).toBe(true);
	});

	it.each([
		['a row that is not moving', row({ publicId: 'a1', a: 'a1', state: 'in-a', stale: true })],
		[
			'a flag that is not a boolean',
			{ ...row({ publicId: 'a1', a: 'a1', b: 'b1', state: 'moving' }), stale: 'yes' },
		],
	])('refuses %s, naming the file and the row', async (_name, bad) => {
		const index = new RoutingIndex({ file: FILE, files: memoryFiles(undefined) });

		const error = await problemOf(() => index.mutate(() => [bad as IndexRow]));

		expect(error.message).toContain(FILE);
		expect(error.message).toContain('stale');
	});

	it('mutateRow changes one row by its public id, bumps its version and refuses a version that moved', () => {
		const index = new RoutingIndex({ file: FILE, files: memoryFiles(undefined) });
		index.mutate(() => [row({ publicId: 'a1', a: 'a1', b: 'b1', state: 'moving' })]);

		const changed = index.mutateRow('a1', { expectedVersion: 1 }, current => ({ ...current!, state: 'in-b' }));

		expect(changed.byPublicId('a1')).toMatchObject({ state: 'in-b', version: 2 });
		expect(() =>
			index.mutateRow('a1', { expectedVersion: 1 }, current => ({ ...current!, state: 'moving' }))
		).toThrow(/version/);
	});

	it('mutateRow can create a row (no expected version) and fails loudly on a task it does not know', () => {
		const index = new RoutingIndex({ file: FILE, files: memoryFiles(undefined) });

		const created = index.mutateRow('x', {}, current => current ?? row({ publicId: 'x', b: 'x', state: 'in-b' }));

		expect(created.byPublicId('x')?.version).toBe(1);
		expect(() => index.mutateRow('nope', { mustExist: true }, current => current!)).toThrow(/nope/);
	});
});

describe('RoutingIndex: the losses accepted when a task was copied (phase P2)', () => {
	it('keeps the list on a moving row through a write and a read', () => {
		const files = memoryFiles(undefined);
		new RoutingIndex({ file: FILE, files }).mutate(() => [
			row({ publicId: 'a1', a: 'a1', b: 'b1', state: 'moving', accepted: ['created-at', 'history'] }),
		]);

		expect(new RoutingIndex({ file: FILE, files }).snapshot().byPublicId('a1')?.accepted).toEqual([
			'created-at',
			'history',
		]);
	});

	it.each([
		['on a row that is not moving', row({ publicId: 'a1', a: 'a1', state: 'in-a', accepted: ['all'] })],
		[
			'that is not a list of texts',
			{ ...row({ publicId: 'a1', a: 'a1', b: 'b1', state: 'moving' }), accepted: [1] },
		],
	])('refuses a list %s, naming the file and the key', async (_name, bad) => {
		const index = new RoutingIndex({ file: FILE, files: memoryFiles(undefined) });

		const error = await problemOf(() => index.mutate(() => [bad as IndexRow]));

		expect(error.message).toContain(FILE);
		expect(error.message).toContain('accepted');
	});
});
