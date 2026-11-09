import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { openResolvedProject, resolveProject, startTaskServer, TaskServerStartError } from '@wadeck-app/task-service';
import type { EventSink, RunningTaskServer, TaskServiceContext, TaskServerOptions } from '@wadeck-app/task-service';

import { registerTestProject } from '../testHelpers.js';
import type { RegisteredTestProject } from '../testHelpers.js';
import { isServeHelp, parseServeArgs, runServe, SERVE_DEFAULT_PORT } from './ServeCommand.js';
import type { ServeDeps } from './ServeCommand.js';

const TOKEN = 'serve-cli-token-0123456789';

let tmpDir: string;
let project: RegisteredTestProject;
let out: string[];
let warnings: string[];
let abort: AbortController;

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-serve-'));
	project = await registerTestProject(path.join(tmpDir, 'shop'));
	out = [];
	warnings = [];
	abort = new AbortController();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctxOf(registered: RegisteredTestProject = project): TaskServiceContext {
	return openResolvedProject(resolveProject({ cwd: registered.dir, projectRef: registered.id }));
}

function deps(overrides: Partial<ServeDeps> = {}): ServeDeps {
	return {
		ctx: ctxOf(),
		env: { TASK_SERVE_TOKEN: TOKEN },
		makeSink: () => ({ deliver: () => Promise.resolve({ delivered: true }) }),
		out: text => out.push(text),
		warn: text => warnings.push(text),
		stop: abort.signal,
		version: '2026.11.09-001',
		log: () => undefined,
		...overrides,
	};
}

/** Runs the command until `ready` says it listens, then stops it; returns the result. */
async function serveBriefly(rest: string[], overrides: Partial<ServeDeps> = {}, jsonMode = false) {
	const started: { options?: TaskServerOptions; server?: RunningTaskServer } = {};
	const result = runServe(rest, jsonMode, {
		...deps(overrides),
		start: async options => {
			started.options = options;
			started.server = await startTaskServer({ ...options, failedAuthDelayMs: 0 });
			queueMicrotask(() => abort.abort());
			return started.server;
		},
	});
	return { result: await result, started };
}

describe('parseServeArgs', () => {
	it('defaults to loopback, port 7788, the TASK_SERVE_TOKEN variable, no LAN', () => {
		expect(parseServeArgs([])).toEqual({
			host: '127.0.0.1',
			port: SERVE_DEFAULT_PORT,
			allowLan: false,
			tokenEnv: undefined,
			tokenFile: undefined,
		});
		expect(SERVE_DEFAULT_PORT).toBe(7788);
	});

	it('reads every option, with a space or an equal sign', () => {
		expect(
			parseServeArgs(['--port', '0', '--host', 'nas.lan', '--allow-lan', '--token-env', 'MY_TOKEN'])
		).toMatchObject({ port: 0, host: 'nas.lan', allowLan: true, tokenEnv: 'MY_TOKEN' });
		expect(parseServeArgs(['--port=8080', '--host=127.0.0.1', '--token-file=/etc/task-token'])).toMatchObject({
			port: 8080,
			host: '127.0.0.1',
			tokenFile: '/etc/task-token',
		});
	});

	it.each([
		[['--port', 'abc'], '--port must be a whole number from 0 to 65535, found "abc"'],
		[['--port', '70000'], '--port must be a whole number from 0 to 65535, found "70000"'],
		[['--port'], '--port needs a value'],
		[['--host'], '--host needs a value'],
		[['--token-env'], '--token-env needs a value'],
		[['--token-file'], '--token-file needs a value'],
		[['--bogus'], 'unknown option: --bogus'],
		[['shop'], 'unexpected argument: shop'],
		[['--token', 'abc'], 'unknown option: --token'],
	])('refuses %j', (rest, message) => {
		const parsed = parseServeArgs(rest);

		expect('exitCode' in parsed && parsed.exitCode).toBe(1);
		expect('output' in parsed && parsed.output).toContain(message);
	});

	it('a token on the command line is refused with the reason (process list, shell history) and the safe ways', () => {
		const parsed = parseServeArgs(['--token', 'abc']);

		expect('output' in parsed && parsed.output).toContain('unknown option: --token');
		expect('output' in parsed && parsed.output).toContain('--token-env');
		expect('output' in parsed && parsed.output).toContain('--token-file');
	});

	it('serve --help is answered without a project', () => {
		expect(isServeHelp(['--help'])).toBe(true);
		expect(isServeHelp([])).toBe(false);
	});
});

