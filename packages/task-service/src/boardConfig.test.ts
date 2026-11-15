import * as fs from 'node:fs';
import * as path from 'node:path';

import { ConfigSchemaError, loadRegistry, setParent } from '@wadeck-app/project-sdk';

import { BoardConfigError, clearBoardColumns, saveBoardColumns } from './boardConfig.js';
import { describeError } from './describeError.js';
import { loadTaskConfig } from './projectConfig.js';
import { ownConfigFile, registryStorage } from './storage.js';
import type { TaskStorage } from './storage.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

// The `board` key of config.yml (decision D18): `board: { columns: [{ name, statuses: [..] }] }`, scope local, validated like
// the other sections: a ConfigSchemaError naming the FILE and the key, with a fix.

let sandbox: SharedRegistrySandbox;
beforeEach(() => {
	cached = undefined;
	sandbox = createSharedRegistrySandbox();
});
afterEach(() => {
	sandbox.cleanup();
});

const STATUSES = ['statuses:', '  - backlog', '  - in-progress', '  - name: done', '    terminal: true', ''].join('\n');

function write(file: string, yml: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, yml);
}

let cached: TaskStorage | undefined;
async function single(): Promise<TaskStorage> {
	if (cached !== undefined) return cached;
	const project = await sandbox.register('shop', sandbox.dir('shop'));
	cached = registryStorage(loadRegistry(sandbox.registryDir), sandbox.registryDir, project);
	return cached;
}

function load(storage: TaskStorage) {
	return loadTaskConfig(storage, path.join(sandbox.root, 'global'));
}

function failure(storage: TaskStorage): BoardConfigError {
	try {
		load(storage);
	} catch (error) {
		expect(error).toBeInstanceOf(BoardConfigError);
		return error as BoardConfigError;
	}
	throw new Error('expected a BoardConfigError, nothing was thrown');
}

describe('board key: valid', () => {
	it('no board key: the config has no board (one column per status is the board of the module)', async () => {
		const storage = await single();
		write(ownConfigFile(storage), STATUSES);
		expect(load(storage).board).toBeUndefined();
	});

	it('columns grouping several statuses are read as written, in order', async () => {
		const storage = await single();
		write(
			ownConfigFile(storage),
			`${STATUSES}board:\n  columns:\n    - name: To do\n      statuses: [backlog]\n    - name: Doing\n      statuses: [in-progress, done]\n`
		);
		expect(load(storage).board).toEqual({
			columns: [
				{ name: 'To do', statuses: ['backlog'] },
				{ name: 'Doing', statuses: ['in-progress', 'done'] },
			],
		});
	});

	it('a status in no column is allowed (it goes to the Unmapped column of the board)', async () => {
		const storage = await single();
		write(ownConfigFile(storage), `${STATUSES}board:\n  columns:\n    - name: Only\n      statuses: [backlog]\n`);
		expect(load(storage).board?.columns).toHaveLength(1);
	});

	it('board is local: a parent layer board never reaches the child', async () => {
		await sandbox.register('base', sandbox.dir('base'));
		const child = await sandbox.register('shop', sandbox.dir('shop'));
		await setParent(sandbox.registryDir, 'shop', 'base');
		const registry = loadRegistry(sandbox.registryDir);
		const storage = registryStorage(
			registry,
			sandbox.registryDir,
			registry.projects.find(p => p.id === child.id)!
		);
		write(
			storage.configFiles[0]!,
			'board:\n  columns:\n    - name: Parent\n      statuses: [anything-the-parent-has]\n'
		);
		// The structure is valid in its own file; the statuses are checked only against the own layer's project.
		expect(load(storage).board).toBeUndefined();
	});
});

