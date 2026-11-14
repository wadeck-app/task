import * as fs from 'node:fs';
import * as path from 'node:path';

import { ConfigSchemaError, loadRegistry, setParent } from '@wadeck-app/project-sdk';

import { loadTaskConfig, TASK_CONFIG_SCHEMA } from './projectConfig.js';
import { RemovedConfigKeyError } from './removedConfigKey.js';
import { ownConfigFile, registryStorage } from './storage.js';
import type { TaskStorage } from './storage.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

let sandbox: SharedRegistrySandbox;

beforeEach(() => {
	sandbox = createSharedRegistrySandbox();
});

afterEach(() => {
	sandbox.cleanup();
});

/** Writes a config layer file (and its directory). */
function write(file: string, yml: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, yml);
}

/** A child project `shop` under a parent `base`; returns the storage of the child (files: [base, shop]). */
async function chain(): Promise<TaskStorage> {
	await sandbox.register('base', sandbox.dir('base'));
	const child = await sandbox.register('shop', sandbox.dir('shop'));
	await setParent(sandbox.registryDir, 'shop', 'base');
	const registry = loadRegistry(sandbox.registryDir);
	return registryStorage(
		registry,
		sandbox.registryDir,
		registry.projects.find(p => p.id === child.id)!
	);
}

async function single(): Promise<TaskStorage> {
	const project = await sandbox.register('shop', sandbox.dir('shop'));
	return registryStorage(loadRegistry(sandbox.registryDir), sandbox.registryDir, project);
}

describe('the schema of the task config', () => {
	it('declares the six sections with their scope: statuses, types, priorities, fields and strategy local; defaults inherited deeply; no hooks', () => {
		expect(TASK_CONFIG_SCHEMA.sections).toEqual({
			statuses: { scope: 'local' },
			types: { scope: 'local' },
			priorities: { scope: 'local' },
			fields: { scope: 'local' },
			strategy: { scope: 'local' },
			defaults: { scope: 'inherit', merge: 'deep' },
		});
	});
});

