import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createLocalBackend } from '@wadeck-app/task-core';
import type { TaskBackend } from '@wadeck-app/task-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pollUntilAborted, runTaskHistoryFollow, runTaskListFollow } from './follow.js';

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

describe('pollUntilAborted', () => {
	it('never starts a poll while the previous one is still running, even when a poll is slower than the interval', async () => {
		const controller = new AbortController();
		let running = 0;
		let maxRunning = 0;
		let polls = 0;

		await pollUntilAborted(
			async () => {
				running++;
				maxRunning = Math.max(maxRunning, running);
				await sleep(25);
				running--;
				if (++polls === 4) controller.abort();
			},
			2,
			controller.signal
		);

		expect(polls).toBe(4);
		expect(maxRunning).toBe(1);
	});

	it('waits the interval after a poll ENDED before the next one (self-scheduling, not a fixed rate)', async () => {
		// Fake timers: the clock only moves when the test moves it, so the gaps are exact, not subject to scheduler jitter.
		vi.useFakeTimers();
		try {
			const controller = new AbortController();
			const starts: number[] = [];

			const loop = pollUntilAborted(
				async () => {
					starts.push(Date.now());
					await sleep(30);
					if (starts.length === 3) controller.abort();
				},
				40,
				controller.signal
			);
			await vi.advanceTimersByTimeAsync(1000);
			await loop;

			// Start-to-start is poll duration + interval = 70 ms exactly; a fixed 40 ms timer would give 40.
			expect(starts).toHaveLength(3);
			expect(starts[1]! - starts[0]!).toBe(70);
			expect(starts[2]! - starts[1]!).toBe(70);
		} finally {
			vi.useRealTimers();
		}
	});

	it('returns at once when aborted during the pause, without polling again', async () => {
		const controller = new AbortController();
		const poll = vi.fn(async () => undefined);
		const loop = pollUntilAborted(poll, 10_000, controller.signal);

		controller.abort();
		await loop;

		expect(poll).not.toHaveBeenCalled();
	});

	it('is not held up by a slow poll in flight when aborted, and the abandoned poll failing later is not an unhandled rejection', async () => {
		const controller = new AbortController();
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		try {
			// The poll stays blocked on this gate until the test opens it, AFTER the loop has returned: if the loop waited for
			// the poll, `await loop` would never finish (the test times out), with no wall-clock threshold involved.
			let failLate: (error: Error) => void = () => undefined;
			const gate = new Promise<void>((_resolve, reject) => {
				failLate = reject;
			});
			const loop = pollUntilAborted(
				async () => {
					controller.abort();
					await gate;
				},
				1,
				controller.signal
			);

			await loop;
			failLate(new Error('late failure'));
			// Negative assertion: an unhandled rejection is reported within a few event-loop turns.
			await sleep(50);
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off('unhandledRejection', unhandled);
		}
	});

	it('fails with the error of a poll that throws while running (no silent stop)', async () => {
		const controller = new AbortController();

		await expect(
			pollUntilAborted(
				async () => {
					throw new Error('backend unreachable');
				},
				1,
				controller.signal
			)
		).rejects.toThrow('backend unreachable');
	});
});

