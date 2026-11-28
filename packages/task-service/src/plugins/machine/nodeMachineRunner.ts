// The real MachineRunner: spawns the `machine` binary (`machine run <peer> ... --json -- <command>`) with the request on its stdin.
// The machine transport (machineTransport.ts) knows no process; this file is the only one that does.
//
// The stdin channel of `machine run` (spec .claude/specs/2026-11-13_machine-network/stdin-input.md of the machine repo, decision 114):
// the allow entry of the peer DECLARES the input (`--stdin json --stdin-max 64k --stdin-chars <families>`) and the caller sends it with
// `machine run <peer> --stdin - -- <command>` (`-` = the stdin of this process). The first release of machine may not have it: the
// runner reads the LOCAL `machine run --help` ONCE (no network, nothing is woken) and, when `--stdin` is not in it, REFUSES loudly
// before starting the real run. It never sends the request any other way (argv, a file, an environment variable): that is exactly what
// the machine security model does not allow.
import { spawn } from 'node:child_process';

import { BackendRejectedError } from '@wadeck-app/task-core';

import type { MachineCall, MachineOutcome, MachineRunner } from './machineRunner.js';

/** The arguments of `machine run` that carry the request: read it from this process's stdin. Detected before use ({@link createStdinDetector}). */
export const MACHINE_STDIN_ARGS: readonly string[] = ['--stdin', '-'];

/** How long `machine run --help` may take (it is local: it opens no connection). */
const HELP_TIMEOUT_MS = 10_000;
/** A machine CLI without `--stdin` is looked at again after this long, so a long-lived process (the module) sees an update without a restart. */
const ABSENT_RECHECK_MS = 60_000;

/** What the runner keeps of each output stream of `machine` (its own cap on the command output is 1 MiB, JSON-escaped). */
const OUTPUT_CAP = 16 * 1024 * 1024;

export interface RunningProcess {
	stdin: { end(data: string): unknown; on(event: 'error', listener: () => void): unknown };
	stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
	stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
	once(event: 'close', listener: (code: number | null) => void): unknown;
	once(event: 'error', listener: (error: Error & { code?: string }) => void): unknown;
	kill(): unknown;
}

export interface RunnerSpawnOptions {
	shell: false;
	windowsHide: true;
	env: NodeJS.ProcessEnv;
	stdio: ['pipe', 'pipe', 'pipe'];
}

export type SpawnFn = (file: string, args: string[], options: RunnerSpawnOptions) => RunningProcess;

export interface NodeRunnerDeps {
	spawn?: SpawnFn;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	/** Whether the installed machine CLI has `--stdin` for run. Tests inject it; production reads `machine run --help` once ({@link defaultStdinDetector}). */
	detectStdin?: () => Promise<boolean>;
}

/** The arguments after `machine`. Every text in them was validated by machineCommand.ts; the request is NOT among them. */
export function machineArgs(call: MachineCall, stdinArgs: readonly string[]): string[] {
	return [
		'run',
		call.peer,
		// A request the peer does not allow yet is refused at once with the entry to create, never held for ten minutes.
		'--no-wait',
		...(call.wake === 'never' ? ['--no-wake'] : []),
		...(call.shell === undefined ? [] : ['--shell', call.shell]),
		'--json',
		...stdinArgs,
		'--',
		call.command,
	];
}

/**
 * How to start `machine` without a shell of our own. Node refuses to spawn a `.cmd` shim directly on Windows, and the machine CLI is
 * installed as one by npm: there it goes through `cmd.exe /d /s /c machine ...`. This is the one place where a shell is in between, and
 * it is safe by construction: every word in the arguments is validated ASCII without metacharacters (machineCommand.ts) and the request
 * travels on stdin, never in the command line.
 */
