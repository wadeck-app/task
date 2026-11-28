import {
	BackendRejectedError,
	MachineUnreachableError,
	RemoteIncompatibleError,
	RemoteTimeoutError,
	RemoteUnauthorizedError,
	RemoteUnreachableError,
} from '@wadeck-app/task-core';
import { describe, expect, it } from 'vitest';

import { createMachineTransport } from './machineTransport.js';
import type { MachineSettings } from './machineTransport.js';
import type { MachineCall, MachineOutcome, MachineRunner } from './machineRunner.js';

const SETTINGS: MachineSettings = { peer: 'thinkcentre', project: 'shop', wake: 'auto', timeoutSeconds: 60 };

function answer(status: number, body: unknown, headers: Record<string, string> = { 'X-Task-Protocol': '1' }): MachineOutcome {
	return {
		kind: 'ran',
		exitCode: 0,
		stdout: JSON.stringify({ status, headers, body }),
		stderr: '',
		timedOut: false,
		truncated: false,
	};
}

function runnerOf(next: MachineOutcome | ((call: MachineCall) => MachineOutcome)): MachineRunner & { calls: MachineCall[] } {
	const calls: MachineCall[] = [];
	return {
		calls,
		run(call) {
			calls.push(call);
			return Promise.resolve(typeof next === 'function' ? next(call) : next);
		},
	};
}

async function failureOf(promise: Promise<unknown>): Promise<Error & { hint?: string }> {
	try {
		await promise;
	} catch (error) {
		return error as Error & { hint?: string };
	}
	throw new Error('expected a failure');
}

describe('the request that goes to the peer', () => {
	it('is one allow-listed command, with the envelope (and no token) as the stdin', async () => {
		const runner = runnerOf(answer(200, { items: [] }));
		const transport = createMachineTransport(SETTINGS, runner);

		await transport.fetch('/v1/tasks', { method: 'POST', headers: { 'X-Task-Protocol': '2' }, body: '{"title":"T"}' });

		const [call] = runner.calls;
		expect(call).toMatchObject({
			peer: 'thinkcentre',
			wake: 'auto',
			command: 'task serve -p shop --stdio',
			timeoutMs: 60_000,
		});
		expect(JSON.parse(call!.stdin)).toEqual({
			method: 'POST',
			path: '/v1/tasks',
			headers: { 'X-Task-Protocol': '2' },
			body: { title: 'T' },
		});
		expect(call!.stdin).not.toMatch(/authorization|bearer/i);
	});

	it('a read without a body sends no body key, and the protocol header defaults to 1', async () => {
		const runner = runnerOf(answer(200, {}));

		await createMachineTransport(SETTINGS, runner).fetch('/v1/info');

		expect(JSON.parse(runner.calls[0]!.stdin)).toEqual({
			method: 'GET',
			path: '/v1/info',
			headers: { 'X-Task-Protocol': '1' },
		});
	});

	it('passes wake: never and the shell of the peer to the runner', async () => {
		const runner = runnerOf(answer(200, {}));

		await createMachineTransport({ ...SETTINGS, wake: 'never', shell: 'sh' }, runner).fetch('/v1/info');

		expect(runner.calls[0]).toMatchObject({ wake: 'never', shell: 'sh' });
	});

	it('a project name that could inject into the command line stops at creation: no run starts', () => {
		const runner = runnerOf(answer(200, {}));

		expect(() => createMachineTransport({ ...SETTINGS, project: 'shop;rm' }, runner)).toThrow(BackendRejectedError);
		expect(runner.calls).toHaveLength(0);
	});

	it('a body that is not JSON is refused before any run', async () => {
		const runner = runnerOf(answer(200, {}));

		const error = await failureOf(
			createMachineTransport(SETTINGS, runner).fetch('/v1/tasks', { method: 'POST', body: 'not json' })
		);

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(runner.calls).toHaveLength(0);
	});
});

