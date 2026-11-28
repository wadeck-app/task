import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPluginRegistry } from '../../plugin-host/index.js';
import { checkStrategy } from '../../strategyCheck.js';
import { showStrategy } from '../../strategyReport.js';
import { createBuiltinRegistry } from '../builtinPlugins.js';
import type { TaskPluginKinds } from '../kinds.js';
import { remotePlugin } from '../remote/remotePlugin.js';
import { createMachinePlugin } from './machinePlugin.js';
import type { MachineCall, MachineRunner } from './machineRunner.js';

// A project config that says `transport: machine`, through the real resolution, `strategy show` and `strategy check`.
let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const CONFIG =
	'strategy:\n    type: remote\n    options:\n        transport:\n            type: machine\n            options:\n                peer: thinkcentre\n                project: shop\n';

function target(configYml: string, registry?: ReturnType<typeof createBuiltinRegistry>) {
	const configFile = path.join(root, 'config', 'config.yml');
	fs.mkdirSync(path.dirname(configFile), { recursive: true });
	fs.writeFileSync(configFile, configYml, 'utf8');
	return {
		storage: { dataDir: path.join(root, 'data'), configFiles: [configFile] },
		project: { id: 'b1b1b1b1', name: 'client', path: root },
		globalConfigDir: path.join(root, 'global'),
		env: {},
		...(registry === undefined ? {} : { registry }),
	};
}

describe('a project on the machine transport', () => {
	it('strategy show names the peer, the project, the command and the allow entry, and runs nothing', () => {
		const report = showStrategy(target(CONFIG));

		expect(report.kind).toBe('remote');
		expect(report.transport?.ref).toBe('plugins.machine.default');
		expect(report.transport?.options).toEqual({ peer: 'thinkcentre', project: 'shop' });
	});

	it('a bad option is a config error naming the key, before anything runs', async () => {
		const result = await checkStrategy(target(CONFIG.replace('project: shop', 'project: "a;b"')));

		expect(JSON.stringify(result.lines)).toContain('transport.options.project');
	});

	it('strategy check with the real runner says that machine has no stdin channel yet (PENDING), with the next step', async () => {
		const result = await checkStrategy(target(CONFIG));

		const text = JSON.stringify(result.lines);
		expect(text).toContain('this machine CLI has no stdin channel for run yet');
		expect(text).toContain('machine cli update');
	});

	it('strategy check with a peer that answers: one request (the info), the command allowed, nothing else asked', async () => {
		const calls: MachineCall[] = [];
		const runner: MachineRunner = {
			run(call) {
				calls.push(call);
				return Promise.resolve({
					kind: 'ran',
					exitCode: 0,
					stdout: JSON.stringify({
						status: 200,
						headers: { 'X-Task-Protocol': '2' },
						body: {
							protocol: { version: 2, min: 1, max: 2 },
							server: { name: 'task-serve', version: '1' },
							project: { id: 'ab12cd34', name: 'shop' },
							capabilities: {},
							events: { enabled: false },
						},
					}),
					stderr: '',
					timedOut: false,
					truncated: false,
				});
			},
		};
		const base = createBuiltinRegistry();
		const registry = createPluginRegistry<TaskPluginKinds>([
			{ ref: 'plugins.local.default', plugin: base.lookup('local', 'strategy'), aliases: ['local'] },
			{ ref: 'plugins.remote.default', plugin: remotePlugin, aliases: ['remote'] },
			{ ref: 'plugins.machine.default', plugin: createMachinePlugin(runner), aliases: ['machine'] },
		]);
		const spy = vi.spyOn(runner, 'run');

		await checkStrategy(target(CONFIG, registry as never));

		expect(spy).toHaveBeenCalledTimes(1);
		expect(calls[0]).toMatchObject({ peer: 'thinkcentre', command: 'task serve -p shop --stdio' });
		expect(JSON.parse(calls[0]!.stdin)).toMatchObject({ method: 'GET', path: '/v1/info' });
	});
});
