import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { REMOTE_CAPABILITIES, RemoteUnauthorizedError } from '@wadeck-app/task-core';
import type { ServerInfo } from '@wadeck-app/task-core';

import { createTask } from '../../createTask.js';
import { describeError } from '../../describeError.js';
import { openTaskContext } from '../../openContext.js';
import { createPluginRegistry } from '../../plugin-host/index.js';
import { startServerFixture } from '../../server/testHelpers.js';
import type { ServerFixture } from '../../server/testHelpers.js';
import { checkStrategy } from '../../strategyCheck.js';
import { showStrategy } from '../../strategyReport.js';
import { createBuiltinRegistry } from '../builtinPlugins.js';
import type { CheckLine, ProjectFacts, TaskPluginKinds, TransportPlugin } from '../kinds.js';
import { plainHttpPlugin } from '../plain-http/plainHttpPlugin.js';
import { checkRemote } from './remoteCheck.js';
import { remoteLocation, remotePlugin } from './remotePlugin.js';

let root: string;
const servers: ServerFixture[] = [];

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
});

afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop();
	fs.rmSync(root, { recursive: true, force: true });
});

const TOKEN_ENV = { TASK_REMOTE_TOKEN: 'test-token-0123456789abcdef' };

function configFor(url: string, extra = '', timeoutSeconds = 5): string {
	return `strategy:\n    type: remote\n    options:\n${extra}        transport:\n            type: plain-http\n            options:\n                url: ${url}\n                tokenEnv: TASK_REMOTE_TOKEN\n                timeoutSeconds: ${timeoutSeconds}\n`;
}

function storage(configYml: string) {
	const configFile = path.join(root, 'config', 'config.yml');
	fs.mkdirSync(path.dirname(configFile), { recursive: true });
	fs.writeFileSync(configFile, configYml, 'utf8');
	return { dataDir: path.join(root, 'data'), configFiles: [configFile] };
}

function target(configYml: string, extra: Partial<Parameters<typeof checkStrategy>[0]> = {}) {
	return {
		storage: storage(configYml),
		project: { id: 'b1b1b1b1', name: 'client', path: root },
		globalConfigDir: path.join(root, 'global'),
		env: TOKEN_ENV,
		...extra,
	};
}

async function server(options: Parameters<typeof startServerFixture>[0] = {}): Promise<ServerFixture> {
	const started = await startServerFixture(options);
	servers.push(started);
	return started;
}

const line = (lines: CheckLine[], name: string): CheckLine | undefined => lines.find(l => l.name === name);

describe('the remote plugin: declaration', () => {
	it('is the remote kind, declares the local capabilities with the events raised by the server and no priority, assignee or claim yet, and needs no fill', () => {
		expect(remotePlugin.extensionPoint).toBe('strategy');
		expect(remotePlugin.backendKind).toBe('remote');
		expect(remotePlugin.capabilities).toBe(REMOTE_CAPABILITIES);
		expect(remotePlugin.capabilities).toEqual({
			...createBuiltinRegistry().lookup('local', 'strategy').capabilities,
			priority: false,
			assignee: false,
			claim: false,
			events: 'server',
		});
		expect(remotePlugin.fillTechniques).toEqual({});
		expect(Object.keys(remotePlugin.describe().options)).toEqual(['project', 'transport']);
	});

	it('is registered under its ref and its alias', () => {
		const registry = createBuiltinRegistry();

		expect(registry.lookup('remote', 'strategy')).toBe(remotePlugin);
		expect(registry.lookup('plugins.remote.default', 'strategy')).toBe(remotePlugin);
	});

	it.each([
		[{ transport: { type: 'plain-http', options: {} } }, undefined],
		[{ project: 'shop', transport: {} }, undefined],
		[{}, 'transport: required (how to reach the server: { type: plain-http, options: { url, tokenEnv } })'],
		[{ transport: 'http://x' }, 'transport: must be a mapping with type and options, found "http://x"'],
		[
			{ transport: {}, project: '' },
			'project: must be the id or the name of the project the server serves, found ""',
		],
		[
			{ transport: {}, project: 3 },
			'project: must be the id or the name of the project the server serves, found 3',
		],
		[{ transport: {}, url: 'http://x' }, 'url: unknown option for strategy "remote" (known: project, transport)'],
	])('validates %j', (options, expected) => {
		expect(remotePlugin.validate(options, { slot: 'strategy' })).toBe(expected);
	});

	it('identifies its storage by the address of the server: case, a trailing slash and the credentials of nobody change it', () => {
		const location = (url: string) => remoteLocation({ transport: { options: { url } } });

		expect(location('http://NAS.lan:7788/')).toBe('remote http://nas.lan:7788');
		expect(location('http://nas.lan:7788')).toBe('remote http://nas.lan:7788');
		expect(location('http://nas.lan:7789')).not.toBe(location('http://nas.lan:7788'));
		expect(location('https://nas.lan/tasks/')).toBe('remote https://nas.lan/tasks');
		expect(remoteLocation({})).toBeUndefined();
	});

	it('keeps what a local project keeps for the migration, and prices a write as a round trip', () => {
		const traits = remotePlugin.traitsFor!({}, {}, { statuses: [], types: [] });

		expect(traits).toMatchObject({ keepsCreatedAt: true, authoredComments: true, commentTextMax: 10000 });
		expect(traits.cost?.requests).toBeGreaterThan(0);
		expect(traits.cost?.quotaPerHour).toBeUndefined();
	});
});

