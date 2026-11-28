import { EventEmitter } from 'node:events';

import { BackendRejectedError } from '@wadeck-app/task-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MachineCall } from './machineRunner.js';
import {
	MACHINE_STDIN_ARGS,
	createNodeMachineRunner,
	createStdinDetector,
	launchOf,
	machineArgs,
	runHelpHasStdin,
} from './nodeMachineRunner.js';
import type { RunnerSpawnOptions, RunningProcess } from './nodeMachineRunner.js';

const CALL: MachineCall = {
	peer: 'thinkcentre',
	wake: 'auto',
	command: 'task serve -p shop --stdio',
	stdin: '{"method":"GET","path":"/v1/info"}',
	timeoutMs: 1000,
};

class FakeProcess extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	readonly stdin = Object.assign(new EventEmitter(), { ended: undefined as string | undefined, end(data: string) { this.ended = data; } });
	killed = false;
	kill(): void {
		this.killed = true;
	}
}

function harness(): { child: FakeProcess; spawned: Array<{ file: string; args: string[]; options: RunnerSpawnOptions }>; spawn: (...a: [string, string[], RunnerSpawnOptions]) => RunningProcess } {
	const child = new FakeProcess();
	const spawned: Array<{ file: string; args: string[]; options: RunnerSpawnOptions }> = [];
	return {
		child,
		spawned,
		spawn: (file, args, options) => {
			spawned.push({ file, args, options });
			return child as unknown as RunningProcess;
		},
	};
}

afterEach(() => vi.useRealTimers());

// The shape of the real `machine run --help` (the WHOLE help of machine): the entry of run, its continuation lines, the next entry,
// and the allow side that already mentions --stdin once machine ships it (a trap: only the entry of run counts).
const ALLOW_SIDE =
	'  allow a command on a machine (admin machine):\n    machine admin allow <machine> --stdin json --stdin-max 64k --stdin-chars <families> -- <command>\n';
const RUN_WITHOUT =
	'  run <machine> [--address <host:port>] [--wake | --no-wake] [--shell cmd|ps|bash|sh] -- <command...>\n                                     run one allowed command on a peer. Without --address the addresses come from the relay\n';
const RUN_WITH =
	'  run <machine> [--address <host:port>] [--wake | --no-wake] [--stdin <file|->] -- <command...>\n                                     run one allowed command on a peer. Without --address the addresses come from the relay\n';
const NEXT = '  run-defaults [--on-refusal wait|fail]\n                                     shows what machine run does\n';
const helpOf = (run: string): string => `machine - private network\n\nCommands:\n${ALLOW_SIDE}${run}${NEXT}`;

