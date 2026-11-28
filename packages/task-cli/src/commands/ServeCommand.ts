// task serve: arguments, safety checks and printing over the task-service server (`startTaskServer`). The command runs in the
// foreground until it is stopped (Ctrl+C, SIGTERM): task has no daemon manager and this does not daemonize; run it with the means of
// your shell or service manager.
import { PROTOCOL_VERSION } from '@wadeck-app/task-core';
import {
	assertServable,
	describeError,
	resolveServerToken,
	serveStdioRequest,
	startTaskServer,
} from '@wadeck-app/task-service';
import type {
	EventSink,
	RunningTaskServer,
	StdioAnswer,
	StdioServerOptions,
	TaskServerOptions,
	TaskServiceContext,
} from '@wadeck-app/task-service';

import { SERVE_HELP } from '../cli/help.js';
import { errorOutput, failure } from '../cli/output.js';
import type { CommandResult } from '../cli/output.js';

export const SERVE_DEFAULT_PORT = 7788;
const LOOPBACK_HOST = '127.0.0.1';

export interface ServeOptions {
	host: string;
	port: number;
	allowLan: boolean;
	tokenEnv: string | undefined;
	tokenFile: string | undefined;
	/** `--stdio`: one request on stdin, one answer on stdout, no network and no token. Absent unless given. */
	stdio?: true;
}

/** `task serve --help` needs no project. */
export function isServeHelp(rest: readonly string[]): boolean {
	return rest.includes('--help') || rest.includes('-h');
}

export function serveHelp(): CommandResult {
	return { exitCode: 0, output: SERVE_HELP };
}

const USAGE = [
	'Usage: task serve [-p <project>] [--port <n>] [--host <address>] [--allow-lan] [--token-env <NAME> | --token-file <path>] [--json]',
	'       task serve [-p <project>] --stdio',
].join('\n');

/** The options that only mean something for the HTTP server: `--stdio` has no network and no token. */
const HTTP_ONLY_OPTIONS = ['--port', '--host', '--allow-lan', '--token-env', '--token-file'];

/** An option that takes a value, as `--name value` or `--name=value`. */
function takeValue(rest: readonly string[], index: number, name: string): { value: string; next: number } | string {
	const arg = rest[index]!;
	if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), next: index + 1 };
	const value = rest[index + 1];
	if (value === undefined || value.startsWith('--')) return `${name} needs a value`;
	return { value, next: index + 2 };
}

export function parseServeArgs(rest: readonly string[], jsonMode = false): ServeOptions | CommandResult {
	const options: ServeOptions = {
		host: LOOPBACK_HOST,
		port: SERVE_DEFAULT_PORT,
		allowLan: false,
		tokenEnv: undefined,
		tokenFile: undefined,
	};
	const given: string[] = [];
	for (let index = 0; index < rest.length;) {
		const arg = rest[index]!;
		const name = arg.split('=')[0]!;
		if (HTTP_ONLY_OPTIONS.includes(name)) given.push(name);
		if (arg === '--stdio') {
			options.stdio = true;
			index++;
		} else if (arg === '--allow-lan') {
			options.allowLan = true;
			index++;
		} else if (name === '--port' || name === '--host' || name === '--token-env' || name === '--token-file') {
			const taken = takeValue(rest, index, name);
			if (typeof taken === 'string') return errorOutput(jsonMode, taken, USAGE);
			index = taken.next;
			if (name === '--port') {
				const port = /^\d+$/.test(taken.value) ? Number(taken.value) : NaN;
				if (!(port >= 0 && port <= 65535)) {
					return errorOutput(
						jsonMode,
						`--port must be a whole number from 0 to 65535, found "${taken.value}"`,
						USAGE
					);
				}
				options.port = port;
			} else if (name === '--host') {
				options.host = taken.value;
			} else if (name === '--token-env') {
				options.tokenEnv = taken.value;
			} else {
				options.tokenFile = taken.value;
			}
		} else if (arg.startsWith('-')) {
			return errorOutput(
				jsonMode,
				`unknown option: ${name}`,
				name === '--token'
					? 'A token on the command line would show in the process list and the shell history: use --token-env <VARIABLE NAME> or --token-file <absolute path>.'
					: USAGE
			);
		} else {
			return errorOutput(jsonMode, `unexpected argument: ${arg}`, USAGE);
		}
	}
	if (options.stdio === true && given.length > 0) {
		return errorOutput(
			jsonMode,
			`--stdio cannot be combined with ${[...new Set(given)].join(', ')}: it opens no port and has no token`,
			'Use --stdio alone to serve one request read on stdin, or drop --stdio to listen on a port.'
		);
	}
	return options;
}