describe('the remote plugin: a project opened from its config', () => {
	it('talks to the server named in the config through the transport plugin, and the data lands on the server', async () => {
		const s = await server();
		const ctx = openTaskContext({
			storage: storage(configFor(s.server.url)),
			globalConfigDir: path.join(root, 'global'),
			project: { id: 'b1b1b1b1', name: 'client', path: root },
			env: TOKEN_ENV,
		});

		const created = await createTask(ctx, { title: 'From the other machine' });
		const shown = await ctx.store.get(created.task.id);

		expect(ctx.store.kind).toBe('remote');
		expect(ctx.store.capabilities.events).toBe('server');
		expect(shown.title).toBe('From the other machine');
		expect((await s.ctx.store.list()).map(task => task.title)).toEqual(['From the other machine']);
		// Nothing was written on THIS machine: the data folder of the client project does not even exist.
		expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
		await ctx.dispose?.();
	});

	it('accepts any transport the registry offers: a fake one proves the interface is swappable', async () => {
		const requests: string[] = [];
		const disposed = vi.fn();
		const fake: TransportPlugin = {
			extensionPoint: 'transport',
			validate: () => undefined,
			describe: () => ({ summary: 'fake', options: {}, snippet: '' }),
			create: () =>
				Promise.resolve({
					baseUrl: 'memory://tasks',
					headers: () => ({}),
					describe: () => ['url: memory://tasks'],
					dispose: () => {
						disposed();
						return Promise.resolve();
					},
					fetch: path_ => {
						requests.push(path_);
						return Promise.resolve(
							new Response(JSON.stringify({ items: [] }), {
								status: 200,
								headers: { 'X-Task-Protocol': '1' },
							})
						);
					},
				}),
		};
		const registry = createPluginRegistry<TaskPluginKinds>([
			{
				ref: 'plugins.local.default',
				plugin: createBuiltinRegistry().lookup('local', 'strategy'),
				aliases: ['local'],
			},
			{ ref: 'plugins.remote.default', plugin: remotePlugin, aliases: ['remote'] },
			{ ref: 'plugins.memory.default', plugin: fake, aliases: ['memory'] },
		]);
		const ctx = openTaskContext({
			storage: storage(
				'strategy:\n    type: remote\n    options:\n        transport:\n            type: memory\n'
			),
			globalConfigDir: path.join(root, 'global'),
			project: { name: 'client', path: root },
			registry,
			env: {},
		});

		expect(await ctx.store.list()).toEqual([]);
		await ctx.dispose?.();

		expect(requests).toEqual(['/v1/tasks']);
		expect(disposed).toHaveBeenCalledTimes(1);
	});

	it('a missing token fails the first call with the variable to set, before any request', async () => {
		const s = await server();
		const ctx = openTaskContext({
			storage: storage(configFor(s.server.url)),
			globalConfigDir: path.join(root, 'global'),
			project: { name: 'client', path: root },
			env: {},
		});

		const error = await ctx.store.list().catch((e: unknown) => e);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).cause).toBeInstanceOf(RemoteUnauthorizedError);
		expect(describeError(error)).toMatchObject({ kind: 'unavailable' });
		expect((error as Error).message).toContain('TASK_REMOTE_TOKEN is not set');
	});

	it('strategy show lists the server, the transport and that the events are raised by the server, without contacting it', async () => {
		const report = showStrategy(target(configFor('http://nas.lan:7788')));

		expect(report.kind).toBe('remote');
		expect(report.transport).toEqual({
			ref: 'plugins.plain-http.default',
			options: { url: 'http://nas.lan:7788', tokenEnv: 'TASK_REMOTE_TOKEN', timeoutSeconds: 5 },
		});
		expect(report.tokens).toEqual([
			{
				key: 'strategy.options.transport.options.tokenEnv',
				source: 'env',
				name: 'TASK_REMOTE_TOKEN',
				present: true,
			},
		]);
		expect(report.capabilities.find(row => row.capability === 'events')).toEqual({
			capability: 'events',
			state: 'native',
			detail: 'server',
		});
	});
});

