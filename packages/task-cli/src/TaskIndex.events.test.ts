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

// The setup file swaps the queue sink for an instant fake: this file tests the real one (with a faked child process).
vi.unmock('@wadeck-app/task-service');

import { runTaskCommand } from './TaskIndex.js';

interface PushedEvent {
	event: string;
	payload: Record<string, unknown>;
}

let tmpDir: string;
// Redirects ~/.config/task (CLI invocation + failure logs) so tests never write to the real log.
let configHome: string;
let previousXdg: string | undefined;

function pushedEvents(): PushedEvent[] {
	return spawnMock.mock.calls.map(call => {
		const args = call[1] as string[];
		return { event: args[2]!, payload: JSON.parse(args[3]!) as Record<string, unknown> };
	});
}

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-events-test-'));
	configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'task-events-config-'));
	previousXdg = process.env['XDG_CONFIG_HOME'];
	process.env['XDG_CONFIG_HOME'] = configHome;
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
	fs.rmSync(configHome, { recursive: true, force: true });
	if (previousXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
	else process.env['XDG_CONFIG_HOME'] = previousXdg;
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

async function newTask(title: string): Promise<{ id: string }> {
	return JSON.parse((await runTaskCommand(['new', title], tmpDir)).output) as { id: string };
}

describe('queue events — an undelivered event leaves a trace in the task log', () => {
	let stderr: string[];

	const errorLogLines = (): Array<{ level: string; msg: string }> => {
		const logDir = path.join(configHome, 'task', 'logs');
		if (!fs.existsSync(logDir)) return [];
		return fs
			.readdirSync(logDir)
			.flatMap(f => fs.readFileSync(path.join(logDir, f), 'utf8').split('\n'))
			.filter(l => l.length > 0)
			.map(l => JSON.parse(l) as { level: string; msg: string })
			.filter(l => l.level === 'error');
	};

	beforeEach(() => {
		stderr = [];
		vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
			stderr.push(String(chunk));
			return true;
		});
	});

	const failNextSpawn = (how: 'exit' | 'error'): void => {
		spawnMock.mockImplementation(() => {
			const child = new EventEmitter();
			setImmediate(() =>
				how === 'exit' ? child.emit('close', 1) : child.emit('error', new Error('spawn EPERM'))
			);
			return child;
		});
	};

	it('logs an error line (event, task, reason, replay command) when queue push exits non-zero', async () => {
		const task = await newTask('task');
		failNextSpawn('exit');

		const result = await runTaskCommand(['set-status', task.id, 'in-progress'], tmpDir);

		expect(result.exitCode).toBe(0);
		const lines = errorLogLines();
		expect(lines).toHaveLength(1);
		expect(lines[0]!.msg).toContain(`queue push 'onStatusChange' for task ${task.id} not delivered: exit 1`);
		expect(lines[0]!.msg).toContain(`Replay with: queue push onStatusChange '{`);
		expect(lines[0]!.msg).toContain(`"taskId":"${task.id}"`);
		expect(stderr.join('')).toContain(`for task ${task.id} not delivered: exit 1`);
		expect(stderr.join('')).toContain('task cli logs');
	});

	it('logs an error line when the queue process cannot be spawned', async () => {
		const task = await newTask('task');
		failNextSpawn('error');

		await runTaskCommand(['set-status', task.id, 'in-progress'], tmpDir);

		const lines = errorLogLines();
		expect(lines).toHaveLength(1);
		expect(lines[0]!.msg).toContain('not delivered: spawn EPERM');
	});

	it('logs an error line when queue cannot be found on PATH', async () => {
		const { execSync, execFileSync } = await import('node:child_process');
		vi.mocked(execSync).mockImplementation(() => {
			throw new Error('not found');
		});
		vi.mocked(execFileSync).mockImplementation(() => {
			throw new Error('not found');
		});
		// The resolved queue path is cached per module instance: load a fresh one.
		vi.resetModules();
		const fresh = await import('./TaskIndex.js');
		const task = JSON.parse((await fresh.runTaskCommand(['new', 'lonely'], tmpDir)).output) as { id: string };

		const lines = errorLogLines();
		expect(
			lines.some(l =>
				l.msg.includes(`queue push 'onTaskCreated' for task ${task.id} not delivered: queue not found on PATH`)
			)
		).toBe(true);
		expect(stderr.join('')).toContain('queue not found on PATH');
		expect(stderr.join('')).toContain('task cli logs');
	});

	it('writes no error line when the event is delivered', async () => {
		const task = await newTask('task');

		await runTaskCommand(['set-status', task.id, 'in-progress'], tmpDir);

		expect(errorLogLines()).toEqual([]);
	});

	it('does not double-report when the child emits both error and close', async () => {
		const task = await newTask('task');
		spawnMock.mockImplementation(() => {
			const child = new EventEmitter();
			setImmediate(() => {
				child.emit('error', new Error('spawn EPERM'));
				child.emit('close', 1);
			});
			return child;
		});

		await runTaskCommand(['set-status', task.id, 'in-progress'], tmpDir);

		expect(errorLogLines()).toHaveLength(1);
	});
});

