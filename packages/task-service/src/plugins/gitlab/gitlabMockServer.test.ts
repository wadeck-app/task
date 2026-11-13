// The logic of scripts/gitlab-mock-server.mjs, run in process (the script is a thin wrapper that wires the signals): usage errors, the
// printed instructions, a real start with a seeded project, a stop that closes the server. No file is written, no temp dir is made.
import { FakeGitLab } from './fakeGitLab.testkit.js';
import {
	KNOWN_PERMISSIONS,
	MOCK_SERVER_HELP,
	parseMockServerArgs,
	renderStrategyYaml,
	runMockServer,
	strategyOptions,
} from './gitlabMockServer.testkit.js';
import { parseGitLabOptions } from './gitlabOptions.js';

function io(): { out: string[]; err: string[]; handle: { out: (l: string) => void; err: (l: string) => void } } {
	const out: string[] = [];
	const err: string[] = [];
	return { out, err, handle: { out: line => out.push(line), err: line => err.push(line) } };
}

const opened: FakeGitLab[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map(async fake => await fake.stop()));
});

describe('parseMockServerArgs', () => {
	it('has the documented defaults', () => {
		expect(parseMockServerArgs([])).toEqual({
			help: false,
			port: 0,
			project: 'acme/shop',
			token: undefined,
			seed: false,
			rateLimit: 100,
			latencyMs: 0,
			permissions: undefined,
		});
	});

	it('reads every option, with a separate value or =', () => {
		const args = parseMockServerArgs([
			'--port=4321',
			'--project',
			'group/sub/project',
			'--token',
			'abc',
			'--seed',
			'--rate-limit',
			'0',
			'--latency=15',
			'--permissions',
			'Work Item: Read, Label: Read',
		]);
		expect(args).toMatchObject({
			port: 4321,
			project: 'group/sub/project',
			token: 'abc',
			seed: true,
			rateLimit: 0,
			latencyMs: 15,
			permissions: ['Work Item: Read', 'Label: Read'],
		});
		expect(parseMockServerArgs(['--permissions', 'all']).permissions).toBe('all');
		expect(parseMockServerArgs(['-h']).help).toBe(true);
	});

	it.each([
		[['--port', 'abc'], '--port: expected a whole number between 0 and 65535, found "abc"'],
		[['--port'], '--port: expected a whole number between 0 and 65535, found nothing'],
		[['--port', '70000'], '--port'],
		[['--rate-limit', '-1'], '--rate-limit'],
		[['--project', 'noslash'], '--project: expected a path like group/project'],
		[['--token', ' '], '--token'],
		[['--permissions', 'Work Item: Fly'], '--permissions: unknown permission "Work Item: Fly"'],
		[['--permissions'], '--permissions: expected "all" or a comma separated list'],
		[['--nope'], 'unknown option "--nope"'],
	])('refuses %j with an actionable message', (argv, message) => {
		expect(() => parseMockServerArgs(argv)).toThrow(message);
	});
});

describe('the strategy block', () => {
	it('is accepted by the options parser of the gitlab strategy, loopback http included', () => {
		const options = strategyOptions('acme/shop', 'http://127.0.0.1:4321/api/v4');
		const parsed = parseGitLabOptions(options);
		expect('settings' in parsed).toBe(true);
		if ('settings' in parsed) {
			expect(parsed.settings.baseUrl).toBe('http://127.0.0.1:4321/api/v4');
			expect(parsed.settings.token).toEqual({ kind: 'env', name: 'GITLAB_TOKEN' });
			expect(Object.keys(parsed.settings.statusMap)).toEqual(['backlog', 'in-progress', 'done', 'cancelled']);
		}
	});

	it('renders the YAML a person pastes', () => {
		expect(renderStrategyYaml(strategyOptions('acme/shop', 'http://127.0.0.1:4321/api/v4'))).toBe(
			[
				'strategy:',
				'    type: gitlab',
				'    options:',
				'        project: acme/shop',
				'        baseUrl: http://127.0.0.1:4321/api/v4',
				'        tokenEnv: GITLAB_TOKEN',
				'        statusMap:',
				'            backlog: { state: open }',
				"            in-progress: { state: open, label: 'status:in-progress' }",
				'            done: { state: closed }',
				"            cancelled: { state: closed, label: 'status:cancelled' }",
			].join('\n')
		);
	});
});