describe('the bind address', () => {
	it.each(['0.0.0.0', '::', '192.168.1.5', 'nas.lan', '10.0.0.2'])(
		'refuses %s without --allow-lan, saying why and what to do, and starts nothing',
		async host => {
			const start = vi.fn();

			const result = await runServe(['--host', host], false, { ...deps(), start });

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`refusing to listen on ${host}`);
			expect(result.output).toContain('plain HTTP');
			expect(result.output).toContain('--allow-lan');
			expect(result.output).toContain('trusted');
			expect(start).not.toHaveBeenCalled();
			expect(out).toEqual([]);
		}
	);

	it.each(['127.0.0.1', '127.8.8.8', 'localhost', '::1', '[::1]'])(
		'%s is loopback: no flag needed, no warning',
		async host => {
			const { result, started } = await serveBriefly(['--host', host, '--port', '0']);

			expect(result.exitCode, result.output).toBe(0);
			expect(started.options?.host).toBe(host.replace(/^\[|\]$/g, ''));
			expect(warnings.join('')).not.toMatch(/WARNING/);
		}
	);

	it('with --allow-lan a non-loopback host starts, after a loud warning that this is plain HTTP on a trusted LAN', async () => {
		const start = vi.fn(() =>
			Promise.resolve({
				url: 'http://192.168.1.5:7788',
				host: '192.168.1.5',
				port: 7788,
				failedAuthCount: () => 0,
				close: () => Promise.resolve(),
			})
		);
		queueMicrotask(() => abort.abort());

		const result = await runServe(['--host', '192.168.1.5', '--allow-lan'], false, { ...deps(), start });

		expect(result.exitCode, result.output).toBe(0);
		expect(start).toHaveBeenCalledWith(expect.objectContaining({ host: '192.168.1.5', port: 7788 }));
		const warning = warnings.join('');
		expect(warning).toContain('WARNING');
		expect(warning).toContain('plain HTTP');
		expect(warning).toContain('192.168.1.5:7788');
		expect(warning).toContain('readable by anyone on that network');
		expect(warning).toContain('trusted LAN only');
		expect(warning).not.toContain(TOKEN);
		// The warning comes BEFORE the "listening" lines.
		expect(out.join('\n')).toContain('listening');
	});

	it('the warning is on stderr in JSON mode too, while stdout holds only the JSON line', async () => {
		const start = vi.fn(() =>
			Promise.resolve({
				url: 'http://0.0.0.0:7788',
				host: '0.0.0.0',
				port: 7788,
				failedAuthCount: () => 0,
				close: () => Promise.resolve(),
			})
		);
		queueMicrotask(() => abort.abort());

		await runServe(['--host', '0.0.0.0', '--allow-lan'], true, { ...deps(), start });

		expect(warnings.join('')).toContain('WARNING');
		expect(out).toHaveLength(1);
		expect(JSON.parse(out[0]!)).toMatchObject({ listening: true, lan: true, host: '0.0.0.0' });
	});
});

describe('the token', () => {
	it('no token is a refusal with how to make one, and nothing starts', async () => {
		const start = vi.fn();

		const result = await runServe([], false, { ...deps({ env: {} }), start });

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('no token: the environment variable TASK_SERVE_TOKEN is not set');
		expect(result.output).toContain('randomBytes(32)');
		expect(start).not.toHaveBeenCalled();
	});

	it('a token that is too short is refused without being printed', async () => {
		const result = await runServe([], false, { ...deps({ env: { TASK_SERVE_TOKEN: 'secret' } }), start: vi.fn() });

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('too short');
		expect(result.output).not.toContain('secret');
	});

	it('--token-env names another variable, --token-file a file; the token is never printed, only where it came from', async () => {
		const file = path.join(tmpDir, 'token');
		fs.writeFileSync(file, TOKEN);

		const viaEnv = await serveBriefly(['--port', '0', '--token-env', 'OTHER'], { env: { OTHER: TOKEN } });
		abort = new AbortController();
		out = [];
		const viaFile = await serveBriefly(['--port', '0', '--token-file', file]);

		expect(viaEnv.result.exitCode).toBe(0);
		expect(viaFile.result.exitCode, viaFile.result.output).toBe(0);
		expect(viaEnv.started.options?.token).toBe(TOKEN);
		expect(out.join('\n')).toContain(`the file ${file}`);
		expect(out.join('\n')).not.toContain(TOKEN);
		expect(warnings.join('\n')).not.toContain(TOKEN);
	});
});

