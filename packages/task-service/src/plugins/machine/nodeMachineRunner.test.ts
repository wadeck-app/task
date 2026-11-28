import { EventEmitter } from 'node:events';

import { BackendRejectedError } from '@wadeck-app/task-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MachineCall } from './machineRunner.js';
import { MACHINE_STDIN_ARGS, createNodeMachineRunner, launchOf, machineArgs } from './nodeMachineRunner.js';
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

describe('PENDING: the machine CLI has no stdin channel for run yet', () => {
	it('the constant is not set, and the runner refuses before starting anything', async () => {
		const h = harness();

		const result = createNodeMachineRunner({ spawn: h.spawn }).run(CALL);

		expect(MACHINE_STDIN_ARGS).toBeUndefined();
		await expect(result).rejects.toBeInstanceOf(BackendRejectedError);
		await expect(result).rejects.toThrow('this machine CLI has no stdin channel for run yet: update machine / ask machine-owner');
		expect(h.spawned).toHaveLength(0);
	});
});

describe('the command line of machine', () => {
	it('is run <peer> --no-wait [--no-wake] [--shell s] --json <stdin args> -- <one command string>, and never holds the request', () => {
		expect(machineArgs(CALL, ['--stdin'])).toEqual([
			'run',
			'thinkcentre',
			'--no-wait',
			'--json',
			'--stdin',
			'--',
			'task serve -p shop --stdio',
		]);
		expect(machineArgs({ ...CALL, wake: 'never', shell: 'sh' }, ['--stdin'])).toEqual([
			'run',
			'thinkcentre',
			'--no-wait',
			'--no-wake',
			'--shell',
			'sh',
			'--json',
			'--stdin',
			'--',
			'task serve -p shop --stdio',
		]);
		expect(machineArgs(CALL, ['--stdin']).join(' ')).not.toContain('"method"');
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
	const configured = { stdinArgs: ['--stdin'], platform: 'linux' as const, env: { PATH: 'x' } };

	it('is spawned without a shell, the request goes to its stdin, and the JSON result becomes the outcome', async () => {
		const h = harness();
		const run = createNodeMachineRunner({ ...configured, spawn: h.spawn }).run(CALL);

		h.child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, truncated: false })));
		h.child.emit('close', 0);

		await expect(run).resolves.toEqual({ kind: 'ran', exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, truncated: false });
		expect(h.spawned[0]).toMatchObject({ file: 'machine', options: { shell: false, windowsHide: true } });
		expect(h.child.stdin.ended).toBe(CALL.stdin);
	});

	it('a non-zero exit of the remote command still carries its JSON result', async () => {
		const h = harness();
		const run = createNodeMachineRunner({ ...configured, spawn: h.spawn }).run(CALL);

		h.child.stdout.emit('data', JSON.stringify({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false, truncated: false }));
		h.child.emit('close', 1);

		await expect(run).resolves.toMatchObject({ kind: 'ran', exitCode: 1, stderr: 'boom' });
	});

	it('exit 255 is a failure of machine itself: its plain stderr text, not JSON', async () => {
		const h = harness();
		const run = createNodeMachineRunner({ ...configured, spawn: h.spawn }).run(CALL);

		h.child.stderr.emit('data', '[fail] refused by thinkcentre: not-allowed\n');
		h.child.emit('close', 255);

		await expect(run).resolves.toEqual({ kind: 'failed', stderr: '[fail] refused by thinkcentre: not-allowed\n' });
	});

	it('another exit with no JSON result is a failure that quotes what machine said', async () => {
		const h = harness();
		const run = createNodeMachineRunner({ ...configured, spawn: h.spawn }).run(CALL);

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

		h.child.emit('error', Object.assign(new Error('spawn machine ENOENT'), { code: 'ENOENT' }));

		await expect(run).rejects.toThrow('"machine" is not on the PATH');
	});

	it('is cut at the time limit: the process is killed and the outcome is a timeout', async () => {
		vi.useFakeTimers();
		const h = harness();
		const run = createNodeMachineRunner({ ...configured, spawn: h.spawn }).run(CALL);

		await vi.advanceTimersByTimeAsync(1001);

		await expect(run).resolves.toEqual({ kind: 'timeout' });
		expect(h.child.killed).toBe(true);
	});
});
