// The logic of `scripts/gitlab-mock-server.mjs`: the GitLab mock (fakeGitLab.testkit.ts) as a long running local server a human can point
// a task project at, without Docker or network. It is in a testkit module (compiled to dist/ by `npm run build`) so that the argument
// parsing, the printed instructions and the start/stop are tested in process; the script only wires the signals and the exit code.
//
// THE SERVER IS A MOCK: it answers like the recorded gitlab.com Free (see the header of fakeGitLab.testkit.ts) but has no durable
// state, and its token is a made-up string. Nothing of it can reach a real GitLab.
import * as crypto from 'node:crypto';

import { FakeGitLab, LIVE_TOKEN_PERMISSIONS } from './fakeGitLab.testkit.js';
import type { FakeGitLabOptions } from './fakeGitLab.testkit.js';

/** A wrong command line: the script prints the message and the help hint, and exits 2. */
export class MockServerUsageError extends Error {}

export interface MockServerArgs {
	help: boolean;
	/** 0 = a free port. */
	port: number;
	project: string;
	/** Undefined = a random one. */
	token: string | undefined;
	seed: boolean;
	/** Requests per 60 s window; 0 = never refused. */
	rateLimit: number;
	latencyMs: number;
	/** Undefined = the permissions of the live test token. */
	permissions: readonly string[] | 'all' | undefined;
}

/** Every permission name the mock knows (the live token held the Work Item and Label ones only). */
export const KNOWN_PERMISSIONS: readonly string[] = [
	...LIVE_TOKEN_PERMISSIONS,
	'Project: Read',
	'Metadata: Read',
	'User: Read',
	'Personal Access Token: Read',
	'Namespace: Read',
	'Member: Read',
	'Repository: Read',
	'Webhook: Read',
	'Global Search: Use',
	'Work Item: Read (instance)',
];

export const MOCK_SERVER_HELP = `gitlab-mock-server: a local GitLab (Free tier) REST v4 + GraphQL mock for task's gitlab strategy.
No Docker, no network, no real GitLab: it answers like the recorded gitlab.com Free (see packages/task-service/src/plugins/gitlab/fakeGitLab.testkit.ts)
and forgets everything when it stops.

Usage: node scripts/gitlab-mock-server.mjs [options]     (after: npm run build)

Options:
  --port <n>           port on 127.0.0.1 (default 0: a free one, printed)
  --project <path>     project path served (default acme/shop)
  --token <t>          the accepted token (default: a random mock token)
  --seed               start with a few issues: one per status and type, labels, a child task, a link, comments
  --rate-limit <n>     requests per 60 s window before 429 (default 100, like gitlab.com Free; 0 = never refused)
  --latency <ms>       delay added to every answer (default 0)
  --permissions <list> comma separated fine-grained permissions, or "all" (a classic token). Default: the live test token
                       (Work Item and Label only: /user, /version, /projects/:id ... answer 403 like the real one)
  --help               this text

Known permissions: ${KNOWN_PERMISSIONS.join(', ')}

Exit codes: 0 stopped (Ctrl+C), 1 the server could not start, 2 bad usage.`;

function integerOption(name: string, value: string | undefined, min: number, max: number): number {
	if (value === undefined || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
		throw new MockServerUsageError(
			`${name}: expected a whole number between ${min} and ${max}, found ${value === undefined ? 'nothing' : `"${value}"`}`
		);
	}
	return Number(value);
}

/** Parses the command line. Throws MockServerUsageError with an actionable message. */
export function parseMockServerArgs(argv: readonly string[]): MockServerArgs {
	const args: MockServerArgs = {
		help: false,
		port: 0,
		project: 'acme/shop',
		token: undefined,
		seed: false,
		rateLimit: 100,
		latencyMs: 0,
		permissions: undefined,
	};
	for (let i = 0; i < argv.length; i++) {
		const option = argv[i]!;
		const inline =
			option.startsWith('--') && option.includes('=') ? option.slice(option.indexOf('=') + 1) : undefined;
		const name = inline === undefined ? option : option.slice(0, option.indexOf('='));
		const value = (): string | undefined => {
			if (inline !== undefined) return inline;
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) return undefined;
			i += 1;
			return next;
		};
		switch (name) {
			case '--help':
			case '-h':
				args.help = true;
				break;
			case '--seed':
				args.seed = true;
				break;
			case '--port':
				args.port = integerOption('--port', value(), 0, 65535);
				break;
			case '--rate-limit':
				args.rateLimit = integerOption('--rate-limit', value(), 0, 1_000_000);
				break;
			case '--latency':
				args.latencyMs = integerOption('--latency', value(), 0, 60_000);
				break;
			case '--project': {
				const project = value();
				if (project === undefined || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(project)) {
					throw new MockServerUsageError(
						`--project: expected a path like group/project or group/subgroup/project, found ${project === undefined ? 'nothing' : `"${project}"`}`
					);
				}
				args.project = project;
				break;
			}
			case '--token': {
				const token = value();
				if (token === undefined || token.trim() === '' || /\s/.test(token)) {
					throw new MockServerUsageError('--token: expected a non empty token without spaces');
				}
				args.token = token;
				break;
			}
			case '--permissions': {
				const list = value();
				if (list === undefined || list.trim() === '') {
					throw new MockServerUsageError(
						`--permissions: expected "all" or a comma separated list, for example "Work Item: Read,Label: Read" (known: ${KNOWN_PERMISSIONS.join(', ')})`
					);
				}
				if (list.trim() === 'all') args.permissions = 'all';
				else {
					const names = list
						.split(',')
						.map(entry => entry.trim())
						.filter(entry => entry !== '');
					const unknown = names.filter(entry => !KNOWN_PERMISSIONS.includes(entry));
					if (unknown.length > 0) {
						throw new MockServerUsageError(
							`--permissions: unknown permission ${unknown.map(entry => `"${entry}"`).join(', ')} (known: ${KNOWN_PERMISSIONS.join(', ')})`
						);
					}
					args.permissions = names;
				}
				break;
			}
			default:
				throw new MockServerUsageError(
					`unknown option "${option}" (known: --port, --project, --token, --seed, --rate-limit, --latency, --permissions, --help)`
				);
		}
	}
	return args;
}

