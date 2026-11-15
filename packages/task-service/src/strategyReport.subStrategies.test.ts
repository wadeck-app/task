import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LOCAL_CAPABILITIES } from '@wadeck-app/task-core';

import { createBuiltinRegistry } from './plugins/builtinPlugins.js';
import type { StrategyPlugin } from './plugins/kinds.js';
import { checkStrategy } from './strategyCheck.js';
import { showStrategy } from './strategyReport.js';
import type { StrategyTarget } from './strategyReport.js';

// `task strategy show` and `check` for a strategy that holds other strategies: both sides are reported, each with its own tokens,
// fills and capabilities; what the host does not know about a plugin it does not print. A fake meta-plugin stands in.
let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const META: StrategyPlugin = {
	extensionPoint: 'strategy',
	backendKind: 'migrating',
	capabilities: LOCAL_CAPABILITIES,
	fillTechniques: {},
	strategySlots: ['current', 'new'],
	validate: () => undefined,
	capabilitiesFor: () => ({ ...LOCAL_CAPABILITIES, meta: false }),
	create: async (_options, context) => {
		const current = await context.openStrategy!('current');
		const other = await context.openStrategy!('new', { dataSubdir: 'n' });
		return {
			backend: current.backend,
			describe: () => ['side: both'],
			check: async () => [
				{ name: 'own', status: 'ok' as const, text: 'meta line' },
				...(await current.check()).map(line => ({ ...line, name: `current.${line.name}` })),
				...(await other.check()).map(line => ({ ...line, name: `new.${line.name}` })),
			],
			dispose: () => Promise.resolve(),
		};
	},
	describe: () => ({ summary: 'fake meta summary', options: {}, snippet: '' }),
};

function target(configYml: string): StrategyTarget {
	const configFile = path.join(root, 'config', 'config.yml');
	fs.mkdirSync(path.dirname(configFile), { recursive: true });
	fs.writeFileSync(configFile, configYml, 'utf8');
	const registry = createBuiltinRegistry();
	registry.register('plugins.fakemeta.default', META, ['fakemeta']);
	return {
		storage: { dataDir: path.join(root, 'data'), configFiles: [configFile] },
		project: { id: 'a1b2c3d4', name: 'shop', path: root },
		globalConfigDir: path.join(root, 'global'),
		registry,
		env: {},
	};
}

const CONFIG = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
strategy:
    type: fakemeta
    options:
        current: { type: local }
        new:
            type: github
            options:
                repo: acme/shop
                tokenEnv: SHOP_TOKEN
                statusMap:
                    backlog: { state: open }
                    in-progress: { state: open, label: 'status:in-progress' }
                    done: { state: closed }
`;

describe('showStrategy: a strategy that holds strategies', () => {
	it('reports each side with its type, kind, summary, options, fills and its own capability table', () => {
		const report = showStrategy(target(CONFIG));

		expect(report.type).toBe('fakemeta');
		expect(report.subStrategies?.map(sub => [sub.slot, sub.type, sub.kind])).toEqual([
			['current', 'local', 'local'],
			['new', 'github', 'github'],
		]);
		const current = report.subStrategies![0]!;
		expect(current.summary).toContain('Task files');
		expect(current.capabilities.find(row => row.capability === 'meta')?.state).toBe('native');
		const other = report.subStrategies![1]!;
		expect(other.capabilities.find(row => row.capability === 'meta')?.state).toBe('unsupported');
		expect(other.options['repo']).toBe('acme/shop');
	});

	it('lists the tokens of every side under their full dotted key, never the value', () => {
		const withToken = showStrategy({ ...target(CONFIG), env: { SHOP_TOKEN: 'secret-value' } });
		const withoutToken = showStrategy(target(CONFIG));

		expect(withToken.tokens).toEqual([
			{ key: 'strategy.options.new.options.tokenEnv', source: 'env', name: 'SHOP_TOKEN', present: true },
		]);
		expect(withoutToken.tokens[0]).toMatchObject({ present: false });
		expect(JSON.stringify(withToken)).not.toContain('secret-value');
	});

	it('a project strategy that holds none has no subStrategies key', () => {
		const report = showStrategy(target('strategy:\n    type: local\n'));
		expect(report).not.toHaveProperty('subStrategies');
	});

	it('the capabilities of the strategy itself are the plugin answer for its sides', () => {
		const report = showStrategy(target(CONFIG));
		expect(report.capabilities.find(row => row.capability === 'meta')?.state).toBe('unsupported');
	});
});

describe('checkStrategy: a strategy that holds strategies', () => {
	it('a missing token of the second side is a line naming its full key, with the fix', async () => {
		const result = await checkStrategy({ ...target(CONFIG), memoryCache: true }, { backend: false });

		const token = result.lines.find(line => line.name === 'token');
		expect(token).toMatchObject({ status: 'error' });
		expect(token?.text).toContain('strategy.options.new.options.tokenEnv');
		expect(token?.fix).toBeDefined();
	});

	it('warns about a fill emulated on a side, with the side in the text and a fix', async () => {
		const withFill = CONFIG.replace(
			'repo: acme/shop',
			'repo: acme/shop\n                fills: { meta: { use: body-block, fidelity: degrade } }'
		);
		const result = await checkStrategy(target(withFill), { backend: false });

		const fill = result.lines.find(line => line.name === 'fills');
		expect(fill?.status).toBe('warn');
		expect(fill?.text).toContain('new: meta is emulated via body-block');
		expect(fill?.fix).toBeDefined();
	});
});