describe('strategy check on a remote project', () => {
	it('against a healthy server: every line ok, with the plain-HTTP warning because the address is not loopback', async () => {
		const s = await server({ withSink: true, config: { terminalStatuses: [] } });
		// The address says "localhost-ish": loopback, so no security warning here.
		const result = await checkStrategy(target(configFor(s.server.url)));

		expect(result.ok).toBe(true);
		expect(result.lines.map(l => [l.name, l.status])).toEqual([
			['config', 'ok'],
			['strategy', 'ok'],
			['token', 'ok'],
			['reachable', 'ok'],
			['auth', 'ok'],
			['protocol', 'ok'],
			['project', 'ok'],
			['capabilities', 'ok'],
			['statuses', 'ok'],
			['events', 'ok'],
			['server-token', 'ok'],
		]);
		expect(line(result.lines, 'reachable')!.text).toMatch(
			/^enabled: the server answers \(GET \/v1\/info, \d+ ms, http:\/\/127\.0\.0\.1:\d+\)$/
		);
		expect(line(result.lines, 'auth')!.text).toBe('enabled: the server accepts the token');
		expect(line(result.lines, 'server-token')!.text).toBe(
			'not tested (not asked: only task serve knows its token; it refuses to start with a short one); needs server: at least 16 characters, no spaces; a token file is absolute and mode 600 on POSIX: the token of the server is strong enough'
		);
		expect(line(result.lines, 'project')!.text).toContain('"served" (ab12cd34)');
		expect(result.warnings).toBe(0);
	});

	it('names a project that the config expects and the server does not serve, with the fix', async () => {
		const s = await server();

		const result = await checkStrategy(target(configFor(s.server.url, '        project: warehouse\n')));

		expect(result.ok).toBe(false);
		expect(line(result.lines, 'project')).toMatchObject({ status: 'error' });
		expect(line(result.lines, 'project')!.fix).toContain('warehouse');
	});

	it("refuses the statuses of a client that differ from the server's, before a write fails on them", async () => {
		const s = await server();
		const clientConfig = `${configFor(s.server.url)}statuses:\n    - name: todo\n      default: true\n    - name: finished\n      terminal: true\n`;

		const result = await checkStrategy(target(clientConfig));

		expect(line(result.lines, 'statuses')).toMatchObject({ status: 'error' });
		expect(line(result.lines, 'statuses')!.text).toContain('todo, finished');
		expect(line(result.lines, 'statuses')!.text).toContain('backlog, in-progress, done');
	});

	it('a wrong token, a stopped server and a missing variable each stop the check at the line that explains it', async () => {
		const s = await server();

		const wrong = await checkStrategy(
			target(configFor(s.server.url), { env: { TASK_REMOTE_TOKEN: 'wrong-wrong-wrong-wrong' } })
		);
		const missing = await checkStrategy(target(configFor(s.server.url), { env: {} }));
		await s.server.close();
		const gone = await checkStrategy(target(configFor(s.server.url)));

		expect(line(wrong.lines, 'auth')).toMatchObject({ status: 'error' });
		expect(line(wrong.lines, 'auth')!.fix).toContain('task serve was started with');
		expect(line(wrong.lines, 'auth')!.text).toMatch(
			/^disabled \(refused by the server\): the server accepts the token: /
		);
		expect(line(gone.lines, 'reachable')!.text).toMatch(/^disabled \(no answer\): the server answers: /);
		expect(line(missing.lines, 'token')).toMatchObject({ status: 'error' });
		expect(line(missing.lines, 'backend')!.fix).toContain('export TASK_REMOTE_TOKEN');
		expect(line(gone.lines, 'reachable')).toMatchObject({ status: 'error' });
		expect(line(gone.lines, 'reachable')!.fix).toContain('task serve');
		for (const result of [wrong, missing, gone]) expect(result.ok).toBe(false);
	});

	it('warns on plain HTTP to a non-loopback host (the generic security line), and the unreachable address is a line too', async () => {
		const result = await checkStrategy(target(configFor('http://192.0.2.1:7788', '', 0.3)));

		expect(line(result.lines, 'security')).toMatchObject({ status: 'warn' });
		expect(line(result.lines, 'security')!.text).toContain('plain HTTP to a non-loopback host');
	});
});

