import { PluginNotImplementedError } from '../kinds.js';
import { plainHttpPlugin } from './plainHttpPlugin.js';

const OK = { url: 'http://nas.lan:7788', tokenEnv: 'TASK_REMOTE_TOKEN' };

function problem(options: Record<string, unknown>): string | undefined {
	return plainHttpPlugin.validate(options, { slot: 'strategy.options.transport' });
}

describe('the plain-http transport plugin: option validation', () => {
	it('accepts the documented options', () => {
		expect(problem(OK)).toBeUndefined();
		expect(problem({ ...OK, timeoutSeconds: 5 })).toBeUndefined();
		expect(problem({ ...OK, url: 'https://tasks.example.org/base' })).toBeUndefined();
	});

	it.each([
		[
			{ ...OK, urll: 'x' },
			'urll: unknown option for transport "plain-http" (known: url, tokenEnv, timeoutSeconds)',
		],
		[{ tokenEnv: 'T' }, 'url: required (the address of the task server, for example http://nas.lan:7788)'],
		[{ url: '', tokenEnv: 'T' }, 'url: required (the address of the task server, for example http://nas.lan:7788)'],
		[{ url: 3, tokenEnv: 'T' }, 'url: must be a string, found 3'],
		[{ url: 'nas.lan:7788', tokenEnv: 'T' }, 'url: "nas.lan:7788" is not an http:// or https:// address'],
		[{ url: 'ftp://nas.lan', tokenEnv: 'T' }, 'url: "ftp://nas.lan" is not an http:// or https:// address'],
		[
			{ url: 'http://user:pw@nas.lan', tokenEnv: 'T' },
			'url: must not contain credentials; the token is read from the environment variable named by tokenEnv',
		],
		[
			{ url: OK.url },
			'tokenEnv: required (the NAME of the environment variable that holds the token, not the token)',
		],
		[
			{ url: OK.url, tokenEnv: 'my token' },
			'tokenEnv: "my token" is not an environment variable name (letters, digits and underscores, not starting with a digit); it must be the NAME of the variable, never the token',
		],
		[{ ...OK, timeoutSeconds: 0 }, 'timeoutSeconds: must be a positive number of seconds, found 0'],
		[{ ...OK, timeoutSeconds: '10' }, 'timeoutSeconds: must be a positive number of seconds, found "10"'],
	])('refuses %j with a message naming the option', (options, expected) => {
		expect(problem(options)).toBe(expected);
	});
});

describe('the plain-http transport plugin: not implemented in this stage', () => {
	it('is the transport kind and documents its options', () => {
		expect(plainHttpPlugin.extensionPoint).toBe('transport');
		expect(Object.keys(plainHttpPlugin.describe().options)).toEqual(['url', 'tokenEnv', 'timeoutSeconds']);
	});

	it('opening it fails loudly with the stage that brings it', async () => {
		const error = await plainHttpPlugin.create(OK, { env: {} }).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(PluginNotImplementedError);
		expect((error as PluginNotImplementedError).message).toBe(
			'plugin "plugins.plain-http.default" is registered but not implemented in this version (it arrives in stage 4 of the storage design)'
		);
		expect((error as PluginNotImplementedError).hint).toMatch(/strategy: \{ type: local \}/);
	});
});