describe('queue events — onStatusChange', () => {
	it('carries the previous status as oldStatus and the new one as newStatus', async () => {
		const task = await newTask('task');
		spawnMock.mockClear();

		await runTaskCommand(['set-status', task.id, 'in-progress'], tmpDir);

		expect(pushedEvents()).toHaveLength(1);
		expect(pushedEvents()[0]!.payload).toMatchObject({
			taskId: task.id,
			oldStatus: 'backlog',
			newStatus: 'in-progress',
		});
	});
});

describe('queue events — onTaskLinked / onTaskUnlinked', () => {
	it('link pushes onTaskLinked from the task that holds the link', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		spawnMock.mockClear();

		await runTaskCommand(['link', a.id.slice(0, 4), 'blockedBy', b.id.slice(0, 4)], tmpDir);

		const events = pushedEvents();
		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe('onTaskLinked');
		expect(events[0]!.payload).toMatchObject({ taskId: a.id, linkType: 'blockedBy', targetId: b.id });
	});

	it('the inverse spelling is pushed in its stored form (holder, canonical type, target)', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		spawnMock.mockClear();

		await runTaskCommand(['link', a.id, 'blocks', b.id], tmpDir);

		expect(pushedEvents()[0]!.payload).toMatchObject({ taskId: b.id, linkType: 'blockedBy', targetId: a.id });
	});

	it('unlink pushes onTaskUnlinked', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		await runTaskCommand(['link', a.id, 'causedBy', b.id], tmpDir);
		spawnMock.mockClear();

		await runTaskCommand(['unlink', a.id, 'causedBy', b.id], tmpDir);

		const events = pushedEvents();
		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe('onTaskUnlinked');
		expect(events[0]!.payload).toMatchObject({ taskId: a.id, linkType: 'causedBy', targetId: b.id });
	});

	it('pushes nothing when the link is rejected (cycle) or the unlink fails', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		await runTaskCommand(['link', a.id, 'blockedBy', b.id], tmpDir);
		spawnMock.mockClear();

		const cycle = await runTaskCommand(['link', b.id, 'blockedBy', a.id], tmpDir);
		const missing = await runTaskCommand(['unlink', b.id, 'blockedBy', a.id], tmpDir);

		expect(cycle.exitCode).toBe(1);
		expect(missing.exitCode).toBe(1);
		expect(pushedEvents()).toHaveLength(0);
	});
});