describe('runMockServer', () => {
	it('prints the help and exits 0 without starting anything', async () => {
		const sink = io();
		const started = vi.fn();
		expect(await runMockServer(['--help'], sink.handle, new AbortController().signal, started)).toBe(0);
		expect(sink.out.join('\n')).toBe(MOCK_SERVER_HELP);
		expect(started).not.toHaveBeenCalled();
		for (const name of KNOWN_PERMISSIONS) expect(MOCK_SERVER_HELP).toContain(name);
	});

	it('exits 2 on a bad command line, saying what is wrong and where the help is, and starts nothing', async () => {
		const sink = io();
		const started = vi.fn();
		expect(await runMockServer(['--port', 'x'], sink.handle, new AbortController().signal, started)).toBe(2);
		expect(sink.err.join('\n')).toContain('--port: expected a whole number');
		expect(sink.err.join('\n')).toContain('Run with --help');
		expect(started).not.toHaveBeenCalled();
	});

	it('starts, prints the url, project, token, env line and strategy block, serves the seed, and stops cleanly', async () => {
		const sink = io();
		const stop = new AbortController();
		let server: FakeGitLab | undefined;
		const running = runMockServer(
			['--seed', '--token', 'mock-token-1', '--project', 'acme/shop'],
			sink.handle,
			stop.signal,
			async (options, port) => {
				server = await FakeGitLab.startOn(options, port);
				opened.push(server);
				return server;
			}
		);
		// The server is listening once "Press Ctrl+C" is printed.
		for (let i = 0; i < 200 && !sink.out.includes('Press Ctrl+C to stop.'); i++)
			await new Promise(r => setTimeout(r, 10));
		expect(sink.out).toContain('Press Ctrl+C to stop.');
		const text = sink.out.join('\n');
		expect(text).toContain(`URL          ${server!.baseUrl}`);
		expect(text).toMatch(/URL\s+http:\/\/127\.0\.0\.1:\d+\/api\/v4/);
		expect(text).toContain('Project      acme/shop');
		expect(text).toContain('GITLAB_TOKEN=mock-token-1');
		expect(text).toContain(`        baseUrl: ${server!.baseUrl}`);
		expect(text).toContain('100 requests per 60 s window');
		expect(text).toContain('answer 403');
		const answer = await fetch(
			`${server!.baseUrl}/projects/${encodeURIComponent('acme/shop')}/issues?per_page=100`,
			{
				headers: { 'private-token': 'mock-token-1' },
			}
		);
		expect(answer.status).toBe(200);
		expect(((await answer.json()) as unknown[]).length).toBeGreaterThanOrEqual(6);
		stop.abort();
		expect(await running).toBe(0);
		await expect(fetch(`${server!.baseUrl}/version`)).rejects.toThrow();
	});

	it('honours --permissions all, --rate-limit 0 and an empty project', async () => {
		const sink = io();
		const stop = new AbortController();
		let given: Parameters<NonNullable<Parameters<typeof runMockServer>[3]>>[0] | undefined;
		const running = runMockServer(
			['--permissions', 'all', '--rate-limit', '0'],
			sink.handle,
			stop.signal,
			async (options, port) => {
				given = options;
				const server = await FakeGitLab.startOn(options, port);
				opened.push(server);
				return server;
			}
		);
		for (let i = 0; i < 200 && !sink.out.includes('Press Ctrl+C to stop.'); i++)
			await new Promise(r => setTimeout(r, 10));
		expect(given).toMatchObject({ permissions: 'all' });
		expect(given!.rateLimit).toBeUndefined();
		expect(sink.out.join('\n')).toContain('never refused');
		expect(sink.out.join('\n')).toContain('none (empty project; use --seed)');
		expect(sink.out.join('\n')).not.toContain('answer 403');
		stop.abort();
		expect(await running).toBe(0);
	});

	it('exits 1 with a hint when the port is taken', async () => {
		const holder = await FakeGitLab.start();
		opened.push(holder);
		const port = Number(new URL(holder.baseUrl).port);
		const sink = io();
		expect(await runMockServer(['--port', String(port)], sink.handle, new AbortController().signal)).toBe(1);
		expect(sink.err.join('\n')).toContain(`cannot listen on 127.0.0.1:${port}`);
		expect(sink.err.join('\n')).toContain('--port 0');
	});
});