describe('the answer of the peer', () => {
	it('becomes a fetch-like Response: status, headers and JSON body', async () => {
		const transport = createMachineTransport(SETTINGS, runnerOf(answer(201, { id: 'a1' }, { 'X-Task-Protocol': '2' })));

		const response = await transport.fetch('/v1/tasks', { method: 'POST', body: '{}' });

		expect(response.status).toBe(201);
		expect(response.headers.get('x-task-protocol')).toBe('2');
		expect(await response.json()).toEqual({ id: 'a1' });
	});

	it('an error status of the pipeline comes through as it is (the remote backend decodes it)', async () => {
		const transport = createMachineTransport(
			SETTINGS,
			runnerOf(answer(404, { error: { type: 'not-found', message: 'no task' } }))
		);

		const response = await transport.fetch('/v1/tasks/x');

		expect(response.ok).toBe(false);
		expect(response.status).toBe(404);
	});

	it.each([
		['text that is not JSON', 'oops'],
		['a JSON that is not an envelope', '{"hello":1}'],
		['a status out of range', '{"status":42,"headers":{},"body":null}'],
		['headers that are not texts', '{"status":200,"headers":{"a":1},"body":null}'],
	])('%s is an incompatible server', async (_name, stdout) => {
		const transport = createMachineTransport(
			SETTINGS,
			runnerOf({ kind: 'ran', exitCode: 0, stdout, stderr: '', timedOut: false, truncated: false })
		);

		await expect(transport.fetch('/v1/info')).rejects.toBeInstanceOf(RemoteIncompatibleError);
	});
});

