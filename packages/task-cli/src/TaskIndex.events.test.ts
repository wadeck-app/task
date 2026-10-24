import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Queue delivery is observed at the SDK boundary: the CLI publishes through @wadeck-app/queue-sdk (publishAndWait, then flush).
// The SDK is faked so no real queue is needed (or touched).
const publishMock = vi.hoisted(() => vi.fn());
const flushMock = vi.hoisted(() => vi.fn());
const registerMock = vi.hoisted(() => vi.fn());
const createPublisherMock = vi.hoisted(() => vi.fn());
vi.mock('@wadeck-app/queue-sdk', () => ({ createQueuePublisher: createPublisherMock }));

interface Outcome {
	status: string;
	eventId?: string;
	reason?: string;
}
const queuedOutcome: Outcome = { status: 'queued', eventId: 'e1' };

// The setup file swaps the queue sink for an instant fake: this file tests the real one (with a faked SDK).
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
	return publishMock.mock.calls.map(call => ({
		event: call[0] as string,
		// Through JSON, like the wire: undefined fields are absent.
		payload: JSON.parse(JSON.stringify(call[1])) as Record<string, unknown>,
	}));
}

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-events-test-'));
	configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'task-events-config-'));
	previousXdg = process.env['XDG_CONFIG_HOME'];
	process.env['XDG_CONFIG_HOME'] = configHome;
	// mockReset (vitest config) clears implementations between tests: re-arm the fake publisher.
	publishMock.mockImplementation(() => Promise.resolve(queuedOutcome));
	flushMock.mockImplementation(() => Promise.resolve());
	registerMock.mockImplementation(() => Promise.resolve({ status: 'registered', count: 5 }));
	createPublisherMock.mockImplementation(() => ({
		publishAndWait: publishMock,
		registerEvents: registerMock,
		flush: flushMock,
	}));
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
		publishMock.mockClear();

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

	const answerWith = (outcome: Outcome): void => {
		publishMock.mockImplementation(() => Promise.resolve(outcome));
	};

	it('logs an error line (event, task, reason, replay command) when the queue drops the event', async () => {
		const task = await newTask('task');
		answerWith({ status: 'dropped', reason: 'queue is not installed: install queue-cli' });

		const result = await runTaskCommand(['set-status', task.id, 'in-progress'], tmpDir);

		expect(result.exitCode).toBe(0);
		const lines = errorLogLines();
		expect(lines).toHaveLength(1);
		expect(lines[0]!.msg).toContain(
			`queue push 'onStatusChange' for task ${task.id} not delivered: queue is not installed: install queue-cli`
		);
		expect(lines[0]!.msg).toContain(`Replay with: cd '${tmpDir}' && queue push onStatusChange '{`);
		expect(lines[0]!.msg).toContain(`"taskId":"${task.id}"`);
		expect(stderr.join('')).toContain(`for task ${task.id} not delivered: queue is not installed`);
		expect(stderr.join('')).toContain('task cli logs');
	});

	it('logs an error line saying the event MAY be recorded, with the history check, when the outcome is unknown', async () => {
		const task = await newTask('task');
		answerWith({ status: 'unknown', reason: 'the connection was reset' });

		const result = await runTaskCommand(['set-status', task.id, 'in-progress'], tmpDir);

		expect(result.exitCode).toBe(0);
		const lines = errorLogLines();
		expect(lines).toHaveLength(1);
		expect(lines[0]!.msg).toContain('MAY be recorded');
		expect(lines[0]!.msg).toContain('queue history');
		expect(lines[0]!.msg).toContain('queue replay <eventId>');
		expect(lines[0]!.msg).toContain(`"taskId":"${task.id}"`);
		expect(stderr.join('')).toContain('MAY be recorded');
		// Never retried automatically.
		expect(publishMock).toHaveBeenCalledTimes(2);
	});

	it('keeps the exit code 0 and the order of the events when one of them is not delivered', async () => {
		const blocker = await newTask('blocker');
		const blocked = await newTask('blocked');
		await runTaskCommand(['link', blocked.id, 'blockedBy', blocker.id], tmpDir);
		publishMock.mockClear();
		publishMock.mockImplementationOnce(() => Promise.resolve({ status: 'dropped', reason: 'r' }));
		publishMock.mockImplementation(() => Promise.resolve(queuedOutcome));

		const result = await runTaskCommand(['set-status', blocker.id, 'done'], tmpDir);

		expect(result.exitCode).toBe(0);
		expect(pushedEvents().map(e => e.event)).toEqual(['onStatusChange', 'onTaskUnblocked']);
		expect(errorLogLines()).toHaveLength(1);
	});

	it('writes no error line when the event is delivered', async () => {
		const task = await newTask('task');

		await runTaskCommand(['set-status', task.id, 'in-progress'], tmpDir);

		expect(errorLogLines()).toEqual([]);
	});

	it('waits for the SDK flush before the command returns (the process exits right after), and only once per command', async () => {
		const task = await newTask('task');
		flushMock.mockClear();
		let flushDone = false;
		flushMock.mockImplementation(async () => {
			await new Promise(resolve => setTimeout(resolve, 20));
			flushDone = true;
		});

		await runTaskCommand(['set-status', task.id, 'in-progress'], tmpDir);

		expect(flushMock).toHaveBeenCalledTimes(1);
		expect(flushDone).toBe(true);
	});

	it('creates the SDK publisher lazily: none for a command that produces no event', async () => {
		createPublisherMock.mockClear();

		await runTaskCommand(['list'], tmpDir);

		expect(createPublisherMock).not.toHaveBeenCalled();
	});
});