export function launchOf(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
	args: readonly string[]
): { file: string; args: string[] } {
	if (platform === 'win32') {
		return { file: env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/c', 'machine', ...args] };
	}
	return { file: 'machine', args: [...args] };
}

function text(chunk: Buffer | string): string {
	return typeof chunk === 'string' ? chunk : chunk.toString('utf8');
}

interface MachineJson {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	truncated: boolean;
}

/** The result object `machine run --json` prints, or undefined when the text is not one. */
function parseResult(stdout: string): MachineJson | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout) as unknown;
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) return undefined;
	const value = parsed as Record<string, unknown>;
	const { exitCode, stdout: out, stderr, timedOut, truncated } = value;
	if (exitCode !== null && typeof exitCode !== 'number') return undefined;
	if (typeof out !== 'string' || typeof stderr !== 'string') return undefined;
	return { exitCode: exitCode as number | null, stdout: out, stderr, timedOut: timedOut === true, truncated: truncated === true };
}

const MACHINE_NOT_FOUND = (): BackendRejectedError =>
	new BackendRejectedError(
		'remote',
		'machine run',
		'the machine CLI was not found: the command "machine" is not on the PATH of this process',
		'Install the machine CLI (or fix the PATH) so that `machine --help` works in this terminal, then run: task strategy check'
	);

const NO_STDIN_CHANNEL = (): BackendRejectedError =>
	new BackendRejectedError(
		'remote',
		'machine run',
		'this machine CLI has no stdin channel for run yet: update machine / ask machine-owner',
		'The request of a task cannot travel in a command line (2048 printable ASCII characters at most), so task refuses instead of guessing. Once machine ships its stdin channel (`machine run --help` lists --stdin), update it (machine cli update); there is nothing to update in task: it looks again by itself within a minute. Until then use another transport for this project'
	);