describe('what goes wrong, and the next step it names', () => {
	it('a refusal names the exact allow entry to create on the admin machine', async () => {
		const transport = createMachineTransport(
			{ ...SETTINGS, shell: 'sh' },
			runnerOf({ kind: 'failed', stderr: '[fail] refused by thinkcentre: not-allowed: this command is not in the allow list\n' })
		);

		const error = await failureOf(transport.fetch('/v1/info'));

		expect(error).toBeInstanceOf(RemoteUnauthorizedError);
		expect(error.message).toContain('refused by thinkcentre');
		expect(error.hint).toContain('machine admin allow thinkcentre --shell sh -- task serve -p shop --stdio');
	});

	it('a peer that does not answer is reported as possibly asleep; wake: never says nothing tried to wake it', async () => {
		const stderr = '[fail] could not connect to any of the 2 address(es) the peer published\n';
		const auto = await failureOf(createMachineTransport(SETTINGS, runnerOf({ kind: 'failed', stderr })).fetch('/v1/info'));
		const never = await failureOf(
			createMachineTransport({ ...SETTINGS, wake: 'never' }, runnerOf({ kind: 'failed', stderr })).fetch('/v1/info')
		);

		expect(auto).toBeInstanceOf(MachineUnreachableError);
		expect(auto).toBeInstanceOf(RemoteUnreachableError);
		expect(auto.hint).toContain('Wake-on-LAN');
		expect(never.hint).toContain('wake: never');
		expect(never.hint).toContain('machine wake thinkcentre');
	});

	it('"no answer" is unreachable too, and an unknown machine failure keeps its first line with a ping hint', async () => {
		const silent = await failureOf(
			createMachineTransport(SETTINGS, runnerOf({ kind: 'failed', stderr: 'no answer from 10.0.0.2:47921 within 3000 ms' })).fetch('/v1/info')
		);
		const other = await failureOf(
			createMachineTransport(SETTINGS, runnerOf({ kind: 'failed', stderr: 'unknown machine "thinkcentre"\nmore' })).fetch('/v1/info')
		);

		expect(silent.hint).toContain('Wake-on-LAN');
		expect(other).toBeInstanceOf(MachineUnreachableError);
		expect(other.message).toContain('unknown machine "thinkcentre"');
		expect(other.message).not.toContain('more');
		expect(other.hint).toContain('machine ping thinkcentre');
	});

	it('our own timeout and the timeout of machine run are both a RemoteTimeoutError; a write says it may have been applied', async () => {
		const ours = await failureOf(createMachineTransport(SETTINGS, runnerOf({ kind: 'timeout' })).fetch('/v1/info'));
		const theirs = await failureOf(
			createMachineTransport(
				SETTINGS,
				runnerOf({ kind: 'ran', exitCode: null, stdout: '', stderr: '', timedOut: true, truncated: false })
			).fetch('/v1/tasks', { method: 'POST', body: '{}' })
		);

		expect(ours).toBeInstanceOf(RemoteTimeoutError);
		expect(theirs).toBeInstanceOf(RemoteTimeoutError);
		expect(theirs.hint).toContain('may have been applied');
	});

	it('an answer cut at 1 MiB asks for a smaller page on a read, and warns about the lost answer on a write', async () => {
		const cut: MachineOutcome = { kind: 'ran', exitCode: 0, stdout: '{"sta', stderr: '', timedOut: false, truncated: true };

		const read = await failureOf(createMachineTransport(SETTINGS, runnerOf(cut)).fetch('/v1/tasks'));
		const write = await failureOf(createMachineTransport(SETTINGS, runnerOf(cut)).fetch('/v1/tasks', { method: 'POST', body: '{}' }));

		expect(read).toBeInstanceOf(BackendRejectedError);
		expect(read.hint).toContain('smaller page');
		expect(write.hint).toContain('may have been applied');
	});

	it('a task that exits non-zero on the peer is unreachable, with its stderr and what to check there', async () => {
		const transport = createMachineTransport(
			SETTINGS,
			runnerOf({ kind: 'ran', exitCode: 1, stdout: '', stderr: 'Error: project "shop" is not registered\n', timedOut: false, truncated: false })
		);

		const error = await failureOf(transport.fetch('/v1/info'));

		expect(error).toBeInstanceOf(MachineUnreachableError);
		expect(error.message).toContain('exited 1 on thinkcentre');
		expect(error.message).toContain('project "shop" is not registered');
		expect(error.hint).toContain('task -v');
	});

	it('never puts the content of the request in an error or a hint', async () => {
		const secret = 'SECRET-COMMENT-TEXT-123';
		const outcomes: MachineOutcome[] = [
			{ kind: 'failed', stderr: 'refused by thinkcentre: not allowed' },
			{ kind: 'failed', stderr: 'could not connect' },
			{ kind: 'timeout' },
			{ kind: 'ran', exitCode: 3, stdout: '', stderr: 'boom', timedOut: false, truncated: false },
			{ kind: 'ran', exitCode: 0, stdout: '{', stderr: '', timedOut: false, truncated: true },
			{ kind: 'ran', exitCode: 0, stdout: 'garbage', stderr: '', timedOut: false, truncated: false },
		];

		for (const outcome of outcomes) {
			const error = await failureOf(
				createMachineTransport(SETTINGS, runnerOf(outcome)).fetch('/v1/tasks', {
					method: 'POST',
					body: JSON.stringify({ title: secret }),
				})
			);

			expect(`${error.message} ${error.hint ?? ''}`).not.toContain(secret);
		}
	});
});

describe('the instance', () => {
	it('describes the peer, the project, the command, the wake policy and the allow entry', () => {
		const lines = createMachineTransport(SETTINGS, runnerOf(answer(200, {}))).describe();

		expect(lines.join('\n')).toContain('peer: thinkcentre');
		expect(lines.join('\n')).toContain('project on the peer: shop');
		expect(lines.join('\n')).toContain('task serve -p shop --stdio');
		expect(lines.join('\n')).toContain('nothing pings or polls');
		expect(lines.join('\n')).toContain('machine admin allow thinkcentre -- task serve -p shop --stdio');
	});

	it('its address names the peer and the project (the host of an error is the peer)', () => {
		expect(createMachineTransport(SETTINGS, runnerOf(answer(200, {}))).baseUrl).toBe('machine://thinkcentre/shop');
		expect(RemoteUnreachableError.hostOf('machine://thinkcentre/shop')).toBe('thinkcentre');
	});

	it('refuses any use once disposed', async () => {
		const runner = runnerOf(answer(200, {}));
		const transport = createMachineTransport(SETTINGS, runner);

		await transport.dispose();

		await expect(transport.fetch('/v1/info')).rejects.toThrow('was closed');
		expect(runner.calls).toHaveLength(0);
	});
});