describe('queue events — onTaskUnblocked', () => {
	const setup = async () => {
		const blocker = await newTask('blocker');
		const blocked = await newTask('blocked');
		await runTaskCommand(['link', blocked.id, 'blockedBy', blocker.id], tmpDir);
		spawnMock.mockClear();
		return { blocker, blocked };
	};

	it('is pushed, after onStatusChange, when the last open blocker reaches a terminal status', async () => {
		const { blocker, blocked } = await setup();

		await runTaskCommand(['set-status', blocker.id, 'done'], tmpDir);

		const events = pushedEvents();
		expect(events.map(e => e.event)).toEqual(['onStatusChange', 'onTaskUnblocked']);
		expect(events[1]!.payload).toMatchObject({ taskId: blocked.id, blockerId: blocker.id, status: 'backlog' });
	});

	it('is pushed once per unblocked task', async () => {
		const blocker = await newTask('blocker');
		const x = await newTask('x');
		const y = await newTask('y');
		await runTaskCommand(['link', x.id, 'blockedBy', blocker.id], tmpDir);
		await runTaskCommand(['link', y.id, 'blockedBy', blocker.id], tmpDir);
		spawnMock.mockClear();

		await runTaskCommand(['set-status', blocker.id, 'done'], tmpDir);

		const unblocked = pushedEvents().filter(e => e.event === 'onTaskUnblocked');
		expect(unblocked.map(e => e.payload['taskId']).sort()).toEqual([x.id, y.id].sort());
	});

	it('waits for the last blocker: nothing while another blocker is still open', async () => {
		const first = await newTask('first');
		const second = await newTask('second');
		const blocked = await newTask('blocked');
		await runTaskCommand(['link', blocked.id, 'blockedBy', first.id], tmpDir);
		await runTaskCommand(['link', blocked.id, 'blockedBy', second.id], tmpDir);
		spawnMock.mockClear();

		await runTaskCommand(['set-status', first.id, 'done'], tmpDir);
		expect(pushedEvents().map(e => e.event)).toEqual(['onStatusChange']);

		await runTaskCommand(['set-status', second.id, 'done'], tmpDir);
		const last = pushedEvents().filter(e => e.event === 'onTaskUnblocked');
		expect(last).toHaveLength(1);
		expect(last[0]!.payload).toMatchObject({ taskId: blocked.id, blockerId: second.id });
	});

	it('is not pushed for a non-terminal status change', async () => {
		const { blocker } = await setup();

		await runTaskCommand(['set-status', blocker.id, 'in-progress'], tmpDir);

		expect(pushedEvents().map(e => e.event)).toEqual(['onStatusChange']);
	});

	it('is not pushed for a blocked task that is already terminal', async () => {
		const { blocker, blocked } = await setup();
		await runTaskCommand(['set-status', blocked.id, 'done'], tmpDir);
		spawnMock.mockClear();

		await runTaskCommand(['set-status', blocker.id, 'done'], tmpDir);

		expect(pushedEvents().map(e => e.event)).toEqual(['onStatusChange']);
	});

	it('is not pushed for links that are not blockedBy', async () => {
		const target = await newTask('target');
		const other = await newTask('other');
		await runTaskCommand(['link', other.id, 'causedBy', target.id], tmpDir);
		spawnMock.mockClear();

		await runTaskCommand(['set-status', target.id, 'done'], tmpDir);

		expect(pushedEvents().map(e => e.event)).toEqual(['onStatusChange']);
	});
});

describe('set-status — closing a task that still has open blockers', () => {
	let stderr: string[];

	beforeEach(() => {
		stderr = [];
		vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
			stderr.push(String(chunk));
			return true;
		});
	});

	it('succeeds but warns on stderr, listing every open blocker with its status', async () => {
		const b1 = await newTask('first blocker');
		const b2 = await newTask('second blocker');
		const task = await newTask('task');
		await runTaskCommand(['link', task.id, 'blockedBy', b1.id], tmpDir);
		await runTaskCommand(['link', task.id, 'blockedBy', b2.id], tmpDir);
		await runTaskCommand(['set-status', b2.id, 'in-progress'], tmpDir);
		stderr.length = 0;

		const result = await runTaskCommand(['set-status', task.id, 'done'], tmpDir);

		expect(result.exitCode, result.output).toBe(0);
		expect((JSON.parse(result.output) as { status: string }).status).toBe('done');
		const warning = stderr.join('');
		expect(warning).toContain(`Warning: task ${task.id} is now done but still blocked by 2 open task(s)`);
		expect(warning).toContain(`${b1.id}  first blocker  [backlog]`);
		expect(warning).toContain(`${b2.id}  second blocker  [in-progress]`);
	});

	it('does not warn when all blockers are already terminal', async () => {
		const blocker = await newTask('blocker');
		const task = await newTask('task');
		await runTaskCommand(['link', task.id, 'blockedBy', blocker.id], tmpDir);
		await runTaskCommand(['set-status', blocker.id, 'done'], tmpDir);
		stderr.length = 0;

		await runTaskCommand(['set-status', task.id, 'done'], tmpDir);

		expect(stderr.join('')).not.toContain('Warning');
	});

	it('does not warn for a non-terminal target status', async () => {
		const blocker = await newTask('blocker');
		const task = await newTask('task');
		await runTaskCommand(['link', task.id, 'blockedBy', blocker.id], tmpDir);
		stderr.length = 0;

		await runTaskCommand(['set-status', task.id, 'in-progress'], tmpDir);

		expect(stderr.join('')).not.toContain('Warning');
	});

	it('does not warn about non-blocking links', async () => {
		const other = await newTask('other');
		const task = await newTask('task');
		await runTaskCommand(['link', task.id, 'causedBy', other.id], tmpDir);
		stderr.length = 0;

		await runTaskCommand(['set-status', task.id, 'done'], tmpDir);

		expect(stderr.join('')).not.toContain('Warning');
	});
});