describe('starting and stopping', () => {
	it('prints the address, the protocol, the project, where the token comes from and how to stop; the server answers while it runs', async () => {
		let answer: Response | undefined;
		const result = await runServe(['--port', '0'], false, {
			...deps(),
			start: async options => {
				const server = await startTaskServer({ ...options, failedAuthDelayMs: 0 });
				setTimeout(() => {
					void fetch(`${server.url}/v1/info`, {
						headers: { Authorization: `Bearer ${TOKEN}`, 'X-Task-Protocol': '1' },
					}).then(response => {
						answer = response;
						abort.abort();
					});
				}, 10);
				return server;
			},
		});

		const text = out.join('\n');
		expect(result.exitCode, result.output).toBe(0);
		expect(answer?.status).toBe(200);
		expect(text).toContain(`task serve: project ${project.name} (${project.id})`);
		expect(text).toMatch(/listening\s+http:\/\/127\.0\.0\.1:\d+/);
		expect(text).toMatch(/protocol\s+1/);
		expect(text).toMatch(/auth\s+bearer token from the environment variable TASK_SERVE_TOKEN/);
		expect(text).toMatch(/events\s+raised by this server/);
		expect(text).toMatch(/stop\s+Ctrl\+C/);
		expect(text).not.toContain(TOKEN);
		expect(result.output).toContain('stopped');
	});

	it('--json prints one JSON line when it listens, with everything a script needs', async () => {
		await serveBriefly(['--port', '0'], {}, true);

		expect(out).toHaveLength(1);
		expect(JSON.parse(out[0]!)).toMatchObject({
			listening: true,
			url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
			host: '127.0.0.1',
			port: expect.any(Number),
			lan: false,
			protocol: 1,
			project: { id: project.id, name: project.name },
			auth: { kind: 'env', name: 'TASK_SERVE_TOKEN' },
		});
		expect(out[0]).not.toContain(TOKEN);
	});

	it('stops when asked and closes the server (graceful)', async () => {
		const closed = vi.fn();
		const start = vi.fn(async (options: TaskServerOptions) => {
			const server = await startTaskServer({ ...options, failedAuthDelayMs: 0 });
			return {
				...server,
				close: async () => {
					closed();
					await server.close();
				},
			};
		});
		queueMicrotask(() => abort.abort());

		const result = await runServe(['--port', '0'], false, { ...deps(), start });

		expect(result.exitCode).toBe(0);
		expect(closed).toHaveBeenCalledTimes(1);
	});

	it('a port that is taken is exit 1 with the fix', async () => {
		const first = await startTaskServer({ ctx: ctxOf(), token: TOKEN, failedAuthDelayMs: 0 });
		try {
			const result = await runServe(['--port', String(first.port)], false, deps());

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain('already in use');
			expect(result.output).toContain('--port');
		} finally {
			await first.close();
		}
	});

	it('refuses to serve a project that is not stored locally, naming the strategy and the fix', async () => {
		const ctx = ctxOf();
		const forge = {
			...ctx,
			store: new Proxy(ctx.store, { get: (t, p, r) => (p === 'kind' ? 'remote' : Reflect.get(t, p, r)) }),
		} as TaskServiceContext;

		const result = await runServe(['--port', '0'], false, deps({ ctx: forge }));

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('uses the remote strategy');
		expect(result.output).toContain('Chaining');
	});

	it('JSON errors are {error, hint}', async () => {
		const result = await runServe(['--host', '0.0.0.0'], true, { ...deps(), start: vi.fn() });

		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.output)).toMatchObject({
			error: expect.stringContaining('refusing to listen'),
			hint: expect.any(String),
		});
	});

	it('hands the server the queue sink of this process, so the changes made through it raise the events of THIS machine', async () => {
		const sink: EventSink = { deliver: () => Promise.resolve({ delivered: true }) };

		const { started } = await serveBriefly(['--port', '0'], { makeSink: () => sink });

		expect(started.options?.eventSink).toBe(sink);
		expect(started.options?.version).toBe('2026.11.09-001');
	});
});

describe('TaskServerStartError is what the dispatcher prints', () => {
	it('carries a hint', () => {
		expect(new TaskServerStartError('m', 'h').hint).toBe('h');
	});
});