describe('loadTaskConfig: a project of the shared registry', () => {
	it('uses the defaults when no config file exists anywhere', async () => {
		const config = loadTaskConfig(await single(), sandbox.root);

		expect(config.statuses).toEqual(['backlog', 'in-progress', 'done']);
		expect(config.types).toEqual([]);
		expect(config.defaults.priority).toBe('medium');
	});

	it('reads the own config layer', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'statuses:\n  - todo\n  - name: done\n    terminal: true\ntypes:\n  - bug\n');

		const config = loadTaskConfig(storage, sandbox.root);

		expect(config.statuses).toEqual(['todo', 'done']);
		expect(config.terminalStatuses).toEqual(['done']);
		expect(config.types).toEqual(['bug']);
	});

	it('inherits defaults along the parent chain; the child wins, the global config is the last fallback', async () => {
		const storage = await chain();
		const [parentFile, childFile] = storage.configFiles as [string, string];
		write(path.join(sandbox.root, 'global', 'config.yml'), 'defaults:\n  priority: low\n');

		expect(loadTaskConfig(storage, path.join(sandbox.root, 'global')).defaults.priority).toBe('low');

		write(parentFile, 'defaults:\n  priority: high\n');
		expect(loadTaskConfig(storage, path.join(sandbox.root, 'global')).defaults.priority).toBe('high');

		write(childFile, 'defaults:\n  priority: urgent\n');
		expect(loadTaskConfig(storage, path.join(sandbox.root, 'global')).defaults.priority).toBe('urgent');
	});

	it('statuses and types are local: the parent values are valid there but never reach the child', async () => {
		const storage = await chain();
		const [parentFile] = storage.configFiles as [string, string];
		write(parentFile, 'statuses:\n  - only-parent\ntypes:\n  - parent-type\n');

		const config = loadTaskConfig(storage, sandbox.root);

		expect(config.statuses).toEqual(['backlog', 'in-progress', 'done']);
		expect(config.types).toEqual([]);
	});

	describe('hooks is not a config key any more', () => {
		const HINT =
			"task does not run commands from the config. React to task events with queue subscribers: see CLAUDE.md 'Queue events' (`<project>/.queue/subscribers.yml`, `when:` filters).";

		function capture(run: () => unknown): RemovedConfigKeyError {
			try {
				run();
			} catch (error) {
				expect(error).toBeInstanceOf(RemovedConfigKeyError);
				return error as RemovedConfigKeyError;
			}
			throw new Error('expected a RemovedConfigKeyError, nothing was thrown');
		}

		it('in the own layer of the project: ConfigSchemaError naming the file and the key, with the fix', async () => {
			const storage = await single();
			write(ownConfigFile(storage), 'hooks:\n  onTaskCreated: echo project\n');

			const failure = capture(() => loadTaskConfig(storage, sandbox.root));

			expect(failure).toBeInstanceOf(ConfigSchemaError);
			expect(failure.layer).toBe(ownConfigFile(storage));
			expect(failure.key).toBe('hooks');
			expect(failure.hint).toBe(HINT);
			expect(failure.message).toBe(
				`${ownConfigFile(storage)}: hooks: not supported, remove it (task never runs commands from the config)`
			);
		});

		it('in a parent layer: the file of the PARENT is named', async () => {
			const storage = await chain();
			const [parentFile] = storage.configFiles as [string, string];
			write(parentFile, 'hooks:\n  onTaskCreated: echo parent\n');

			const failure = capture(() => loadTaskConfig(storage, sandbox.root));

			expect(failure.layer).toBe(parentFile);
			expect(failure.key).toBe('hooks');
		});

		it('in the global config: the global file is named', async () => {
			const storage = await single();
			const globalFile = path.join(sandbox.root, 'global', 'config.yml');
			write(globalFile, 'hooks:\n  onTaskCreated: echo global\n');

			const failure = capture(() => loadTaskConfig(storage, path.join(sandbox.root, 'global')));

			expect(failure.layer).toBe(globalFile);
			expect(failure.key).toBe('hooks');
			expect(failure.hint).toBe(HINT);
		});

		it('the resolved config has no hooks fields', async () => {
			const config = loadTaskConfig(await single(), sandbox.root);

			expect(Object.keys(config)).not.toContain('globalHooks');
			expect(Object.keys(config)).not.toContain('projectHooks');
		});
	});

	it('an unknown or misplaced key is an error naming the FILE and the key', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'statuses:\n  - todo\ncolour: red\n');

		let failure: unknown;
		try {
			loadTaskConfig(storage, sandbox.root);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(ConfigSchemaError);
		expect((failure as Error).message).toContain(ownConfigFile(storage));
		expect((failure as Error).message).toContain('colour');
	});

	it('reads outcome: negative of a terminal status', async () => {
		const storage = await single();
		write(
			ownConfigFile(storage),
			'statuses:\n  - todo\n  - name: done\n    terminal: true\n  - name: rejected\n    terminal: true\n    outcome: negative\n'
		);

		const config = loadTaskConfig(storage, sandbox.root);

		expect(config.terminalStatuses).toEqual(['done', 'rejected']);
		expect(config.negativeStatuses).toEqual(['rejected']);
	});

	it.each([
		['an outcome on a non-terminal status', 'statuses:\n  - name: todo\n    outcome: negative\n', 'terminal: true'],
		[
			'an unknown outcome',
			'statuses:\n  - todo\n  - name: done\n    terminal: true\n    outcome: maybe\n',
			'"positive" or "negative"',
		],
	])('%s is a ConfigSchemaError naming the FILE and the key', async (_label, yml, fix) => {
		const storage = await single();
		write(ownConfigFile(storage), yml);

		let failure: unknown;
		try {
			loadTaskConfig(storage, sandbox.root);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(ConfigSchemaError);
		expect((failure as ConfigSchemaError).layer).toBe(ownConfigFile(storage));
		expect((failure as ConfigSchemaError).key).toBe('statuses');
		expect((failure as Error).message).toContain(ownConfigFile(storage));
		expect((failure as Error).message).toContain('outcome');
		expect((failure as Error).message).toContain(fix);
	});

	it('names the file of an ANCESTOR when its key is the problem', async () => {
		const storage = await chain();
		const [parentFile] = storage.configFiles as [string, string];
		write(parentFile, 'prioirty: high\n');

		expect(() => loadTaskConfig(storage, sandbox.root)).toThrow(parentFile);
	});

	it('keeps the status validation on the merged value: at least one, one default at most, the file is named', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'statuses: []\n');
		expect(() => loadTaskConfig(storage, sandbox.root)).toThrow(new RegExp('at least one status'));
		expect(() => loadTaskConfig(storage, sandbox.root)).toThrow(ownConfigFile(storage));

		write(ownConfigFile(storage), 'statuses:\n  - name: a\n    default: true\n  - name: b\n    default: true\n');
		expect(() => loadTaskConfig(storage, sandbox.root)).toThrow(/Only one status can be the default/);
	});

	it('an invalid YAML file is an error naming the file', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'statuses: [a, b');

		expect(() => loadTaskConfig(storage, sandbox.root)).toThrow(ownConfigFile(storage));
	});
});