describe('the follow commands over a backend', () => {
	let dir: string;
	let backend: TaskBackend;
	let stdout: string[];
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-follow-'));
		fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
		backend = createLocalBackend(path.join(dir, 'tasks'));
		stdout = [];
		vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
			stdout.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const lines = (): Array<Record<string, unknown>> =>
		stdout
			.join('')
			.split('\n')
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);

	it('list: prints the existing tasks, then each new task and each status change once, and stops on abort', async () => {
		const first = await backend.create({ title: 'first', status: 'todo' });
		const controller = new AbortController();
		const follow = runTaskListFollow(backend, () => true, { intervalMs: 5, signal: controller.signal });

		// Wait for each line instead of sleeping a fixed time: a stalled poll cannot merge two changes into one batch
		// (line order) nor let the abort come before the poll that would have seen the last change.
		await vi.waitFor(() => expect(lines()).toHaveLength(1));
		const second = await backend.create({ title: 'second', status: 'todo' });
		await vi.waitFor(() => expect(lines()).toHaveLength(2));
		await backend.updateStatus(first.id, 'done');
		await vi.waitFor(() => expect(lines()).toHaveLength(3));
		controller.abort();
		await follow;

		expect(lines().map(line => [line['id'], line['status']])).toEqual([
			[first.id, 'todo'],
			[second.id, 'todo'],
			[first.id, 'done'],
		]);
		const printed = lines().length;
		await backend.updateStatus(second.id, 'done');
		await sleep(30);
		expect(lines()).toHaveLength(printed);
	});

	it('list: a slow backend never sees two reads at once, and nothing is printed twice', async () => {
		await backend.create({ title: 'only', status: 'todo' });
		let inFlight = 0;
		let maxInFlight = 0;
		let listCalls = 0;
		const slow = new Proxy(backend, {
			get(target, prop) {
				if (prop !== 'list') {
					const value: unknown = Reflect.get(target, prop);
					return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
				}
				return async () => {
					listCalls++;
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					await sleep(20);
					inFlight--;
					return target.list();
				};
			},
		});
		const controller = new AbortController();
		const follow = runTaskListFollow(slow, () => true, { intervalMs: 1, signal: controller.signal });

		// Enough reads for an overlap to have shown up (the initial read plus three polls).
		await vi.waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(4));
		controller.abort();
		await follow;

		expect(maxInFlight).toBe(1);
		expect(lines()).toHaveLength(1);
	});

	it('history: prints the history already known, then the entries appended later, and stops on abort', async () => {
		const task = await backend.create({ title: 'tracked', status: 'todo' });
		const controller = new AbortController();
		const follow = runTaskHistoryFollow(backend, task.id, task.history, {
			intervalMs: 5,
			signal: controller.signal,
		});

		await vi.waitFor(() => expect(lines()).toHaveLength(1));
		await backend.updateStatus(task.id, 'done');
		await vi.waitFor(() => expect(lines()).toHaveLength(2));
		controller.abort();
		await follow;

		expect(lines().map(line => line['status'])).toEqual(['todo', 'done']);
	});

	// The test worker has its own SIGINT handling: the process object is spied on instead of really signalled.
	function spyOnSigint(): { handler: () => (() => void) | undefined; removed: () => boolean } {
		let installed: (() => void) | undefined;
		let removed = false;
		vi.spyOn(process, 'once').mockImplementation(((event: string, listener: () => void) => {
			if (event === 'SIGINT') installed = listener;
			return process;
		}) as never);
		vi.spyOn(process, 'off').mockImplementation(((event: string, listener: () => void) => {
			if (event === 'SIGINT' && listener === installed) removed = true;
			return process;
		}) as never);
		return { handler: () => installed, removed: () => removed };
	}

	it('without an injected signal the loop stops on the first SIGINT and removes its listener', async () => {
		const sigint = spyOnSigint();
		const follow = runTaskListFollow(backend, () => true, { intervalMs: 5 });

		// The listener is installed AFTER the initial read of the backend (follow.ts), so wait for it instead of sleeping a fixed
		// time: a slow first read of the task files must not fail this test.
		await vi.waitFor(() => expect(sigint.handler()).toBeTypeOf('function'));
		expect(sigint.removed()).toBe(false);
		sigint.handler()!();
		await follow;

		expect(sigint.removed()).toBe(true);
	});

	it('a backend failure while following fails the command with that error and releases the SIGINT listener', async () => {
		const sigint = spyOnSigint();
		let calls = 0;
		const failing = new Proxy(backend, {
			get(target, prop) {
				if (prop === 'list') {
					return async () => {
						if (++calls > 1) throw new Error('backend went away');
						return [];
					};
				}
				const value: unknown = Reflect.get(target, prop);
				return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
			},
		});

		await expect(runTaskListFollow(failing, () => true, { intervalMs: 1 })).rejects.toThrow('backend went away');

		expect(sigint.removed()).toBe(true);
	});
});
