import { describe, expect, it } from 'vitest';

import { createBuiltinRegistry } from '../builtinPlugins.js';
import { remoteLocation } from '../remote/remotePlugin.js';
import { createMachinePlugin, parseMachineOptions } from './machinePlugin.js';
import type { MachineRunner } from './machineRunner.js';

const SLOT = { slot: 'strategy.options.transport' };
const NO_RUN: MachineRunner = { run: () => Promise.reject(new Error('no run expected')) };

describe('the options of the machine transport', () => {
	it('peer and project are required; the rest has defaults', () => {
		expect(parseMachineOptions({})).toEqual({ problem: expect.stringContaining('peer: required') });
		expect(parseMachineOptions({ peer: 'thinkcentre' })).toEqual({ problem: expect.stringContaining('project: required') });
		expect(parseMachineOptions({ peer: 'thinkcentre', project: 'shop' })).toEqual({
			settings: { peer: 'thinkcentre', project: 'shop', wake: 'auto', timeoutSeconds: 60 },
		});
	});

	it('takes wake, shell and a time limit', () => {
		expect(
			parseMachineOptions({ peer: 'p', project: 'shop', wake: 'never', shell: 'sh', timeoutSeconds: 30 })
		).toEqual({ settings: { peer: 'p', project: 'shop', wake: 'never', shell: 'sh', timeoutSeconds: 30 } });
	});

	it.each([
		[{ peer: 'p', project: 'shop', token: 'x' }, 'token: unknown option for transport "machine"'],
		[{ peer: 'a b', project: 'shop' }, 'peer:'],
		[{ peer: '--shell', project: 'shop' }, 'peer:'],
		[{ peer: 'p', project: 'shop;x' }, 'project: "shop;x" cannot be put in a command line'],
		[{ peer: 'p', project: 'my shop' }, 'project:'],
		[{ peer: 'p', project: 'shop', wake: 'sometimes' }, 'wake: must be "auto" or "never"'],
		[{ peer: 'p', project: 'shop', shell: 'zsh' }, 'shell: must be one of cmd, ps, bash, sh'],
		[{ peer: 'p', project: 'shop', timeoutSeconds: 0 }, 'timeoutSeconds:'],
		[{ peer: 'p', project: 'shop', timeoutSeconds: 100000 }, 'timeoutSeconds:'],
	])('%j is refused with a sentence that starts with the key', (options, start) => {
		const parsed = parseMachineOptions(options);

		expect(parsed).toHaveProperty('problem');
		expect((parsed as { problem: string }).problem).toContain(start);
	});
});

describe('the plugin', () => {
	it('validates like the parser, creates a transport without running anything, and describes itself', async () => {
		const plugin = createMachinePlugin(NO_RUN);

		expect(plugin.validate({ peer: 'p' }, SLOT)).toContain('project: required');
		expect(plugin.validate({ peer: 'p', project: 'shop' }, SLOT)).toBeUndefined();
		const transport = await plugin.create({ peer: 'p', project: 'shop' }, { env: {} });
		expect(transport.baseUrl).toBe('machine://p/shop');
		expect(plugin.describe().snippet).toContain('type: machine');
	});

	it('refuses to create with a bad option', async () => {
		await expect(createMachinePlugin(NO_RUN).create({ peer: 'p', project: 'a;b' }, { env: {} })).rejects.toThrow('project:');
	});

	it('is registered as a built-in transport under the alias machine', () => {
		const registry = createBuiltinRegistry();

		expect(registry.list('transport').map(entry => entry.aliases[0])).toEqual(expect.arrayContaining(['plain-http', 'machine']));
	});
});

describe('the location of a project on a peer (two projects on one storage are refused by migrate)', () => {
	it('is the peer and the project, lowercased', () => {
		expect(
			remoteLocation({ transport: { type: 'machine', options: { peer: 'ThinkCentre', project: 'Shop' } } })
		).toBe('remote machine://thinkcentre/shop');
	});
});