describe('board key: errors name the FILE and the key and carry a fix', () => {
	async function bad(boardYml: string): Promise<{ error: BoardConfigError; file: string }> {
		const storage = await single();
		const file = ownConfigFile(storage);
		write(file, `${STATUSES}${boardYml}`);
		return { error: failure(storage), file };
	}

	it('is a ConfigSchemaError (invalid), key board', async () => {
		const { error, file } = await bad('board: 5\n');
		expect(error).toBeInstanceOf(ConfigSchemaError);
		expect(error.layer).toBe(file);
		expect(error.key).toBe('board');
		expect(error.hint).toEqual(expect.stringContaining('columns'));
		expect(describeError(error)).toMatchObject({ kind: 'invalid', hint: error.hint });
	});

	it('an unknown key under board', async () => {
		const { error, file } = await bad('board:\n  columns:\n    - name: A\n      statuses: [backlog]\n  lanes: 3\n');
		expect(error.message).toBe(`${file}: board.lanes: unknown key (only "columns" is allowed).`);
	});

	it('columns missing, not a list or empty', async () => {
		expect((await bad('board: {}\n')).error.message).toEqual(
			expect.stringContaining('board.columns: must be a list')
		);
		expect((await bad('board:\n  columns: x\n')).error.message).toEqual(
			expect.stringContaining('board.columns: must be a list')
		);
		expect((await bad('board:\n  columns: []\n')).error.message).toEqual(
			expect.stringContaining('board.columns: must list at least one column')
		);
	});

	it('a column that is not a mapping, or has an unknown key', async () => {
		expect((await bad('board:\n  columns: [oops]\n')).error.message).toEqual(
			expect.stringContaining('board.columns[0]: must be a mapping')
		);
		expect(
			(await bad('board:\n  columns:\n    - name: A\n      statuses: [backlog]\n      wip: 3\n')).error.message
		).toEqual(expect.stringContaining('board.columns[0].wip: unknown key'));
	});

	it('an empty or missing column name', async () => {
		const empty = await bad('board:\n  columns:\n    - name: "  "\n      statuses: [backlog]\n');
		expect(empty.error.message).toBe(
			`${empty.file}: board.columns[0].name: must not be empty. Give the column a name.`
		);
		const missing = await bad('board:\n  columns:\n    - statuses: [backlog]\n');
		expect(missing.error.message).toEqual(expect.stringContaining('board.columns[0].name: must not be empty'));
	});

	it('a name with an edge space, or longer than 50 characters', async () => {
		expect((await bad('board:\n  columns:\n    - name: " A"\n      statuses: [backlog]\n')).error.message).toEqual(
			expect.stringContaining('board.columns[0].name')
		);
		expect(
			(await bad(`board:\n  columns:\n    - name: ${'x'.repeat(51)}\n      statuses: [backlog]\n`)).error.message
		).toEqual(expect.stringContaining('at most 50 characters'));
	});

	it('duplicate column names (case-insensitive) name both columns', async () => {
		const { error, file } = await bad(
			'board:\n  columns:\n    - name: Todo\n      statuses: [backlog]\n    - name: todo\n      statuses: [done]\n'
		);
		expect(error.message).toBe(
			`${file}: board.columns[1].name: "todo" is already the name of board.columns[0]. Column names must be unique.`
		);
		expect(error.hint).toEqual(expect.stringContaining('rename'));
	});

	it('a column with no status', async () => {
		const { error, file } = await bad(
			'board:\n  columns:\n    - name: Empty\n      statuses: []\n    - name: B\n      statuses: [backlog]\n'
		);
		expect(error.message).toBe(
			`${file}: board.columns[0].statuses: column "Empty" has no status. List at least one status or delete the column.`
		);
	});

	it('a status that is not text', async () => {
		const { error } = await bad('board:\n  columns:\n    - name: A\n      statuses: [3]\n');
		expect(error.message).toEqual(expect.stringContaining('board.columns[0].statuses[0]: must be a status name'));
	});

	it('a status in two columns names both', async () => {
		const { error, file } = await bad(
			'board:\n  columns:\n    - name: A\n      statuses: [backlog]\n    - name: B\n      statuses: [done, backlog]\n'
		);
		expect(error.message).toBe(
			`${file}: board.columns[1].statuses[1]: "backlog" is already in column "A" (board.columns[0]). A status belongs to at most one column.`
		);
	});

	it('an unknown status lists the valid ones', async () => {
		const { error, file } = await bad('board:\n  columns:\n    - name: A\n      statuses: [backlog, review]\n');
		expect(error.message).toBe(
			`${file}: board.columns[0].statuses[1]: "review" is not a status of this project. Valid statuses: backlog, in-progress, done.`
		);
		expect(error.hint).toEqual(expect.stringContaining('statuses'));
	});

	it('the problem of a PARENT layer names the parent file', async () => {
		await sandbox.register('base', sandbox.dir('base'));
		const child = await sandbox.register('shop', sandbox.dir('shop'));
		await setParent(sandbox.registryDir, 'shop', 'base');
		const registry = loadRegistry(sandbox.registryDir);
		const storage = registryStorage(
			registry,
			sandbox.registryDir,
			registry.projects.find(p => p.id === child.id)!
		);
		write(storage.configFiles[0]!, 'board:\n  columns:\n    - name: ""\n      statuses: [x]\n');
		expect(failure(storage).layer).toBe(storage.configFiles[0]);
	});
});

describe('saveBoardColumns / clearBoardColumns write the OWN layer', () => {
	it('saves the columns, keeps the other keys, and the config reads them back', async () => {
		const storage = await single();
		const file = ownConfigFile(storage);
		write(file, `${STATUSES}types:\n  - bug\n`);
		const columns = [
			{ name: 'Open', statuses: ['backlog', 'in-progress'] },
			{ name: 'Closed', statuses: ['done'] },
		];

		saveBoardColumns({ storage, config: load(storage) }, columns);

		const config = load(storage);
		expect(config.board).toEqual({ columns });
		expect(config.types).toEqual(['bug']);
		expect(config.statuses).toEqual(['backlog', 'in-progress', 'done']);
	});

	it('refuses an invalid layout with the same error as a load and writes nothing', async () => {
		const storage = await single();
		const file = ownConfigFile(storage);
		write(file, STATUSES);
		const before = fs.readFileSync(file, 'utf8');

		expect(() => saveBoardColumns({ storage, config: load(storage) }, [{ name: 'A', statuses: ['nope'] }])).toThrow(
			BoardConfigError
		);
		expect(fs.readFileSync(file, 'utf8')).toBe(before);
	});

	it('creates the own config file (and folder) when the project has none', async () => {
		const storage = await single();
		saveBoardColumns({ storage, config: load(storage) }, [
			{ name: 'All', statuses: ['backlog', 'in-progress', 'done'] },
		]);
		expect(load(storage).board?.columns[0]?.name).toBe('All');
	});

	it('clear removes the key and keeps the rest; clearing a file with no board changes nothing', async () => {
		const storage = await single();
		const file = ownConfigFile(storage);
		write(file, `${STATUSES}board:\n  columns:\n    - name: A\n      statuses: [backlog]\n`);

		clearBoardColumns({ storage, config: load(storage) });

		expect(load(storage).board).toBeUndefined();
		expect(load(storage).statuses).toEqual(['backlog', 'in-progress', 'done']);
		const after = fs.readFileSync(file, 'utf8');
		clearBoardColumns({ storage, config: load(storage) });
		expect(fs.readFileSync(file, 'utf8')).toBe(after);
	});

	it('clear on a project with no config file creates nothing', async () => {
		const storage = await single();
		clearBoardColumns({ storage, config: load(storage) });
		expect(fs.existsSync(ownConfigFile(storage))).toBe(false);
	});
});
