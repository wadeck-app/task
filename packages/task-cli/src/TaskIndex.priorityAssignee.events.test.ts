import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerTestProject } from './testHelpers.js';

// Queue delivery is observed at the SDK boundary, like in TaskIndex.comments.events.test.ts: the SDK is faked so no real queue is needed.
const publishMock = vi.hoisted(() => vi.fn());
const flushMock = vi.hoisted(() => vi.fn());
const registerMock = vi.hoisted(() => vi.fn());
const createPublisherMock = vi.hoisted(() => vi.fn());
vi.mock('@wadeck-app/queue-sdk', () => ({ createQueuePublisher: createPublisherMock }));

// The setup file swaps the queue sink for an instant fake: this file tests the real one (with a faked SDK).
vi.unmock('@wadeck-app/task-service');

import { runTaskCommand } from './TaskIndex.js';

interface PushedEvent {
	event: string;
	payload: Record<string, unknown>;
}

let tmpDir: string;
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
	vi.stubEnv('TASK_WORKER', '');
	publishMock.mockImplementation(() => Promise.resolve({ status: 'queued', eventId: 'e1' }));
	flushMock.mockImplementation(() => Promise.resolve());
	registerMock.mockImplementation(() => Promise.resolve({ status: 'registered', count: 5 }));
	createPublisherMock.mockImplementation(() => ({
		publishAndWait: publishMock,
		registerEvents: registerMock,
		flush: flushMock,
	}));
	await registerTestProject(tmpDir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(tmpDir, { recursive: true, force: true });
	fs.rmSync(configHome, { recursive: true, force: true });
	if (previousXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
	else process.env['XDG_CONFIG_HOME'] = previousXdg;
});

async function newTask(title = 'task'): Promise<string> {
	const created = JSON.parse((await runTaskCommand(['new', title], tmpDir)).output) as { id: string };
	publishMock.mockClear();
	return created.id;
}

describe('queue events - priority', () => {
	it('set-priority pushes onTaskPriorityChanged once, with the old priority when there was one, and nothing for the same value', async () => {
		const id = await newTask();

		await runTaskCommand(['set-priority', id.slice(0, 4), 'high'], tmpDir);
		await runTaskCommand(['set-priority', id, 'high'], tmpDir);
		await runTaskCommand(['set-priority', id, 'low'], tmpDir);

		const events = pushedEvents();
		expect(events.map(e => e.event)).toEqual(['onTaskPriorityChanged', 'onTaskPriorityChanged']);
		expect(events[0]!.payload).toMatchObject({ taskId: id, newPriority: 'high', taskProjectPath: tmpDir });
		expect(events[0]!.payload).not.toHaveProperty('oldPriority');
		expect(events[1]!.payload).toMatchObject({ taskId: id, oldPriority: 'high', newPriority: 'low' });
	});

	it('unset-priority pushes the old one and no new one; nothing when the task had none', async () => {
		const id = await newTask();
		await runTaskCommand(['unset-priority', id], tmpDir);
		expect(pushedEvents()).toEqual([]);
		await runTaskCommand(['set-priority', id, 'urgent'], tmpDir);
		publishMock.mockClear();

		await runTaskCommand(['unset-priority', id], tmpDir);

		const events = pushedEvents();
		expect(events.map(e => e.event)).toEqual(['onTaskPriorityChanged']);
		expect(events[0]!.payload).toMatchObject({ taskId: id, oldPriority: 'urgent' });
		expect(events[0]!.payload).not.toHaveProperty('newPriority');
	});

	it('pushes nothing when the priority is refused', async () => {
		const id = await newTask();

		await runTaskCommand(['set-priority', id, 'whenever'], tmpDir);

		expect(pushedEvents()).toEqual([]);
	});
});