describe('does the installed machine CLI carry a stdin for run? (read from its local help)', () => {
	it('only the entry of run counts: the allow side naming --stdin is not enough', () => {
		expect(runHelpHasStdin(helpOf(RUN_WITH))).toBe(true);
		expect(runHelpHasStdin(helpOf(RUN_WITHOUT))).toBe(false);
	});

	it('a flag on a continuation line of the run entry counts, one in the NEXT entry does not', () => {
		const wrapped =
			'  run <machine> [--address <host:port>]\n                                     [--stdin <file|->] -- <command...>\n';
		expect(runHelpHasStdin(helpOf(wrapped))).toBe(true);
		expect(runHelpHasStdin(helpOf(RUN_WITHOUT + '  --stdin elsewhere\n'))).toBe(false);
		expect(runHelpHasStdin('machine run - run a command\n  --stdin <file|->\n')).toBe(true);
		expect(runHelpHasStdin('machine run - run a command\n  --shell <s>\n')).toBe(false);
	});

	it('a help of an unknown shape is an error that says so, never "absent"', () => {
		expect(() => runHelpHasStdin('something else entirely\n')).toThrow('no "run <machine>" entry');
	});

	function detectorHarness(help: string, now: { t: number }): { spawned: string[][]; detect: () => Promise<boolean> } {
		const spawned: string[][] = [];
		const detect = createStdinDetector({
			platform: 'linux',
			env: { PATH: 'x' },
			now: () => now.t,
			spawn: (_file, args) => {
				spawned.push(args);
				const child = new FakeProcess();
				queueMicrotask(() => {
					child.stdout.emit('data', Buffer.from(help));
					child.emit('close', 0);
				});
				return child as unknown as RunningProcess;
			},
		});
		return { spawned, detect };
	}

	it('runs the LOCAL help once (run --help, no peer) and keeps a positive answer for the process', async () => {
		const h = detectorHarness(helpOf(RUN_WITH), { t: 0 });

		expect(await h.detect()).toBe(true);
		expect(await h.detect()).toBe(true);

		expect(h.spawned).toEqual([['run', '--help']]);
	});

	it('looks at a missing feature again after a minute (a long-lived process sees an update), not before', async () => {
		const now = { t: 0 };
		const h = detectorHarness(helpOf(RUN_WITHOUT), now);

		expect(await h.detect()).toBe(false);
		now.t = 59_000;
		expect(await h.detect()).toBe(false);
		expect(h.spawned).toHaveLength(1);
		now.t = 61_000;
		expect(await h.detect()).toBe(false);
		expect(h.spawned).toHaveLength(2);
	});

	it('a machine that is not installed or a silent help is an actionable error, not "absent"', async () => {
		const missing = createStdinDetector({
			platform: 'linux',
			env: {},
			spawn: () => {
				const child = new FakeProcess();
				queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn machine ENOENT'), { code: 'ENOENT' })));
				return child as unknown as RunningProcess;
			},
		});
		await expect(missing()).rejects.toThrow('"machine" is not on the PATH');

		const silent = createStdinDetector({
			platform: 'linux',
			env: {},
			spawn: () => {
				const child = new FakeProcess();
				queueMicrotask(() => child.emit('close', 0));
				return child as unknown as RunningProcess;
			},
		});
		await expect(silent()).rejects.toThrow('printed nothing');
	});
});

describe('a machine CLI without a stdin channel', () => {
	it('is refused before the real run starts, with the next step; nothing is spawned', async () => {
		const h = harness();

		const result = createNodeMachineRunner({ spawn: h.spawn, detectStdin: () => Promise.resolve(false) }).run(CALL);

		await expect(result).rejects.toBeInstanceOf(BackendRejectedError);
		await expect(result).rejects.toThrow('this machine CLI has no stdin channel for run yet: update machine / ask machine-owner');
		expect(h.spawned).toHaveLength(0);
	});

	it('carries the request on stdin with --stdin - once the CLI has it', async () => {
		expect(MACHINE_STDIN_ARGS).toEqual(['--stdin', '-']);
		const h = harness();
		const run = createNodeMachineRunner({
			spawn: h.spawn,
			platform: 'linux',
			env: {},
			detectStdin: () => Promise.resolve(true),
		}).run(CALL);

		await vi.waitFor(() => expect(h.spawned).toHaveLength(1));
		h.child.stdout.emit('data', JSON.stringify({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, truncated: false }));
		h.child.emit('close', 0);

		await expect(run).resolves.toMatchObject({ kind: 'ran', exitCode: 0 });
		expect(h.spawned[0]?.args).toEqual(['run', 'thinkcentre', '--no-wait', '--json', '--stdin', '-', '--', 'task serve -p shop --stdio']);
		expect(h.child.stdin.ended).toBe(CALL.stdin);
	});
});

describe('the command line of machine', () => {
	it('is run <peer> --no-wait [--no-wake] [--shell s] --json <stdin args> -- <one command string>, and never holds the request', () => {
		expect(machineArgs(CALL, MACHINE_STDIN_ARGS)).toEqual([
			'run',
			'thinkcentre',
			'--no-wait',
			'--json',
			'--stdin',
			'-',
			'--',
			'task serve -p shop --stdio',
		]);
		expect(machineArgs({ ...CALL, wake: 'never', shell: 'sh' }, MACHINE_STDIN_ARGS)).toEqual([
			'run',
			'thinkcentre',
			'--no-wait',
			'--no-wake',
			'--shell',
			'sh',
			'--json',
			'--stdin',
			'-',
			'--',
			'task serve -p shop --stdio',
		]);
		expect(machineArgs(CALL, MACHINE_STDIN_ARGS).join(' ')).not.toContain('"method"');
	});

	it('starts machine directly elsewhere, and through cmd.exe on Windows (a .cmd shim cannot be spawned directly)', () => {
		expect(launchOf('linux', {}, ['run', 'p'])).toEqual({ file: 'machine', args: ['run', 'p'] });
		expect(launchOf('win32', { ComSpec: 'cmd-from-env.exe' }, ['run', 'p'])).toEqual({
			file: 'cmd-from-env.exe',
			args: ['/d', '/s', '/c', 'machine', 'run', 'p'],
		});
	});
});