const STDIN_FLAG = /(^|[\s[])--stdin\b/;

/**
 * Whether the help text lists `--stdin` for `run`. `machine run --help` prints the WHOLE help of machine (observed), where `--stdin`
 * also appears on the allow side (`admin allow ... --stdin json`): only the entry of `run` counts (its line and the continuation lines
 * indented deeper). A help dedicated to `machine run` (its first line starts with "machine run") is read whole. Any other shape is an
 * error that says so, never "absent": a format this code does not know must not look like a missing feature.
 */
export function runHelpHasStdin(help: string): boolean {
	const lines = help.split(/\r?\n/);
	const first = lines.find(line => line.trim() !== '');
	if (first !== undefined && /^\s*machine run\b/.test(first)) return STDIN_FLAG.test(help);
	const start = lines.findIndex(line => /^\s*run\s+<machine>/.test(line));
	if (start === -1) {
		throw new BackendRejectedError(
			'remote',
			'machine run',
			'the help of this machine CLI has no "run <machine>" entry, so task cannot tell whether it carries a stdin',
			'Update machine (machine cli update) and task (task cli update); if both are recent, report it to machine-owner with the output of machine run --help'
		);
	}
	const indent = (lines[start] ?? '').search(/\S/);
	const block = [lines[start] ?? ''];
	for (const line of lines.slice(start + 1)) {
		if (line.trim() !== '' && line.search(/\S/) <= indent) break;
		block.push(line);
	}
	return STDIN_FLAG.test(block.join('\n'));
}

export interface StdinDetectorDeps {
	spawn?: SpawnFn;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
}

/**
 * Whether the installed machine CLI documents `--stdin` for `run`, read from its LOCAL help (`machine run --help`: no connection, no
 * peer, nothing woken). A positive answer is kept for the life of the process; a negative one is looked at again after a minute, so a
 * long-lived process (the app module) notices an update. A help that cannot be read is an error, never "absent".
 */
export function createStdinDetector(deps: StdinDetectorDeps = {}): () => Promise<boolean> {
	const doSpawn: SpawnFn = deps.spawn ?? ((file, args, options) => spawn(file, args, options) as unknown as RunningProcess);
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const now = deps.now ?? Date.now;
	let present = false;
	let absentAt: number | undefined;
	let pending: Promise<boolean> | undefined;

	const readHelp = (): Promise<boolean> => {
		const launch = launchOf(platform, env, ['run', '--help']);
		return new Promise<boolean>((resolve, reject) => {
			let child: RunningProcess;
			try {
				child = doSpawn(launch.file, launch.args, { shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			let out = '';
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				child.kill();
				reject(
					new BackendRejectedError(
						'remote',
						'machine run',
						`\`machine run --help\` did not answer within ${HELP_TIMEOUT_MS / 1000} s`,
						'Run `machine run --help` in this terminal; if it hangs, fix or reinstall the machine CLI (machine cli self-check), then run: task strategy check'
					)
				);
			}, HELP_TIMEOUT_MS);
			child.stdout.on('data', chunk => {
				out += text(chunk);
			});
			child.stderr.on('data', chunk => {
				out += text(chunk);
			});
			child.stdin.on('error', () => undefined);
			child.once('error', error => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error.code === 'ENOENT' ? MACHINE_NOT_FOUND() : error);
			});
			child.once('close', code => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (out.trim() === '') {
					reject(
						new BackendRejectedError(
							'remote',
							'machine run',
							`\`machine run --help\` printed nothing (exit ${code === null ? 'killed' : code})`,
							'Run `machine run --help` in this terminal; if it prints nothing, reinstall the machine CLI, then run: task strategy check'
						)
					);
					return;
				}
				try {
					resolve(runHelpHasStdin(out));
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			child.stdin.end('');
		});
	};

	return async () => {
		if (present) return true;
		if (absentAt !== undefined && now() - absentAt < ABSENT_RECHECK_MS) return false;
		pending ??= readHelp().then(
			found => {
				pending = undefined;
				if (found) present = true;
				else absentAt = now();
				return found;
			},
			(error: unknown) => {
				pending = undefined;
				throw error;
			}
		);
		return pending;
	};
}

/** One detector for the whole process: the first run looks at the local help, the rest reuse the answer. */
let processDetector: (() => Promise<boolean>) | undefined;
function defaultStdinDetector(): Promise<boolean> {
	processDetector ??= createStdinDetector();
	return processDetector();
}

export function createNodeMachineRunner(deps: NodeRunnerDeps = {}): MachineRunner {
	const doSpawn: SpawnFn = deps.spawn ?? ((file, args, options) => spawn(file, args, options) as unknown as RunningProcess);
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const detectStdin = deps.detectStdin ?? defaultStdinDetector;

	return {
		async run(call) {
			// Before anything is sent: a machine CLI that cannot carry the request is refused, never worked around.
			if (!(await detectStdin())) throw NO_STDIN_CHANNEL();
			const launch = launchOf(platform, env, machineArgs(call, MACHINE_STDIN_ARGS));
			return new Promise<MachineOutcome>((resolve, reject) => {
				let child: RunningProcess;
				try {
					child = doSpawn(launch.file, launch.args, {
						shell: false,
						windowsHide: true,
						env,
						stdio: ['pipe', 'pipe', 'pipe'],
					});
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
					return;
				}
				let out = '';
				let err = '';
				let settled = false;
				function finish(outcome: MachineOutcome): void {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(outcome);
				}
				const timer = setTimeout(() => {
					child.kill();
					finish({ kind: 'timeout' });
				}, call.timeoutMs);
				child.stdout.on('data', chunk => {
					if (out.length < OUTPUT_CAP) out += text(chunk);
				});
				child.stderr.on('data', chunk => {
					if (err.length < OUTPUT_CAP) err += text(chunk);
				});
				// A closed pipe (the process ended before reading its stdin) is told by its exit, not by this error.
				child.stdin.on('error', () => undefined);
				child.once('error', error => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(error.code === 'ENOENT' ? MACHINE_NOT_FOUND() : error);
				});
				child.once('close', code => {
					if (code === 255) {
						finish({ kind: 'failed', stderr: err });
						return;
					}
					const result = parseResult(out);
					if (result === undefined) {
						finish({
							kind: 'failed',
							stderr: `machine run ended with exit ${code === null ? 'killed' : code} and printed no result: ${err.trim() || out.trim().slice(0, 200)}`,
						});
						return;
					}
					finish({ kind: 'ran', ...result });
				});
				child.stdin.end(call.stdin);
			});
		},
	};
}