describe('queue events - assignee, claim and release', () => {
	it('set-assignee and unset-assignee push onTaskAssigneeChanged without outcome; nothing when unchanged', async () => {
		const id = await newTask();

		await runTaskCommand(['set-assignee', id, 'Ada', 'L'], tmpDir);
		await runTaskCommand(['set-assignee', id, 'Ada L'], tmpDir);
		await runTaskCommand(['unset-assignee', id], tmpDir);
		await runTaskCommand(['unset-assignee', id], tmpDir);

		const events = pushedEvents();
		expect(events.map(e => e.event)).toEqual(['onTaskAssigneeChanged', 'onTaskAssigneeChanged']);
		expect(events[0]!.payload).toMatchObject({ taskId: id, newAssignee: 'Ada L' });
		expect(events[0]!.payload).not.toHaveProperty('oldAssignee');
		expect(events[0]!.payload).not.toHaveProperty('outcome');
		expect(events[1]!.payload).toMatchObject({ taskId: id, oldAssignee: 'Ada L' });
		expect(events[1]!.payload).not.toHaveProperty('newAssignee');
	});

	it('claim pushes one onTaskAssigneeChanged with outcome claimed', async () => {
		const id = await newTask();

		await runTaskCommand(['claim', id, '--as', 'w1'], tmpDir);

		const events = pushedEvents();
		expect(events.map(e => e.event)).toEqual(['onTaskAssigneeChanged']);
		expect(events[0]!.payload).toMatchObject({ taskId: id, newAssignee: 'w1', outcome: 'claimed' });
		expect(events[0]!.payload).not.toHaveProperty('oldAssignee');
	});

	it('--renew pushes outcome renewed with the same name on both sides; --force pushes a takeover with the old holder', async () => {
		const id = await newTask();
		await runTaskCommand(['claim', id, '--as', 'w1'], tmpDir);
		publishMock.mockClear();

		await runTaskCommand(['claim', id, '--as', 'w1', '--renew'], tmpDir);
		await runTaskCommand(['claim', id, '--as', 'w2', '--force'], tmpDir);

		const events = pushedEvents();
		expect(events.map(e => e.payload['outcome'])).toEqual(['renewed', 'takeover']);
		expect(events[0]!.payload).toMatchObject({ oldAssignee: 'w1', newAssignee: 'w1' });
		expect(events[1]!.payload).toMatchObject({ oldAssignee: 'w1', newAssignee: 'w2' });
	});

	it('a refused claim pushes nothing (live lease of another worker, own lease without --renew, bad lease, no name)', async () => {
		const id = await newTask();
		await runTaskCommand(['claim', id, '--as', 'w1'], tmpDir);
		publishMock.mockClear();

		const results = [
			await runTaskCommand(['claim', id, '--as', 'w2'], tmpDir),
			await runTaskCommand(['claim', id, '--as', 'w1'], tmpDir),
			await runTaskCommand(['claim', id, '--as', 'w3', '--lease', '30s', '--force'], tmpDir),
			await runTaskCommand(['claim', id], tmpDir),
		];

		expect(results.map(result => result.exitCode)).toEqual([1, 1, 1, 1]);
		expect(pushedEvents()).toEqual([]);
	});

	it('release pushes outcome released with the old holder and no new assignee; a refused release pushes nothing', async () => {
		const id = await newTask();
		await runTaskCommand(['release', id], tmpDir);
		await runTaskCommand(['claim', id, '--as', 'w1'], tmpDir);
		publishMock.mockClear();

		await runTaskCommand(['release', id, '--as', 'w2'], tmpDir);
		expect(pushedEvents()).toEqual([]);
		await runTaskCommand(['release', id], tmpDir);

		const events = pushedEvents();
		expect(events.map(e => e.event)).toEqual(['onTaskAssigneeChanged']);
		expect(events[0]!.payload).toMatchObject({ taskId: id, oldAssignee: 'w1', outcome: 'released' });
		expect(events[0]!.payload).not.toHaveProperty('newAssignee');
	});
});
