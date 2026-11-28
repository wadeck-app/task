// The real MachineRunner: spawns the `machine` binary (`machine run <peer> ... --json -- <command>`) with the request on its stdin.
// The machine transport (machineTransport.ts) knows no process; this file is the only one that does.
//
// ====================================================================================================================================
// PENDING (machine-owner): `machine run` has NO stdin channel today (the target spawns the command with stdin ignored; command line
// <= 2048 printable ASCII). A channel is being specified there: the allow-list entry will DECLARE the input (size, format) and `run` will
// carry it. Its flag is not known yet, so it is NOT guessed: `MACHINE_STDIN_ARGS` below is `undefined` and the runner REFUSES, loudly,
// before starting anything. When machine ships it, set the arguments here (and only here), then run the live check in
// docs/claude/storage-remote.md. Do not send the request any other way (argv, a file, an environment variable): that is exactly what
// the machine security model does not allow.
// ====================================================================================================================================
import { spawn } from 'node:child_process';

import { BackendRejectedError } from '@wadeck-app/task-core';

import type { MachineCall, MachineOutcome, MachineRunner } from './machineRunner.js';

/** The arguments of `machine run` that declare and carry stdin. PENDING: undefined = the machine CLI has none yet. */
export const MACHINE_STDIN_ARGS: readonly string[] | undefined = undefined;

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
	/** Tests set it; production reads {@link MACHINE_STDIN_ARGS}. */
	stdinArgs?: readonly string[];
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

export function createNodeMachineRunner(deps: NodeRunnerDeps = {}): MachineRunner {
	const doSpawn: SpawnFn = deps.spawn ?? ((file, args, options) => spawn(file, args, options) as unknown as RunningProcess);
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const stdinArgs = deps.stdinArgs ?? MACHINE_STDIN_ARGS;

	return {
		run(call) {
			if (stdinArgs === undefined) {
				return Promise.reject(
					new BackendRejectedError(
						'remote',
						'machine run',
						'this machine CLI has no stdin channel for run yet: update machine / ask machine-owner',
						'The request of a task cannot travel in a command line (2048 printable ASCII characters at most), so task refuses instead of guessing. Once machine ships its stdin channel, update it (machine cli update) and this task (task cli update); until then use another transport for this project'
					)
				);
			}
			const launch = launchOf(platform, env, machineArgs(call, stdinArgs));
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
					reject(
						error.code === 'ENOENT'
							? new BackendRejectedError(
									'remote',
									'machine run',
									'the machine CLI was not found: the command "machine" is not on the PATH of this process',
									'Install the machine CLI (or fix the PATH) so that `machine --help` works in this terminal, then run: task strategy check'
								)
							: error
					);
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
