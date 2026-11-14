import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BACKEND_CAPABILITY_NAMES, LOCAL_CAPABILITIES } from '@wadeck-app/task-core';
import type { BackendCapabilities } from '@wadeck-app/task-core';

import { createBuiltinRegistry } from './plugins/builtinPlugins.js';
import type { StrategyPlugin } from './plugins/kinds.js';
import { StrategyConfigError } from './strategyConfig.js';
import { describeCapabilities, showStrategy } from './strategyReport.js';
import type { StrategyTarget } from './strategyReport.js';

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function target(configYml: string | undefined, extra: Partial<StrategyTarget> = {}): StrategyTarget {
	const configFile = path.join(root, 'config', 'config.yml');
	if (configYml !== undefined) {
		fs.mkdirSync(path.dirname(configFile), { recursive: true });
		fs.writeFileSync(configFile, configYml, 'utf8');
	}
	return {
		storage: { dataDir: path.join(root, 'data'), configFiles: [configFile] },
		project: { id: 'a1b2c3d4', name: 'shop', path: root },
		globalConfigDir: path.join(root, 'global'),
		...extra,
	};
}

const RESTRICTED: BackendCapabilities = {
	...LOCAL_CAPABILITIES,
	hierarchy: 'none',
	meta: false,
	delete: 'close-only',
	linkTypes: ['blockedBy'],
};

function restrictedPlugin(): StrategyPlugin {
	const local = createBuiltinRegistry().lookup('local', 'strategy');
	return {
		...local,
		backendKind: 'github',
		capabilities: RESTRICTED,
		fillTechniques: { meta: ['labels', 'body-block'] },
	};
}

describe('showStrategy: a project without a strategy section', () => {
	it('reports the default: local, strict, no fill, nothing declared', () => {
		const report = showStrategy(target(undefined));

		expect(report).toMatchObject({
			project: { id: 'a1b2c3d4', name: 'shop', path: root },
			source: path.join(root, 'config', 'config.yml'),
			declared: false,
			type: 'local',
			ref: 'plugins.local.default',
			kind: 'local',
			fidelity: 'strict',
			fills: [],
			dataDir: path.join(root, 'data'),
		});
		expect(report.summary).toMatch(/shared project registry/);
		expect(report.transport).toBeUndefined();
	});

	it('lists every capability of the backend as native, with the value the backend declares', () => {
		const report = showStrategy(target(undefined));

		expect(report.capabilities.map(row => row.capability)).toEqual([...BACKEND_CAPABILITY_NAMES]);
		expect(report.capabilities.every(row => row.state === 'native')).toBe(true);
		expect(report.capabilities.find(row => row.capability === 'hierarchy')).toEqual({
			capability: 'hierarchy',
			state: 'native',
			detail: 'unlimited',
		});
		expect(report.capabilities.find(row => row.capability === 'linkTypes')?.detail).toBe(
			'blockedBy, duplicateOf, causedBy'
		);
		expect(report.capabilities.find(row => row.capability === 'meta')?.detail).toBe('yes');
	});

	it('does not create the data folder nor open the backend', () => {
		showStrategy(target(undefined));

		expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
	});
});

describe('showStrategy: a declared strategy', () => {
	it('says it is declared and keeps the fidelity written', () => {
		const report = showStrategy(target('strategy:\n    type: local\n    fidelity: degrade\n'));

		expect(report).toMatchObject({ declared: true, fidelity: 'degrade' });
	});

	it('names the token variable and whether it is set, never its value', () => {
		const registry = createBuiltinRegistry();
		registry.register('plugins.tokened.default', { ...restrictedPlugin(), validate: () => undefined }, ['tokened']);
		const yml =
			'strategy:\n    type: tokened\n    options:\n        tokenEnv: TASK_TEST_TOKEN\n        tokenFile: /nope/token\n';

		const unset = showStrategy(target(yml, { registry, env: {} }));
		const set = showStrategy(target(yml, { registry, env: { TASK_TEST_TOKEN: 'sekret-value' } }));

		expect(unset.tokens).toEqual([
			{ key: 'strategy.options.tokenEnv', source: 'env', name: 'TASK_TEST_TOKEN', present: false },
			{ key: 'strategy.options.tokenFile', source: 'file', name: '/nope/token' },
		]);
		expect(set.tokens[0]).toEqual({
			key: 'strategy.options.tokenEnv',
			source: 'env',
			name: 'TASK_TEST_TOKEN',
			present: true,
		});
		expect(JSON.stringify(set)).not.toContain('sekret-value');
	});

	it('a broken section is the config error itself, naming the file and the key', () => {
		expect(() => showStrategy(target('strategy:\n    type: github\n'))).toThrow(StrategyConfigError);
		expect(() => showStrategy(target('strategy:\n    repo: x\n'))).toThrow('strategy.repo: unknown key');
	});

	it('lists each declared fill with its technique, fidelity and quality', () => {
		const registry = createBuiltinRegistry();
		registry.register('plugins.restricted.default', restrictedPlugin(), ['restricted']);
		const yml =
			'strategy:\n    type: restricted\n    options:\n        fills:\n            meta: { use: body-block, fidelity: degrade }\n';

		const report = showStrategy(target(yml, { registry }));

		expect(report.fills).toEqual([
			{ capability: 'meta', technique: 'body-block', fidelity: 'degrade', quality: 'approximate' },
		]);
		expect(report.capabilities.find(row => row.capability === 'meta')).toEqual({
			capability: 'meta',
			state: 'emulated',
			detail: 'via body-block (approximate, fidelity degrade)',
		});
	});
});