describe('the process', () => {
	const configured = { detectStdin: () => Promise.resolve(true), platform: 'linux' as const, env: { PATH: 'x' } };

	it('is spawned without a shell, the request goes to its stdin, and the JSON result becomes the outcome', async () => {
		const h = harness();
		const run = createNodeMachineRunner({ ...configured, spawn: h.spawn }).run(CALL);
		await vi.waitFor(() => expect(h.spawned).toHaveLength(1));

		h.child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, truncated: false })));
		h.child.emit('close', 0);

		await expect(run).resolves.toEqual({ kind: 'ran', exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, truncated: false });
		expect(h.spawned[0]).toMatchObject({ file: 'machine', options: { shell: false, windowsHide: true } });
		expect(h.child.stdin.ended).toBe(CALL.stdin);
	});

	it('a non-zero exit of the remote command still carries its JSON result', async () => {
		const h = harness();
		const run = createNodeMachineRunner({ ...configured, spawn: h.spawn }).run(CALL);
		await vi.waitFor(() => expect(h.spawned).toHaveLength(1));

		h.child.stdout.emit('data', JSON.stringify({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false, truncated: false }));
		h.child.emit('close', 1);

		await expect(run).resolves.toMatchObject({ kind: 'ran', exitCode: 1, stderr: 'boom' });
	});

	it('exit 255 is a failure of machine itself: its plain stderr text, not JSON', async () => {
		const h = harness();
		const run = createNodeMachineRunner({ ...configured, spawn: h.spawn }).run(CALL);
		await vi.waitFor(() => expect(h.spawned).toHaveLength(1));

		h.child.stderr.emit('data', '[fail] refused by thinkcentre: not-allowed\n');
		h.child.emit('close', 255);

		await expect(run).resolves.toEqual({ kind: 'failed', stderr: '[fail] refused by thinkcentre: not-allowed\n' });
	});

	it('another exit with no JSON result is a failure that quotes what machine said', async () => {
		const h = harness();
		const run = createNodeMachineRunner({ ...configured, spawn: h.spawn }).run(CALL);
		await vi.waitFor(() => expect(h.spawned).toHaveLength(1));

		h.child.stderr.emit('data', 'usage: machine run ...');
		h.child.emit('close', 2);

		const outcome = await run;
		expect(outcome).toMatchObject({ kind: 'failed' });
		expect((outcome as { stderr: string }).stderr).toContain('exit 2 and printed no result');
		expect((outcome as { stderr: string }).stderr).toContain('usage: machine run');
	});

	it('a machine that is not installed is an actionable refusal', async () => {
		const h = harness();
		const run = createNodeMachineRunner({ ...configured, spawn: h.spawn }).run(CALL);
		await vi.waitFor(() => expect(h.spawned).toHaveLength(1));

		h.child.emit('error', Object.assign(new Error('spawn machine ENOENT'), { code: 'ENOENT' }));

		await expect(run).rejects.toThrow('"machine" is not on the PATH');
	});

	it('is cut at the time limit: the process is killed and the outcome is a timeout', async () => {
		vi.useFakeTimers();
		const h = harness();
		const run = createNodeMachineRunner({ ...configured, spawn: h.spawn }).run(CALL);
		await vi.waitFor(() => expect(h.spawned).toHaveLength(1));

		await vi.advanceTimersByTimeAsync(1001);

		await expect(run).resolves.toEqual({ kind: 'timeout' });
		expect(h.child.killed).toBe(true);
	});
});
