import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { openTaskContext } from './openContext.js';
import { StrategyConfigError } from './strategyConfig.js';
import type { TaskStorage } from './storage.js';

// `ownLayer`: the project as it will be once its config file is replaced, opened without writing anything.
let root: string;
let configFile: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-ownlayer-'));
	configFile = path.join(root, 'config', 'config.yml');
	fs.mkdirSync(path.dirname(configFile), { recursive: true });
	fs.writeFileSync(configFile, 'statuses:\n    - backlog\n    - { name: done, terminal: true }\n');
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const storage = (): TaskStorage => ({ dataDir: path.join(root, 'data'), configFiles: [configFile] });

function open(ownLayer?: { name: string; values: Record<string, unknown> }) {
	return openTaskContext({
		storage: storage(),
		globalConfigDir: path.join(root, 'global'),
		project: { name: 'shop', path: root },
		...(ownLayer === undefined ? {} : { ownLayer }),
	});
}

describe('openTaskContext: ownLayer', () => {
	it('takes the statuses and the strategy from the layer, and leaves the file as it is', () => {
		const before = fs.readFileSync(configFile, 'utf8');
		const ctx = open({
			name: 'draft.yml',
			values: {
				statuses: ['todo', { name: 'shipped', terminal: true }],
				strategy: {
					type: 'remote',
					options: { transport: { options: { url: 'http://127.0.0.1:1', tokenEnv: 'X_TOKEN' } } },
				},
			},
		});

		expect(ctx.config.statuses).toEqual(['todo', 'shipped']);
		expect(ctx.strategy).toMatchObject({ type: 'remote', source: 'draft.yml' });
		expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
		expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
	});

	it('without a layer the project is read from its own file, as ever', () => {
		const ctx = open();

		expect(ctx.config.statuses).toEqual(['backlog', 'done']);
		expect(ctx.strategy).toMatchObject({ declared: false, type: 'local' });
	});

	it('a problem of the layer names the layer, not the project file', () => {
		expect(() =>
			open({ name: 'draft.yml', values: { strategy: { type: 'github', options: { token: 'abc' } } } })
		).toThrow(StrategyConfigError);
		expect(() => open({ name: 'draft.yml', values: { bogus: 1 } })).toThrow(/draft\.yml/);
	});

	it('the fresh context of a layered one keeps the layer', () => {
		const ctx = open({ name: 'draft.yml', values: { statuses: ['todo', { name: 'shipped', terminal: true }] } });

		const fresh = ctx.openFresh!();

		expect(fresh.config.statuses).toEqual(['todo', 'shipped']);
	});
});
