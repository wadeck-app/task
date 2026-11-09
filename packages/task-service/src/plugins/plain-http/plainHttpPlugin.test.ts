import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	RemoteTimeoutError,
	RemoteUnauthorizedError,
	RemoteUnreachableError,
	BackendTimeoutError,
	BackendUnreachableError,
} from '@wadeck-app/task-core';

import type { TransportInstance } from '../kinds.js';
import { plainHttpPlugin } from './plainHttpPlugin.js';
import { resolveToken } from './transportToken.js';

const OK = { url: 'http://nas.lan:7788', tokenEnv: 'TASK_REMOTE_TOKEN' };
const TOKEN = 'transport-token-0123456789';

function problem(options: Record<string, unknown>): string | undefined {
	return plainHttpPlugin.validate(options, { slot: 'strategy.options.transport' });
}

describe('the plain-http transport plugin: option validation', () => {
	it('accepts the documented options', () => {
		expect(problem(OK)).toBeUndefined();
		expect(problem({ ...OK, timeoutSeconds: 5 })).toBeUndefined();
		expect(problem({ ...OK, timeoutSeconds: 0.5 })).toBeUndefined();
		expect(problem({ ...OK, url: 'https://tasks.example.org/base' })).toBeUndefined();
		expect(problem({ url: OK.url, tokenFile: '/etc/task/token' })).toBeUndefined();
		expect(problem({ url: OK.url, tokenFile: '~/.task-token' })).toBeUndefined();
	});

	it.each([
		[
			{ ...OK, urll: 'x' },
			'urll: unknown option for transport "plain-http" (known: url, tokenEnv, tokenFile, timeoutSeconds)',
		],
		[{ tokenEnv: 'T' }, 'url: required (the address of the task server, for example http://nas.lan:7788)'],
		[{ url: '', tokenEnv: 'T' }, 'url: required (the address of the task server, for example http://nas.lan:7788)'],
		[{ url: 3, tokenEnv: 'T' }, 'url: must be a string, found 3'],
		[{ url: 'nas.lan:7788', tokenEnv: 'T' }, 'url: "nas.lan:7788" is not an http:// or https:// address'],
		[{ url: 'ftp://nas.lan', tokenEnv: 'T' }, 'url: "ftp://nas.lan" is not an http:// or https:// address'],
		[
			{ url: 'http://user:pw@nas.lan', tokenEnv: 'T' },
			'url: must not contain credentials; the token is read from the environment variable named by tokenEnv (or the file named by tokenFile)',
		],
		[
			{ url: OK.url },
			'tokenEnv: required (the NAME of the environment variable that holds the token, not the token; or tokenFile: the path of a file that holds it)',
		],
		[
			{ url: OK.url, tokenEnv: 'my token' },
			'tokenEnv: "my token" is not an environment variable name (letters, digits and underscores, not starting with a digit); it must be the NAME of the variable, never the token',
		],
		[{ ...OK, tokenFile: '/x' }, 'tokenFile: give either tokenEnv or tokenFile, not both'],
		[{ url: OK.url, tokenFile: '' }, 'tokenFile: must be the path of a file, found ""'],
		[{ ...OK, timeoutSeconds: 0 }, 'timeoutSeconds: must be a positive number of seconds, found 0'],
		[{ ...OK, timeoutSeconds: '10' }, 'timeoutSeconds: must be a positive number of seconds, found "10"'],
	])('refuses %j with a message naming the option', (options, expected) => {
		expect(problem(options)).toBe(expected);
	});

	it('is the transport kind and documents all its options', () => {
		expect(plainHttpPlugin.extensionPoint).toBe('transport');
		expect(Object.keys(plainHttpPlugin.describe().options)).toEqual([
			'url',
			'tokenEnv',
			'tokenFile',
			'timeoutSeconds',
		]);
		expect(plainHttpPlugin.describe().summary).not.toMatch(/not implemented/i);
	});
});