describe('queue events — onStatusChange', () => {
	it('carries the previous status as oldStatus and the new one as newStatus', async () => {
		const task = await newTask('task');
		publishMock.mockClear();

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
		publishMock.mockClear();

		await runTaskCommand(['link', a.id.slice(0, 4), 'blockedBy', b.id.slice(0, 4)], tmpDir);

		const events = pushedEvents();
		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe('onTaskLinked');
		expect(events[0]!.payload).toMatchObject({ taskId: a.id, linkType: 'blockedBy', targetId: b.id });
	});

	it('the inverse spelling is pushed in its stored form (holder, canonical type, target)', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		publishMock.mockClear();

		await runTaskCommand(['link', a.id, 'blocks', b.id], tmpDir);

		expect(pushedEvents()[0]!.payload).toMatchObject({ taskId: b.id, linkType: 'blockedBy', targetId: a.id });
	});

	it('unlink pushes onTaskUnlinked', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		await runTaskCommand(['link', a.id, 'causedBy', b.id], tmpDir);
		publishMock.mockClear();

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
		publishMock.mockClear();

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
		publishMock.mockClear();
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
		publishMock.mockClear();

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
		publishMock.mockClear();

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
		publishMock.mockClear();

		await runTaskCommand(['set-status', blocker.id, 'done'], tmpDir);

		expect(pushedEvents().map(e => e.event)).toEqual(['onStatusChange']);
	});

	it('is not pushed for links that are not blockedBy', async () => {
		const target = await newTask('target');
		const other = await newTask('other');
		await runTaskCommand(['link', other.id, 'causedBy', target.id], tmpDir);
		publishMock.mockClear();

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

// The queue finds .queue/subscribers.yml from the cwd the SDK sends: the CLI must publish with the project it works on, wherever it runs.
describe('queue events — published in the project directory', () => {
	let elsewhere: string;
	const publishCwds = (): unknown[] => publishMock.mock.calls.map(call => (call[2] as { cwd?: string }).cwd);

	beforeEach(() => {
		elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'task-events-elsewhere-'));
	});
	afterEach(() => {
		fs.rmSync(elsewhere, { recursive: true, force: true });
		delete process.env['TASK_PROJECT_DIR'];
		delete process.env['PROJECT_DIR'];
	});

	it('from the cwd when it is the project', async () => {
		publishMock.mockClear();
		await runTaskCommand(['new', 'x'], tmpDir);
		expect(publishCwds()).toEqual([tmpDir]);
	});

	it('from --project-dir, not from the directory the command runs in', async () => {
		publishMock.mockClear();
		const result = await runTaskCommand(['new', 'x', '--project-dir', tmpDir], elsewhere);
		expect(result.exitCode).toBe(0);
		expect(publishCwds()).toEqual([tmpDir]);
	});

	it.each(['TASK_PROJECT_DIR', 'PROJECT_DIR'])('from the %s environment variable', async variable => {
		process.env[variable] = tmpDir;
		publishMock.mockClear();
		const result = await runTaskCommand(['new', 'x'], elsewhere);
		expect(result.exitCode).toBe(0);
		expect(publishCwds()).toEqual([tmpDir]);
	});

	it('for set-status and link too, with --project-dir', async () => {
		const a = await newTask('a');
		const b = await newTask('b');
		publishMock.mockClear();

		await runTaskCommand(['set-status', a.id, 'in-progress', '--project-dir', tmpDir], elsewhere);
		await runTaskCommand(['link', a.id, 'blockedBy', b.id, '--project-dir', tmpDir], elsewhere);

		expect(publishCwds()).toEqual([tmpDir, tmpDir]);
	});
});