/** The `strategy.options` of a task project config that points at the mock. */
export function strategyOptions(project: string, baseUrl: string): Record<string, unknown> {
	return {
		project,
		baseUrl,
		tokenEnv: 'GITLAB_TOKEN',
		statusMap: {
			backlog: { state: 'open' },
			'in-progress': { state: 'open', label: 'status:in-progress' },
			done: { state: 'closed' },
			cancelled: { state: 'closed', label: 'status:cancelled' },
		},
	};
}

/** The ready to paste `strategy:` block (4 spaces, flow mappings for the status rules, like the documentation). */
export function renderStrategyYaml(options: Record<string, unknown>): string {
	const statusMap = options['statusMap'] as Record<string, { state: string; label?: string }>;
	const rule = (entry: { state: string; label?: string }): string =>
		entry.label === undefined ? `{ state: ${entry.state} }` : `{ state: ${entry.state}, label: '${entry.label}' }`;
	return [
		'strategy:',
		'    type: gitlab',
		'    options:',
		`        project: ${String(options['project'])}`,
		`        baseUrl: ${String(options['baseUrl'])}`,
		`        tokenEnv: ${String(options['tokenEnv'])}`,
		'        statusMap:',
		...Object.entries(statusMap).map(([status, entry]) => `            ${status}: ${rule(entry)}`),
	].join('\n');
}

export interface MockServerIo {
	out: (line: string) => void;
	err: (line: string) => void;
}

/**
 * Starts the mock, prints how to use it, and runs until `stop` is aborted. Returns the exit code: 0 stopped, 1 could not start, 2 bad
 * usage. `fakeFactory` lets a test count the servers it opens.
 */
export async function runMockServer(
	argv: readonly string[],
	io: MockServerIo,
	stop: AbortSignal,
	startServer: (options: FakeGitLabOptions, port: number) => Promise<FakeGitLab> = (options, port) =>
		FakeGitLab.startOn(options, port)
): Promise<number> {
	let args: MockServerArgs;
	try {
		args = parseMockServerArgs(argv);
	} catch (error) {
		if (!(error instanceof MockServerUsageError)) throw error;
		io.err(`gitlab-mock-server: ${error.message}`);
		io.err('Run with --help for the options.');
		return 2;
	}
	if (args.help) {
		io.out(MOCK_SERVER_HELP);
		return 0;
	}
	const token = args.token ?? `glpat-mock-${crypto.randomBytes(10).toString('hex')}`;
	const options: FakeGitLabOptions = {
		project: args.project,
		token,
		...(args.latencyMs > 0 ? { latencyMs: args.latencyMs } : {}),
		...(args.rateLimit > 0 ? { rateLimit: { limit: args.rateLimit, windowSeconds: 60 } } : {}),
		...(args.permissions === undefined ? {} : { permissions: args.permissions }),
	};
	let fake: FakeGitLab;
	try {
		fake = await startServer(options, args.port);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		io.err(
			`gitlab-mock-server: cannot listen on 127.0.0.1:${args.port}: ${reason}. ${
				args.port === 0 ? '' : 'Pick another port with --port, or use --port 0 for a free one.'
			}`.trim()
		);
		return 1;
	}
	try {
		if (args.seed) fake.seedDemo();
		const permissions =
			args.permissions === undefined
				? 'the live test token (Work Item and Label only)'
				: args.permissions === 'all'
					? 'all (a classic token)'
					: args.permissions.join(', ');
		io.out('GitLab mock server (a local fake, NOT a real GitLab: it forgets everything when it stops)');
		io.out(`  URL          ${fake.baseUrl}`);
		io.out(`  Project      ${fake.project}`);
		io.out(`  Token        ${fake.token}   (a mock token, only this server accepts it)`);
		io.out(
			`  Rate limit   ${args.rateLimit > 0 ? `${args.rateLimit} requests per 60 s window, then 429 until the window ends` : 'never refused (the headers still count)'}`
		);
		io.out(`  Permissions  ${permissions}`);
		io.out(
			`  Seed         ${args.seed ? 'a small demo project (issues, labels, a child task, a link, comments)' : 'none (empty project; use --seed)'}`
		);
		if (args.permissions === undefined) {
			io.out(
				'  Note         like the real fine-grained test token, /user, /version, /metadata and GET /projects/:id answer 403; use --permissions all for a classic token'
			);
		}
		io.out('');
		io.out('Environment variable for the shell that runs task:');
		io.out(`  GITLAB_TOKEN=${fake.token}`);
		io.out('');
		io.out('Strategy block for the config.yml of a task project (task strategy show / check, task list ...):');
		io.out(renderStrategyYaml(strategyOptions(fake.project, fake.baseUrl)));
		io.out('');
		io.out('Press Ctrl+C to stop.');
		if (!stop.aborted) {
			await new Promise<void>(resolve => stop.addEventListener('abort', () => resolve(), { once: true }));
		}
		return 0;
	} finally {
		await fake.stop();
	}
}
