import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createPluginRegistry } from './plugin-host/index.js';
import { createBuiltinRegistry } from './plugins/builtinPlugins.js';
import { plainHttpPlugin } from './plugins/plain-http/plainHttpPlugin.js';
import { PluginNotImplementedError } from './plugins/kinds.js';
import type { CheckLine, StrategyPlugin, TaskPluginKinds } from './plugins/kinds.js';
import { checkStrategy } from './strategyCheck.js';
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
		env: {},
		...extra,
	};
}

/** A strategy derived from local, to change one thing at a time. */
function derived(overrides: Partial<StrategyPlugin>): StrategyPlugin {
	return { ...createBuiltinRegistry().lookup('local', 'strategy'), validate: () => undefined, ...overrides };
}

/** The built-ins with the remote strategy replaced by one that never touches the network (these tests check the configuration lines). */
function remoteRegistry() {
	return createPluginRegistry<TaskPluginKinds>([
		{
			ref: 'plugins.local.default',
			plugin: createBuiltinRegistry().lookup('local', 'strategy'),
			aliases: ['local'],
		},
		{ ref: 'plugins.remote.default', plugin: derived({ backendKind: 'remote' }), aliases: ['remote'] },
		{ ref: 'plugins.plain-http.default', plugin: plainHttpPlugin, aliases: ['plain-http'] },
	]);
}

function registryWith(plugins: Record<string, StrategyPlugin>) {
	const registry = createBuiltinRegistry();
	for (const [alias, plugin] of Object.entries(plugins))
		registry.register(`plugins.${alias}.default`, plugin, [alias]);
	return registry;
}

function line(lines: CheckLine[], name: string): CheckLine | undefined {
	return lines.find(l => l.name === name);
}

describe('checkStrategy: a project without a strategy section', () => {
	it('is fine: config, strategy, then the local lines, no error and no warning', async () => {
		const result = await checkStrategy(target(undefined));

		expect(result.ok).toBe(true);
		expect(result.errors).toBe(0);
		expect(result.warnings).toBe(0);
		expect(result.lines.map(l => [l.name, l.status])).toEqual([
			['config', 'ok'],
			['strategy', 'ok'],
			['data', 'ok'],
			['writable', 'ok'],
			['tasks', 'ok'],
		]);
		expect(line(result.lines, 'config')?.text).toBe(
			`${path.join(root, 'config', 'config.yml')}: no strategy section, local by default`
		);
		expect(line(result.lines, 'strategy')?.text).toBe('local (plugins.local.default), fidelity strict');
		expect(result.report?.capabilities.every(row => row.state === 'native')).toBe(true);
	});

	it('creates nothing', async () => {
		await checkStrategy(target(undefined));

		expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
	});

	it('with strategy: { type: local } the config line says the section is valid', async () => {
		const result = await checkStrategy(target('strategy:\n    type: local\n'));

		expect(line(result.lines, 'config')?.text).toBe(
			`${path.join(root, 'config', 'config.yml')}: strategy section valid`
		);
		expect(result.ok).toBe(true);
	});
});

describe('checkStrategy: a config that cannot be used', () => {
	it('reports the error of the config instead of throwing, with the fix, and checks nothing else', async () => {
		const result = await checkStrategy(target('strategy:\n    type: gitlab\n'));

		expect(result.ok).toBe(false);
		expect(result.errors).toBe(1);
		expect(result.lines).toHaveLength(1);
		expect(result.lines[0]).toMatchObject({ name: 'config', status: 'error' });
		expect(result.lines[0]!.text).toContain(
			'strategy.type: strategy type gitlab is declared but no plugin is installed; built-in types: github, local, remote'
		);
		expect(result.lines[0]!.fix).toMatch(/Set strategy.type to a built-in type \((github, local, remote)\)/);
		expect(result.report).toBeUndefined();
	});

	it('an invalid YAML file is an error line too', async () => {
		const result = await checkStrategy(target('strategy: [a, b'));

		expect(result.ok).toBe(false);
		expect(result.lines[0]!.text).toContain('not valid YAML');
	});

	it('a literal credential is an error line with the tokenEnv fix', async () => {
		const result = await checkStrategy(target('strategy:\n    options:\n        token: abc\n'));

		expect(result.lines[0]).toMatchObject({ name: 'config', status: 'error' });
		expect(result.lines[0]!.fix).toMatch(/tokenEnv/);
	});
});