describe('queue events — the task events are declared to the queue (registerEvents)', () => {
	const markerFile = (): string => path.join(configHome, 'task', 'queue-events.json');
	const logText = (): string => {
		const logDir = path.join(configHome, 'task', 'logs');
		if (!fs.existsSync(logDir)) return '';
		return fs
			.readdirSync(logDir)
			.map(f => fs.readFileSync(path.join(logDir, f), 'utf8'))
			.join('');
	};

	it('declares the five events under the source task before the first event, and records the marker', async () => {
		const order: string[] = [];
		registerMock.mockImplementation(() => {
			order.push('register');
			return Promise.resolve({ status: 'registered', count: 5 });
		});
		publishMock.mockImplementation(() => {
			order.push('publish');
			return Promise.resolve(queuedOutcome);
		});

		const result = await runTaskCommand(['new', 'x'], tmpDir);

		expect(result.exitCode).toBe(0);
		expect(order).toEqual(['register', 'publish']);
		expect(registerMock).toHaveBeenCalledTimes(1);
		const [source, events] = registerMock.mock.calls[0] as [string, { name: string }[]];
		expect(source).toBe('task');
		expect(events.map(e => e.name).sort()).toEqual([
			'onStatusChange',
			'onTaskCreated',
			'onTaskLinked',
			'onTaskUnblocked',
			'onTaskUnlinked',
		]);
		const marker = JSON.parse(fs.readFileSync(markerFile(), 'utf8')) as Record<string, string>;
		expect(marker['hash']).toMatch(/^[0-9a-f]{64}$/);
		expect(marker['taskVersion']).toBeTruthy();
	});

	it('does not declare again at the next commands (the marker holds the hash)', async () => {
		await runTaskCommand(['new', 'a'], tmpDir);
		await runTaskCommand(['new', 'b'], tmpDir);
		await runTaskCommand(['new', 'c'], tmpDir);

		expect(registerMock).toHaveBeenCalledTimes(1);
		expect(publishMock).toHaveBeenCalledTimes(3);
	});

	it('declares again once the marker holds another hash (the declaration changed)', async () => {
		await runTaskCommand(['new', 'a'], tmpDir);
		fs.writeFileSync(
			markerFile(),
			JSON.stringify({ hash: 'older', taskVersion: 'x', declaredAt: '2020-01-01T00:00:00.000Z' })
		);

		await runTaskCommand(['new', 'b'], tmpDir);

		expect(registerMock).toHaveBeenCalledTimes(2);
	});

	it('does not declare for a command that produces no event', async () => {
		await runTaskCommand(['list'], tmpDir);

		expect(registerMock).not.toHaveBeenCalled();
		expect(fs.existsSync(markerFile())).toBe(false);
	});

	it('never fails the command when the queue refuses or is too old, writes no marker, and retries at the next command', async () => {
		registerMock.mockImplementation(() =>
			Promise.resolve({ status: 'unsupported', reason: 'daemon speaks 1.0.0' })
		);

		const first = await runTaskCommand(['new', 'a'], tmpDir);
		const second = await runTaskCommand(['new', 'b'], tmpDir);

		expect(first.exitCode).toBe(0);
		expect(second.exitCode).toBe(0);
		expect(registerMock).toHaveBeenCalledTimes(2);
		expect(publishMock).toHaveBeenCalledTimes(2);
		expect(fs.existsSync(markerFile())).toBe(false);
		expect(logText()).toContain('daemon speaks 1.0.0');
	});

	it('never fails the command when registerEvents breaks its promise and throws', async () => {
		registerMock.mockImplementation(() => Promise.reject(new Error('register exploded')));

		const result = await runTaskCommand(['new', 'a'], tmpDir);

		expect(result.exitCode).toBe(0);
		expect(publishMock).toHaveBeenCalledTimes(1);
		expect(fs.existsSync(markerFile())).toBe(false);
	});

	describe('task cli declare-events', () => {
		it('declares now even when the marker is up to date, and says how many events', async () => {
			await runTaskCommand(['new', 'a'], tmpDir);
			expect(registerMock).toHaveBeenCalledTimes(1);

			const result = await runTaskCommand(['cli', 'declare-events'], tmpDir);

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain('5 events');
			expect(registerMock).toHaveBeenCalledTimes(2);
		});

		it('answers JSON with --json', async () => {
			const result = await runTaskCommand(['cli', 'declare-events', '--json'], tmpDir);

			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toEqual({ status: 'registered', count: 5 });
		});

		it('works outside a task project (it is about the CLI, not a project)', async () => {
			const result = await runTaskCommand(['cli', 'declare-events'], path.join(tmpDir, 'not-a-project'));

			expect(result.exitCode).toBe(0);
		});

		it('exits 1 with what to do when the queue is too old, and records no marker', async () => {
			registerMock.mockImplementation(() =>
				Promise.resolve({ status: 'unsupported', reason: 'daemon speaks 1.0.0' })
			);

			const result = await runTaskCommand(['cli', 'declare-events'], tmpDir);

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain('daemon speaks 1.0.0');
			expect(result.output).toContain('queue-cli');
			expect(fs.existsSync(markerFile())).toBe(false);
		});

		it('waits for the SDK flush before returning', async () => {
			flushMock.mockClear();

			await runTaskCommand(['cli', 'declare-events'], tmpDir);

			expect(flushMock).toHaveBeenCalledTimes(1);
		});

		it('is listed in the hint of an unknown subcommand', async () => {
			const unknown = await runTaskCommand(['cli', 'nope'], tmpDir);
			expect(unknown.output).toContain('declare-events');
		});
	});
});