/** True for an address that only this machine can reach: 127.0.0.0/8, ::1, localhost. */
export function isLoopbackHost(host: string): boolean {
	const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
	return bare === 'localhost' || bare === '::1' || /^127(\.\d{1,3}){3}$/.test(bare);
}

export interface ServeDeps {
	/** The served project, opened by the dispatcher (a config problem was already its error). */
	ctx: TaskServiceContext;
	env: NodeJS.ProcessEnv;
	/** The queue sink the server raises the events of its writes through (built after the checks, never for a refused start). */
	makeSink: () => EventSink;
	/** A line on stdout / a line on stderr. */
	out: (text: string) => void;
	warn: (text: string) => void;
	/** Aborted when the process is asked to stop (SIGINT, SIGTERM). */
	stop: AbortSignal;
	version: string;
	/** The task log (never receives the token). */
	log: (level: 'info' | 'warn' | 'error', message: string) => void;
	/** Test seam: starts the server. Default: `startTaskServer`. */
	start?: (options: TaskServerOptions) => Promise<RunningTaskServer>;
	/** `--stdio`: where the request is read (the process stdin). */
	stdin?: AsyncIterable<Buffer | string>;
	/** Test seam: serves one request. Default: `serveStdioRequest`. */
	serveStdio?: (source: AsyncIterable<Buffer | string>, options: StdioServerOptions) => Promise<StdioAnswer>;
}

function hostLabel(host: string): string {
	return host.includes(':') ? `[${host}]` : host;
}

/**
 * `task serve --stdio`: ONE request read on stdin, ONE answer printed on stdout (JSON, one line). The exit code is 0 whenever an answer
 * was produced (the HTTP-style status is inside it); a failure of the process itself (a project that cannot be served, an unreadable
 * stdin) is a message on stderr and a non-zero exit. No token: the caller that runs this command is the trust boundary (see
 * task-service/src/server/stdioServer.ts and docs/threat-model-task-serve.md).
 */
async function runServeStdio(jsonMode: boolean, deps: ServeDeps): Promise<CommandResult> {
	const source = deps.stdin;
	if (source === undefined) {
		return errorOutput(jsonMode, 'no stdin to read the request from', 'This is a bug of task: --stdio was started without stdin.');
	}
	const serve = deps.serveStdio ?? serveStdioRequest;
	try {
		// A project that cannot be served is refused BEFORE a sink exists (nothing is declared to the queue for a refused start).
		assertServable(deps.ctx);
		const answer = await serve(source, {
			ctx: deps.ctx,
			eventSink: deps.makeSink(),
			version: deps.version,
			log: (level, message) => {
				deps.log(level, `serve: ${message}`);
				if (level !== 'info') deps.warn(`${level === 'error' ? 'error' : 'warning'}: ${message}`);
			},
		});
		return { exitCode: 0, output: JSON.stringify(answer) };
	} catch (error) {
		return failure(jsonMode, error);
	}
}