describe('checkStrategy: tokens', () => {
	const registry = (): ReturnType<typeof registryWith> => registryWith({ tokened: derived({}) });

	it('a variable that is not set is an error with the fix, and the check goes on', async () => {
		const result = await checkStrategy(
			target('strategy:\n    type: tokened\n    options:\n        tokenEnv: TASK_TEST_TOKEN\n', {
				registry: registry(),
			})
		);

		expect(result.ok).toBe(false);
		expect(line(result.lines, 'token')).toMatchObject({
			status: 'error',
			text: 'TASK_TEST_TOKEN is not set (strategy.options.tokenEnv)',
		});
		expect(line(result.lines, 'tasks')).toBeDefined();
	});

	it('a variable that is set is ok', async () => {
		const result = await checkStrategy(
			target('strategy:\n    type: tokened\n    options:\n        tokenEnv: TASK_TEST_TOKEN\n', {
				registry: registry(),
				env: { TASK_TEST_TOKEN: 'x' },
			})
		);

		expect(result.ok).toBe(true);
		expect(line(result.lines, 'token')?.status).toBe('ok');
	});

	it('a token file that does not exist is an error naming the file', async () => {
		const missing = path.join(root, 'no-token');
		const result = await checkStrategy(
			target(
				`strategy:\n    type: tokened\n    options:\n        tokenFile: '${missing.replace(/\\/g, '/')}'\n`,
				{ registry: registry() }
			)
		);

		expect(line(result.lines, 'token')?.status).toBe('error');
		expect(line(result.lines, 'token')?.text).toContain('cannot be read');
	});
});

describe('checkStrategy: the transport', () => {
	function remoteConfig(url: string): string {
		return `strategy:\n    type: remote\n    options:\n        transport:\n            type: plain-http\n            options:\n                url: ${url}\n                tokenEnv: TASK_REMOTE_TOKEN\n`;
	}

	it.each(['http://nas.lan:7788', 'http://192.168.1.20:7788'])(
		'warns on plain HTTP to a non-loopback host (%s)',
		async url => {
			const result = await checkStrategy(
				target(remoteConfig(url), {
					registry: remoteRegistry(),
					env: { TASK_REMOTE_TOKEN: 'x' },
				})
			);

			expect(result.ok).toBe(true);
			expect(result.warnings).toBe(1);
			expect(line(result.lines, 'security')).toEqual({
				name: 'security',
				status: 'warn',
				text: `plain HTTP to a non-loopback host: traffic and the token are readable on the network; trusted LAN only (${url})`,
				fix: 'Serve over https:// through a wrapper, or keep the server on a network you trust',
			});
		}
	);

	it.each(['http://localhost:7788', 'http://127.0.0.1:7788', 'http://[::1]:7788', 'https://nas.lan'])(
		'does not warn for %s',
		async url => {
			const result = await checkStrategy(
				target(remoteConfig(url), {
					registry: remoteRegistry(),
					env: { TASK_REMOTE_TOKEN: 'x' },
				})
			);

			expect(line(result.lines, 'security')).toBeUndefined();
			expect(result.warnings).toBe(0);
		}
	);

	it('a typo in the transport options is a config error naming the dotted key', async () => {
		const yml = remoteConfig('http://nas.lan').replace('tokenEnv', 'tokenEnvv');
		const result = await checkStrategy(target(yml, { registry: remoteRegistry() }));

		expect(result.lines[0]!.text).toContain(
			'strategy.options.transport.options.tokenEnvv: unknown option for transport "plain-http"'
		);
	});
});