describe('resolveToken', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('reads a variable and a file, trimmed', () => {
		const file = path.join(dir, 'token');
		fs.writeFileSync(file, `  ${TOKEN}\n`);

		expect(resolveToken({ kind: 'env', name: 'T' }, { T: ` ${TOKEN} ` })).toBe(TOKEN);
		expect(resolveToken({ kind: 'file', path: file }, {}, { platform: 'win32' })).toBe(TOKEN);
	});

	it('an unset variable is a RemoteUnauthorizedError that names the variable and how to set it', () => {
		const error = (() => {
			try {
				resolveToken({ kind: 'env', name: 'TASK_REMOTE_TOKEN' }, {});
			} catch (e) {
				return e as RemoteUnauthorizedError;
			}
			throw new Error('expected a refusal');
		})();

		expect(error).toBeInstanceOf(RemoteUnauthorizedError);
		expect(error.reason).toBe('missing');
		expect(error.message).toContain('TASK_REMOTE_TOKEN is not set');
		expect(error.hint).toContain('export TASK_REMOTE_TOKEN=<token>');
		expect(error.hint).toContain('setx TASK_REMOTE_TOKEN');
	});

	it.each([
		['a relative path', () => 'token', 'not an absolute path'],
		['a missing file', (dir: string) => path.join(dir, 'absent'), 'cannot be read'],
		[
			'an empty file',
			(dir: string) => {
				const f = path.join(dir, 'empty');
				fs.writeFileSync(f, ' \n');
				return f;
			},
			'is empty',
		],
		[
			'a file with two words',
			(dir: string) => {
				const f = path.join(dir, 'two');
				fs.writeFileSync(f, 'a b');
				return f;
			},
			'not a token',
		],
	])('refuses %s', (_name, make, expected) => {
		const file = make(dir);

		expect(() => resolveToken({ kind: 'file', path: file }, {}, { platform: 'win32' })).toThrow(expected);
	});

	it('refuses a token file other users can read (POSIX), with the command that fixes it', () => {
		const file = path.join(dir, 'open');
		fs.writeFileSync(file, TOKEN);

		expect(() => resolveToken({ kind: 'file', path: file }, {}, { platform: 'linux', mode: () => 0o644 })).toThrow(
			/readable by other users \(mode 644\)/
		);
		expect(() =>
			resolveToken({ kind: 'file', path: file }, {}, { platform: 'linux', mode: () => 0o600 })
		).not.toThrow();
	});
});

// ---- the instance, against a real server ----

interface Seen {
	method: string;
	url: string;
	headers: http.IncomingHttpHeaders;
	body: string;
}

const servers: http.Server[] = [];
const instances: TransportInstance[] = [];

afterEach(async () => {
	for (const instance of instances.splice(0)) await instance.dispose();
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

async function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void) {
	const requests: Seen[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', chunk => chunks.push(chunk as Buffer));
		req.on('end', () => {
			const seen = {
				method: req.method ?? '',
				url: req.url ?? '',
				headers: req.headers,
				body: Buffer.concat(chunks).toString(),
			};
			requests.push(seen);
			handler(req, res, seen);
		});
	});
	servers.push(server);
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

async function open(
	options: Record<string, unknown>,
	context: Partial<Parameters<typeof plainHttpPlugin.create>[1]> = {}
) {
	const instance = await plainHttpPlugin.create({ tokenEnv: 'T', ...options }, { env: { T: TOKEN }, ...context });
	instances.push(instance);
	return instance;
}

describe('the plain-http transport: requests', () => {
	it("sends the bearer token and the protocol version on every request, keeps the caller's headers, and returns status, headers and body", async () => {
		const server = await listen((_req, res) => {
			res.writeHead(201, { 'Content-Type': 'application/json', 'X-Custom': 'yes' });
			res.end('{"ok":true}');
		});
		const transport = await open({ url: server.url });

		const response = await transport.fetch('/v1/tasks', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'If-Match': '"r1"' },
			body: '{"a":1}',
		});

		expect(response.status).toBe(201);
		expect(response.headers.get('x-custom')).toBe('yes');
		expect(await response.json()).toEqual({ ok: true });
		expect(server.requests).toHaveLength(1);
		expect(server.requests[0]).toMatchObject({ method: 'POST', url: '/v1/tasks', body: '{"a":1}' });
		expect(server.requests[0]!.headers['authorization']).toBe(`Bearer ${TOKEN}`);
		expect(server.requests[0]!.headers['x-task-protocol']).toBe('1');
		expect(server.requests[0]!.headers['if-match']).toBe('"r1"');
	});

	it('joins a base path with the request path, whatever the trailing slash', async () => {
		const server = await listen((_req, res) => res.end('{}'));
		const transport = await open({ url: `${server.url}/tasks/` });

		await transport.fetch('/v1/info');

		expect(transport.baseUrl).toBe(`${server.url}/tasks`);
		expect(server.requests[0]!.url).toBe('/tasks/v1/info');
	});

	it('describes itself without the token: url, timeout, where the token comes from', async () => {
		const transport = await open({ url: 'http://nas.lan:7788', timeoutSeconds: 3 });

		const lines = transport.describe();

		expect(lines).toContain('url: http://nas.lan:7788');
		expect(lines.join('\n')).toContain('timeout: 3 s');
		expect(lines.join('\n')).toContain('the environment variable T');
		expect(lines.join('\n')).not.toContain(TOKEN);
	});

	it('does not follow a redirect (the token would travel to another host) and says where it pointed', async () => {
		const elsewhere = await listen((_req, res) => res.end('{}'));
		const server = await listen((_req, res) => {
			res.writeHead(302, { Location: `${elsewhere.url}/v1/info` });
			res.end();
		});
		const transport = await open({ url: server.url });

		const error = await transport.fetch('/v1/info').catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RemoteUnreachableError);
		expect((error as Error).message).toContain('redirect');
		expect((error as Error).message).toContain(elsewhere.url);
		expect(elsewhere.requests).toEqual([]);
	});
});

