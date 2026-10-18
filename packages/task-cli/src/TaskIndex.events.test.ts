import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Queue delivery is observed at the process boundary: the CLI spawns `node queue.js push <event> <json>`.
// Resolving the queue binary and spawning are both faked so no real queue is needed (or touched).
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => {
	const actual = await importOriginal<typeof import('node:child_process')>();
	return {
		...actual,
		spawn: spawnMock,
		execSync: vi.fn(() => 'C:\\fake\\queue.cmd\n'),
		execFileSync: vi.fn(() => '/fake/queue\n'),
	};
});

import { runTaskCommand } from './TaskIndex.js';

interface PushedEvent {
	event: string;
	payload: Record<string, unknown>;
}

let tmpDir: string;

function pushedEvents(): PushedEvent[] {
	return spawnMock.mock.calls.map(call => {
		const args = call[1] as string[];
		return { event: args[2]!, payload: JSON.parse(args[3]!) as Record<string, unknown> };
	});
}

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-events-test-'));
	// mockReset (vitest config) clears implementations between tests: re-arm the fake child process.
	spawnMock.mockImplementation(() => {
		const child = new EventEmitter();
		setImmediate(() => child.emit('close', 0));
		return child;
	});
	await runTaskCommand(['init'], tmpDir);
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('queue events — onTaskCreated carries the hierarchy', () => {
	it('includes parentId (the full id) when the task is created under a parent', async () => {
		const parent = JSON.parse((await runTaskCommand(['new', 'parent'], tmpDir)).output) as { id: string };
		spawnMock.mockClear();

		const child = JSON.parse(
			(await runTaskCommand(['new', 'child', '--parent', parent.id.slice(0, 4)], tmpDir)).output
		) as { id: string };

		const events = pushedEvents();
		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe('onTaskCreated');
		expect(events[0]!.payload['taskId']).toBe(child.id);
		expect(events[0]!.payload['parentId']).toBe(parent.id);
	});

	it('omits parentId for a root task', async () => {
		await runTaskCommand(['new', 'root'], tmpDir);

		const events = pushedEvents();
		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe('onTaskCreated');
		expect('parentId' in events[0]!.payload).toBe(false);
	});

	it('does not push any event when the parent does not exist', async () => {
		const result = await runTaskCommand(['new', 'child', '--parent', 'zzzzzz'], tmpDir);

		expect(result.exitCode).toBe(1);
		expect(pushedEvents()).toHaveLength(0);
	});
});