describe('checkRemote: the lines that need a scripted server', () => {
	const facts: ProjectFacts = {
		statuses: [
			{ name: 'backlog', terminal: false, default: true, outcome: undefined },
			{ name: 'done', terminal: true, default: false, outcome: 'positive' },
		],
		types: [],
	};

	function info(overrides: Partial<ServerInfo> = {}): ServerInfo {
		return {
			protocol: { version: 1, min: 1, max: 1 },
			server: { name: 'task-serve', version: '1.2.3' },
			project: { id: 'ab12cd34', name: 'served' },
			capabilities: REMOTE_CAPABILITIES,
			statuses: ['backlog', 'done'],
			terminalStatuses: ['done'],
			types: [],
			events: { enabled: true },
			...overrides,
		};
	}

	function run(served: ServerInfo, extra: { clock?: number[]; expectedProject?: string } = {}) {
		const clock = [...(extra.clock ?? [0, 5])];
		return checkRemote({
			info: () => Promise.resolve(served),
			url: 'http://nas.lan:7788',
			expectedProject: extra.expectedProject,
			facts,
			now: () => clock.shift() ?? 0,
		});
	}

	it('warns about a slow link with the number of milliseconds', async () => {
		const lines = await run(info(), { clock: [0, 900] });

		expect(line(lines, 'reachable')).toMatchObject({ status: 'warn' });
		expect(line(lines, 'reachable')!.text).toContain('900 ms');
	});

	it('warns when the terminal statuses differ and when the server raises no event', async () => {
		const lines = await run(info({ terminalStatuses: [], events: { enabled: false } }));

		expect(line(lines, 'statuses')).toMatchObject({ status: 'warn' });
		expect(line(lines, 'events')).toMatchObject({ status: 'warn' });
	});

	it('warns when the server declares capabilities that a local project does not have, and errors on types this machine allows and the server refuses', async () => {
		const lines = await run(info({ capabilities: { ...REMOTE_CAPABILITIES, delete: 'no' }, types: ['bug'] }));
		const withTypes = await checkRemote({
			info: () => Promise.resolve(info({ types: ['bug'] })),
			url: 'http://nas.lan:7788',
			expectedProject: undefined,
			facts: { ...facts, types: ['bug', 'epic'] },
			now: () => 0,
		});

		expect(line(lines, 'capabilities')).toMatchObject({ status: 'warn' });
		expect(line(lines, 'capabilities')!.text).toContain('delete: "no"');
		expect(line(lines, 'types')).toMatchObject({ status: 'warn' });
		expect(line(withTypes, 'types')).toMatchObject({ status: 'error' });
		expect(line(withTypes, 'types')!.text).toContain('epic');
	});

	it('errors when the server speaks only other protocols, naming both ranges and the machine to update', async () => {
		const lines = await run(info({ protocol: { version: 2, min: 2, max: 3 } }));

		expect(line(lines, 'protocol')).toMatchObject({ status: 'error' });
		expect(line(lines, 'protocol')!.text).toContain('2..3');
		expect(line(lines, 'protocol')!.text).toMatch(/^disabled \(server speaks 2..3, this task speaks 1\): /);
		expect(line(lines, 'protocol')!.fix).toContain('Update task on this machine');
	});
});
