import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerTestProject } from './testHelpers.js';

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
	await registerTestProject(tmpDir);
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	fs.rmSync(configHome, { recursive: true, force: true });
	if (previousXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
	else process.env['XDG_CONFIG_HOME'] = previousXdg;
});

async function newTask(title: string): Promise<{ id: string }> {
	return JSON.parse((await runTaskCommand(['new', title], tmpDir)).output) as { id: string };
}

async function addedComment(id: string, text: string, ...more: string[]): Promise<string> {
	const result = await runTaskCommand(['comment', id, text, ...more, '--json'], tmpDir);
	return (JSON.parse(result.output) as { comment: { id: string } }).comment.id;
}

describe('queue events - comments', () => {
	it('comment pushes onTaskCommentAdded with the FULL text and the author', async () => {
		const task = await newTask('task');
		publishMock.mockClear();
		const text = `${'long words '.repeat(100)}end`;

		const result = await runTaskCommand(['comment', task.id.slice(0, 4), text, '--author', 'alice'], tmpDir);

		expect(result.exitCode).toBe(0);
		const events = pushedEvents();
		expect(events.map(e => e.event)).toEqual(['onTaskCommentAdded']);
		expect(events[0]!.payload).toMatchObject({
			taskId: task.id,
			text: text.trim(),
			author: 'alice',
			taskProjectPath: tmpDir,
		});
		expect(events[0]!.payload['commentId']).toMatch(/^[0-9a-z]{6}$/);
	});

	it('comment-edit pushes onTaskCommentEdited, and nothing when the text is unchanged', async () => {
		const task = await newTask('task');
		const commentId = await addedComment(task.id, 'old');
		publishMock.mockClear();

		await runTaskCommand(['comment-edit', task.id, commentId, 'new'], tmpDir);
		await runTaskCommand(['comment-edit', task.id, commentId, 'new'], tmpDir);

		const events = pushedEvents();
		expect(events.map(e => e.event)).toEqual(['onTaskCommentEdited']);
		expect(events[0]!.payload).toMatchObject({ taskId: task.id, commentId, oldText: 'old', newText: 'new' });
	});

	it('comment-rm pushes onTaskCommentRemoved', async () => {
		const task = await newTask('task');
		const commentId = await addedComment(task.id, 'x');
		publishMock.mockClear();

		await runTaskCommand(['comment-rm', task.id, commentId], tmpDir);

		const events = pushedEvents();
		expect(events.map(e => e.event)).toEqual(['onTaskCommentRemoved']);
		expect(events[0]!.payload).toMatchObject({ taskId: task.id, commentId });
	});

	it('pushes nothing when the command fails (blank text, unknown task, unknown comment)', async () => {
		const task = await newTask('task');
		publishMock.mockClear();

		await runTaskCommand(['comment', task.id, '  '], tmpDir);
		await runTaskCommand(['comment', 'zzzzzz', 'x'], tmpDir);
		await runTaskCommand(['comment-edit', task.id, 'nope00', 'x'], tmpDir);
		await runTaskCommand(['comment-rm', task.id, 'nope00'], tmpDir);

		expect(pushedEvents()).toEqual([]);
	});

	it('deleting a task that has comments carries commentCount in onTaskDeleted', async () => {
		const task = await newTask('task');
		await addedComment(task.id, 'a');
		await addedComment(task.id, 'b');
		publishMock.mockClear();

		await runTaskCommand(['delete', task.id], tmpDir);

		const events = pushedEvents();
		expect(events.map(e => e.event)).toEqual(['onTaskDeleted']);
		expect(events[0]!.payload['commentCount']).toBe(2);
	});
});