describe('describeCapabilities', () => {
	it('marks a capability the backend lacks as unsupported', () => {
		const rows = describeCapabilities(RESTRICTED, {});

		expect(rows.find(row => row.capability === 'hierarchy')).toEqual({
			capability: 'hierarchy',
			state: 'unsupported',
			detail: 'none',
		});
		expect(rows.find(row => row.capability === 'meta')).toEqual({
			capability: 'meta',
			state: 'unsupported',
			detail: 'no',
		});
		expect(rows.find(row => row.capability === 'delete')).toEqual({
			capability: 'delete',
			state: 'native',
			detail: 'close-only',
		});
	});

	it('reports the missing link types one by one when some are stored', () => {
		const rows = describeCapabilities(RESTRICTED, {});

		expect(rows.filter(row => row.capability.startsWith('linkTypes'))).toEqual([
			{ capability: 'linkTypes.blockedBy', state: 'native', detail: 'stored' },
			{ capability: 'linkTypes.causedBy', state: 'unsupported', detail: 'not stored' },
			{ capability: 'linkTypes.duplicateOf', state: 'unsupported', detail: 'not stored' },
		]);
	});

	it('a declared fill turns the unsupported row into an emulated one', () => {
		const rows = describeCapabilities(RESTRICTED, {
			hierarchy: { use: 'tasklist', fidelity: 'degrade' },
			'linkTypes.causedBy': { use: 'relate-block', fidelity: 'degrade' },
		});

		expect(rows.find(row => row.capability === 'hierarchy')).toEqual({
			capability: 'hierarchy',
			state: 'emulated',
			detail: 'via tasklist (lossy, fidelity degrade)',
		});
		expect(rows.find(row => row.capability === 'linkTypes.causedBy')?.state).toBe('emulated');
	});
});

describe('describeCapabilities: what a plugin says is only partly true', () => {
	it('a note turns a native or unsupported row into a partial one with the note as its detail', () => {
		const rows = describeCapabilities(
			RESTRICTED,
			{},
			{
				delete: 'closes only',
				'linkTypes.duplicateOf': 'read from the managed block',
			}
		);

		expect(rows.find(row => row.capability === 'delete')).toEqual({
			capability: 'delete',
			state: 'partial',
			detail: 'closes only',
		});
		expect(rows.find(row => row.capability === 'linkTypes.duplicateOf')).toEqual({
			capability: 'linkTypes.duplicateOf',
			state: 'partial',
			detail: 'read from the managed block',
		});
		expect(rows.find(row => row.capability === 'linkTypes.causedBy')?.state).toBe('unsupported');
	});

	it('a declared fill wins over a note: the row is emulated', () => {
		const rows = describeCapabilities(
			RESTRICTED,
			{ meta: { use: 'labels', fidelity: 'strict' } },
			{ meta: 'a note' }
		);

		expect(rows.find(row => row.capability === 'meta')?.state).toBe('emulated');
	});

	it('a note on a capability that does not exist is a bug of the plugin, said loudly', () => {
		expect(() => describeCapabilities(RESTRICTED, {}, { nonsense: 'x' })).toThrow(/nonsense/);
	});
});

describe('describeCapabilities: priority, assignee and claim', () => {
	it('are native for the local strategy', () => {
		const rows = describeCapabilities(LOCAL_CAPABILITIES, {});

		for (const name of ['priority', 'assignee', 'claim']) {
			expect(rows.find(row => row.capability === name)).toEqual({
				capability: name,
				state: 'native',
				detail: 'yes',
			});
		}
	});

	it('are unsupported for a backend that declares them false (github, gitlab, remote)', () => {
		const rows = describeCapabilities(
			{ ...LOCAL_CAPABILITIES, priority: false, assignee: false, claim: false },
			{}
		);

		for (const name of ['priority', 'assignee', 'claim']) {
			expect(rows.find(row => row.capability === name)).toEqual({
				capability: name,
				state: 'unsupported',
				detail: 'no',
			});
		}
	});
});