describe('priorities and the claim lease in the config', () => {
	function failureOf(storage: TaskStorage, globalDir = sandbox.root): ConfigSchemaError {
		try {
			loadTaskConfig(storage, globalDir);
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigSchemaError);
			return error as ConfigSchemaError;
		}
		throw new Error('the config should have been refused');
	}

	it('defaults to urgent, high, medium, low, default priority medium and a 30 minute lease', async () => {
		const config = loadTaskConfig(await single(), sandbox.root);

		expect(config.priorities).toEqual(['urgent', 'high', 'medium', 'low']);
		expect(config.defaults.priority).toBe('medium');
		expect(config.defaults.leaseMinutes).toBe(30);
	});

	it('reads a project list of priorities (highest first) and its default', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'priorities: [p0, p1, p2]\ndefaults:\n  priority: p1\n  leaseMinutes: 90\n');

		const config = loadTaskConfig(storage, sandbox.root);

		expect(config.priorities).toEqual(['p0', 'p1', 'p2']);
		expect(config.defaults.priority).toBe('p1');
		expect(config.defaults.leaseMinutes).toBe(90);
	});

	it('priorities are local: a parent list never reaches the child, but leaseMinutes is inherited', async () => {
		const storage = await chain();
		const [parentFile] = storage.configFiles as [string, string];
		write(parentFile, 'priorities: [p0, p1]\ndefaults:\n  leaseMinutes: 5\n');

		const config = loadTaskConfig(storage, sandbox.root);

		expect(config.priorities).toEqual(['urgent', 'high', 'medium', 'low']);
		expect(config.defaults.leaseMinutes).toBe(5);
	});

	it('a project default priority that is not in the list names the file, the key defaults.priority and the valid list', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'priorities: [p0, p1]\ndefaults:\n  priority: medium\n');

		const error = failureOf(storage);

		expect(error.layer).toBe(ownConfigFile(storage));
		expect(error.key).toBe('defaults');
		expect(error.path).toBe('defaults.priority');
		expect(error.message).toContain(ownConfigFile(storage));
		expect(error.message).toContain('"medium"');
		expect(error.message).toContain('p0, p1');
	});

	it('a project declaring only its priorities loads, and its default is the last (lowest) entry', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'priorities: [p0, p1, p2]\n');

		const config = loadTaskConfig(storage, sandbox.root);

		expect(config.defaults.priority).toBe('p2');
	});

	it('without a project default, medium is the default when it is listed', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'priorities: [high, medium, low, none]\n');

		expect(loadTaskConfig(storage, sandbox.root).defaults.priority).toBe('medium');
	});

	it('a global default priority that is in the project list is the default', async () => {
		const storage = await single();
		const globalDir = path.join(sandbox.root, 'global');
		write(path.join(globalDir, 'config.yml'), 'defaults:\n  priority: high\n');

		expect(loadTaskConfig(storage, globalDir).defaults.priority).toBe('high');
	});

	it('a global default priority outside the project list is ignored, never an error', async () => {
		const storage = await single();
		const globalDir = path.join(sandbox.root, 'global');
		write(path.join(globalDir, 'config.yml'), 'defaults:\n  priority: normal\n');

		expect(loadTaskConfig(storage, globalDir).defaults.priority).toBe('medium');

		write(ownConfigFile(storage), 'priorities: [p0, p1]\n');

		expect(loadTaskConfig(storage, globalDir).defaults.priority).toBe('p1');
	});

	it('a priority with a space at its start or end is refused, naming the value, the entry and the fix', async () => {
		const storage = await single();
		write(ownConfigFile(storage), 'priorities: [high, " low"]\n');

		const error = failureOf(storage);

		expect(error.layer).toBe(ownConfigFile(storage));
		expect(error.key).toBe('priorities');
		expect(error.path).toBe('priorities[1]');
		expect(error.message).toContain('" low"');
		expect(error.message).toContain('write "low"');
	});

	it.each([
		['not a list', 'priorities: high\n', 'priorities'],
		['an empty list', 'priorities: []\n', 'priorities'],
		['a blank entry', 'priorities: [high, " "]\n', 'priorities[1]'],
		['an entry that is not text', 'priorities: [high, 3]\n', 'priorities[1]'],
		['a duplicate', 'priorities: [high, low, high]\n', 'priorities[2]'],
	])('%s is a ConfigSchemaError naming the file and the key priorities', async (_label, yml, where) => {
		const storage = await single();
		write(ownConfigFile(storage), yml);

		const error = failureOf(storage);

		expect(error.layer).toBe(ownConfigFile(storage));
		expect(error.key).toBe('priorities');
		expect(error.path).toBe(where);
		expect(error.message).toContain(ownConfigFile(storage));
	});

	it.each([['0'], ['10081'], ['1.5'], ['"30"'], ['-4']])(
		'leaseMinutes %s is refused with the range, naming the file',
		async value => {
			const storage = await single();
			write(ownConfigFile(storage), `defaults:\n  leaseMinutes: ${value}\n`);

			const error = failureOf(storage);

			expect(error.layer).toBe(ownConfigFile(storage));
			expect(error.key).toBe('defaults');
			expect(error.path).toBe('defaults.leaseMinutes');
			expect(error.message).toContain('1 to 10080');
		}
	);
});