describe('checkStrategy: opening the backend', () => {
	it('a backend that cannot be created is an error line with the fix of the error', async () => {
		const failing = derived({
			create: () =>
				Promise.reject(new PluginNotImplementedError('plugins.x.default', 'stage 9', 'Do the other thing')),
		});

		const result = await checkStrategy(
			target('strategy:\n    type: failing\n', { registry: registryWith({ failing }) })
		);

		expect(result.ok).toBe(false);
		expect(line(result.lines, 'backend')).toMatchObject({ status: 'error', fix: 'Do the other thing' });
		expect(line(result.lines, 'backend')!.text).toContain(
			'Plugin "plugins.failing.default" failed to create its instance'
		);
	});

	it('appends the lines of the plugin, and an error among them fails the check', async () => {
		const plugin = derived({
			create: async (options, context) => {
				const base = await createBuiltinRegistry().lookup('local', 'strategy').create(options, context);
				return {
					...base,
					check: () =>
						Promise.resolve([
							{ name: 'reachable', status: 'error' as const, text: 'down', fix: 'start it' },
						]),
				};
			},
		});

		const result = await checkStrategy(
			target('strategy:\n    type: custom\n', { registry: registryWith({ custom: plugin }) })
		);

		expect(result.ok).toBe(false);
		expect(result.errors).toBe(1);
		expect(line(result.lines, 'reachable')).toEqual({
			name: 'reachable',
			status: 'error',
			text: 'down',
			fix: 'start it',
		});
	});

	it('a check that throws is an error line, not a crash', async () => {
		const plugin = derived({
			create: async (options, context) => {
				const base = await createBuiltinRegistry().lookup('local', 'strategy').create(options, context);
				return { ...base, check: () => Promise.reject(new Error('boom')) };
			},
		});

		const result = await checkStrategy(
			target('strategy:\n    type: custom\n', { registry: registryWith({ custom: plugin }) })
		);

		expect(line(result.lines, 'backend')).toMatchObject({ status: 'error', text: 'the check itself failed: boom' });
	});

	it('disposes the instance it opened, once', async () => {
		const dispose = vi.fn(() => Promise.resolve());
		const plugin = derived({
			create: async (options, context) => ({
				...(await createBuiltinRegistry().lookup('local', 'strategy').create(options, context)),
				dispose,
			}),
		});

		await checkStrategy(target('strategy:\n    type: custom\n', { registry: registryWith({ custom: plugin }) }));

		expect(dispose).toHaveBeenCalledTimes(1);
	});
});

describe('checkStrategy: fills', () => {
	it('warns for each fill that is not exact, naming the capability and the technique', async () => {
		const plugin = derived({ fillTechniques: { meta: ['labels', 'body-block'] } });
		const yml =
			'strategy:\n    type: custom\n    options:\n        fills:\n            meta: { use: body-block, fidelity: degrade }\n';

		const result = await checkStrategy(target(yml, { registry: registryWith({ custom: plugin }) }));

		expect(result.ok).toBe(true);
		expect(line(result.lines, 'fills')).toEqual({
			name: 'fills',
			status: 'warn',
			text: 'meta is emulated via body-block (approximate): edits made on the forge may overwrite it',
			fix: 'Accepted by fidelity: degrade; use an exact technique (labels) to remove this warning',
		});
	});

	it('an exact fill is not a warning', async () => {
		const plugin = derived({ fillTechniques: { meta: ['labels'] } });
		const yml = 'strategy:\n    type: custom\n    options:\n        fills:\n            meta: labels\n';

		const result = await checkStrategy(target(yml, { registry: registryWith({ custom: plugin }) }));

		expect(line(result.lines, 'fills')).toBeUndefined();
		expect(result.warnings).toBe(0);
	});
});