export async function runServe(rest: readonly string[], jsonMode: boolean, deps: ServeDeps): Promise<CommandResult> {
	const parsed = parseServeArgs(rest, jsonMode);
	if ('exitCode' in parsed) return parsed;
	const options = parsed;
	if (options.stdio === true) return runServeStdio(jsonMode, deps);
	const host = options.host.replace(/^\[|\]$/g, '');
	const loopback = isLoopbackHost(host);

	if (!loopback && !options.allowLan) {
		return errorOutput(
			jsonMode,
			`refusing to listen on ${options.host}: it is reachable from the network, and task serve speaks plain HTTP (the token and the tasks are readable by anyone on that network)`,
			'Use the default (127.0.0.1, this machine only), or pass --allow-lan to serve a trusted LAN knowingly. TLS and tunnels are not part of this version.'
		);
	}

	let tokenFacts: ReturnType<typeof resolveServerToken>;
	try {
		tokenFacts = resolveServerToken({
			env: deps.env,
			...(options.tokenEnv === undefined ? {} : { tokenEnv: options.tokenEnv }),
			...(options.tokenFile === undefined ? {} : { tokenFile: options.tokenFile }),
		});
	} catch (error) {
		return failure(jsonMode, error);
	}

	const lan = !loopback;
	// Said BEFORE the port is bound: nothing is exposed until the person has been told.
	if (lan) {
		deps.warn(
			`WARNING: serving task data over plain HTTP on ${hostLabel(host)}:${options.port === 0 ? '<a free port>' : options.port}. The traffic and the token are readable by anyone on that network, and anyone holding the token can read and change every task of this project. Use it on a trusted LAN only (no TLS in this version).`
		);
	}
	const start = deps.start ?? startTaskServer;
	const sink = deps.makeSink();
	let server: RunningTaskServer;
	try {
		server = await start({
			ctx: deps.ctx,
			token: tokenFacts.token,
			host,
			port: options.port,
			eventSink: sink,
			version: deps.version,
			log: (level, message) => {
				// Warnings and errors reach the task log and the person who runs the server; request lines only the log (TASK_DEBUG=1 at the caller).
				deps.log(level, `serve: ${message}`);
				if (level !== 'info') deps.warn(`${level === 'error' ? 'error' : 'warning'}: ${message}`);
			},
		});
	} catch (error) {
		return failure(jsonMode, error);
	}

	const project = deps.ctx.project;
	const auth =
		tokenFacts.origin.kind === 'env'
			? `bearer token from the environment variable ${tokenFacts.origin.name}`
			: `bearer token from the file ${tokenFacts.origin.path}`;
	if (jsonMode) {
		deps.out(
			JSON.stringify({
				listening: true,
				url: server.url,
				host: server.host,
				port: server.port,
				lan,
				protocol: PROTOCOL_VERSION,
				project: { ...(project.id === undefined ? {} : { id: project.id }), name: project.name },
				auth: tokenFacts.origin,
				events: true,
			})
		);
	} else {
		const pad = 11;
		deps.out(
			[
				`task serve: project ${project.name}${project.id === undefined ? '' : ` (${project.id})`}`,
				`  ${'listening'.padEnd(pad)}${server.url}`,
				`  ${'protocol'.padEnd(pad)}${PROTOCOL_VERSION}`,
				`  ${'auth'.padEnd(pad)}${auth}`,
				`  ${'events'.padEnd(pad)}raised by this server through the queue of this machine (clients raise none)`,
				`  ${'stop'.padEnd(pad)}Ctrl+C (the writes in flight are finished first)`,
			].join('\n')
		);
	}

	// Foreground until asked to stop.
	await new Promise<void>(resolve => {
		if (deps.stop.aborted) resolve();
		else deps.stop.addEventListener('abort', () => resolve(), { once: true });
	});
	try {
		await server.close();
	} catch (error) {
		const { message, hint } = describeError(error);
		deps.warn(`warning: the server did not close cleanly: ${message}${hint === undefined ? '' : ` (${hint})`}`);
	}
	deps.log('info', 'serve: stopped');
	return {
		exitCode: 0,
		output: jsonMode ? JSON.stringify({ listening: false, stopped: true }) : 'task serve: stopped',
	};
}