describe('the plain-http transport: failures', () => {
	it('a server that is not there is a RemoteUnreachableError with the host, the cause and the way to look', async () => {
		const closed = await listen(() => undefined);
		const port = new URL(closed.url).port;
		for (const server of servers.splice(0)) {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
		const transport = await open({ url: `http://127.0.0.1:${port}` });

		const error = await transport.fetch('/v1/info').catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RemoteUnreachableError);
		expect(error).toBeInstanceOf(BackendUnreachableError);
		expect((error as RemoteUnreachableError).message).toContain(`127.0.0.1:${port}`);
		expect((error as RemoteUnreachableError).message).toMatch(/ECONNREFUSED/);
		expect((error as RemoteUnreachableError).hint).toContain('task serve');
	});

	it('names the cause code of a network failure (DNS, reset)', async () => {
		const failing = (code: string): typeof fetch =>
			(() =>
				Promise.reject(
					new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code }) })
				)) as typeof fetch;

		const dns = await (
			await open({ url: 'http://nas.lan:7788' }, { fetch: failing('ENOTFOUND') })
		)
			.fetch('/v1/info')
			.catch((e: unknown) => e);
		const reset = await (
			await open({ url: 'http://nas.lan:7788' }, { fetch: failing('ECONNRESET') })
		)
			.fetch('/v1/info')
			.catch((e: unknown) => e);

		expect((dns as Error).message).toContain('ENOTFOUND');
		expect((reset as Error).message).toContain('ECONNRESET');
	});

	it('a server that does not answer in time is a RemoteTimeoutError; a read can be repeated, a write may have been applied', async () => {
		const server = await listen(() => undefined);
		const transport = await open({ url: server.url, timeoutSeconds: 0.1 });

		const read = await transport.fetch('/v1/tasks').catch((e: unknown) => e);
		const write = await transport.fetch('/v1/tasks', { method: 'POST', body: '{}' }).catch((e: unknown) => e);

		expect(read).toBeInstanceOf(RemoteTimeoutError);
		expect(read).toBeInstanceOf(BackendTimeoutError);
		expect((read as RemoteTimeoutError).hint).not.toMatch(/may have been applied/);
		expect((write as RemoteTimeoutError).hint).toMatch(/may have been applied/);
	});

	it('the time limit covers the whole exchange: a body that stalls after the headers also times out', async () => {
		const server = await listen((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.write('{"partial":');
		});
		const transport = await open({ url: server.url, timeoutSeconds: 0.1 });

		const error = await transport.fetch('/v1/tasks').catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RemoteTimeoutError);
	});

	it('uses the injected timer: the limit fires when the timer does, not by the wall clock', async () => {
		const fired: Array<() => void> = [];
		const cleared: unknown[] = [];
		const hanging = ((_url: string, init: RequestInit) =>
			new Promise((_resolve, reject) => {
				init.signal!.addEventListener('abort', () =>
					reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
				);
			})) as unknown as typeof fetch;
		const transport = await open(
			{ url: 'http://nas.lan:7788', timeoutSeconds: 10 },
			{
				fetch: hanging,
				timers: {
					setTimeout: ((callback: () => void) => {
						fired.push(callback);
						return fired.length;
					}) as unknown as typeof setTimeout,
					clearTimeout: (handle => cleared.push(handle)) as typeof clearTimeout,
				},
			}
		);

		const pending = transport.fetch('/v1/info').catch((e: unknown) => e);
		expect(fired).toHaveLength(1);
		fired[0]!();
		const error = await pending;

		expect(error).toBeInstanceOf(RemoteTimeoutError);
		expect((error as Error).message).toContain('did not answer within 10 s');
	});

	it('disposing aborts what is in flight and refuses what comes next', async () => {
		const server = await listen(() => undefined);
		const transport = await open({ url: server.url, timeoutSeconds: 30 });

		const pending = transport.fetch('/v1/tasks').catch((e: unknown) => e);
		await new Promise(resolve => setTimeout(resolve, 30));
		await transport.dispose();
		const error = await pending;
		const later = await transport.fetch('/v1/tasks').catch((e: unknown) => e);

		expect(error).toBeInstanceOf(Error);
		expect(later).toBeInstanceOf(Error);
		expect((later as Error).message).toContain('closed');
	});

	it('opening without a token fails with the RemoteUnauthorizedError of resolveToken, before any request', async () => {
		const error = await plainHttpPlugin.create(OK, { env: {} }).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RemoteUnauthorizedError);
		expect((error as RemoteUnauthorizedError).hint).toContain('export TASK_REMOTE_TOKEN');
	});
});
