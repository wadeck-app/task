import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ownConfigFile } from '@wadeck-app/task-service';
import { FakeGitLab } from '@wadeck-app/task-service/fakeGitLab';

import { registerTestProject } from './testHelpers.js';
import type { RegisteredTestProject } from './testHelpers.js';

// Queue delivery is observed at the SDK boundary, like in TaskIndex.events.test.ts: the SDK is faked so no queue is needed.
const publishMock = vi.hoisted(() => vi.fn());
const flushMock = vi.hoisted(() => vi.fn());
const registerMock = vi.hoisted(() => vi.fn());
const createPublisherMock = vi.hoisted(() => vi.fn());
vi.mock('@wadeck-app/queue-sdk', () => ({ createQueuePublisher: createPublisherMock }));

// The setup file swaps the queue sink for an instant fake: this file tests the real one (with a faked SDK).
vi.unmock('@wadeck-app/task-service');

import { runTaskCommand } from './TaskIndex.js';

// The same use cases emit the events of a project on GitLab as of a local one, after the awaited write, with a payload of the same
// shape. A change made on GitLab itself emits nothing in v1 (R7). NOT verified against a real GitLab (fake server).
const TOKEN_VARIABLE = 'TASK_CLI_EVENTS_GITLAB_TOKEN';

interface Pushed {
	event: string;
	keys: string[];
	payload: Record<string, unknown>;
}

let tmpDir: string;
let configHome: string;
let previousXdg: string | undefined;
let local: RegisteredTestProject;
let gitlab: RegisteredTestProject;
let fake: FakeGitLab;

const pushed = (): Pushed[] =>
	publishMock.mock.calls.map(call => {
		const payload = JSON.parse(JSON.stringify(call[1])) as Record<string, unknown>;
		return { event: call[0] as string, keys: Object.keys(payload).sort(), payload };
	});

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-events-gitlab-'));
	configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'task-events-config-'));
	previousXdg = process.env['XDG_CONFIG_HOME'];
	process.env['XDG_CONFIG_HOME'] = configHome;
	publishMock.mockImplementation(() => Promise.resolve({ status: 'queued', eventId: 'e1' }));
	flushMock.mockImplementation(() => Promise.resolve());
	registerMock.mockImplementation(() => Promise.resolve({ status: 'registered', count: 5 }));
	createPublisherMock.mockImplementation(() => ({
		publishAndWait: publishMock,
		registerEvents: registerMock,
		flush: flushMock,
	}));
	// Premium: blocking links exist, so the same script as a local project can run (no parent: GitLab has none).
	fake = await FakeGitLab.start({ project: 'acme/shop', tier: 'premium' });
	vi.stubEnv(TOKEN_VARIABLE, fake.token);
	local = await registerTestProject(path.join(tmpDir, 'local'));
	gitlab = await registerTestProject(path.join(tmpDir, 'remote'));
	fs.writeFileSync(
		ownConfigFile(gitlab.storage),
		`statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
strategy:
    type: gitlab
    options:
        project: acme/shop
        tier: premium
        baseUrl: ${fake.baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        cache: { ttlSeconds: 0 }
        timeoutSeconds: 3
        writeSpacingSeconds: 0
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status::in-progress' }
            done: { state: closed }
`
	);
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await fake.stop();
	fs.rmSync(tmpDir, { recursive: true, force: true });
	fs.rmSync(configHome, { recursive: true, force: true });
	if (previousXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
	else process.env['XDG_CONFIG_HOME'] = previousXdg;
});

type Script = (
	run: (...args: string[]) => Promise<{ exitCode: number; output: string }>,
	ids: [string, string]
) => Promise<void>;

/** Runs the same script on both projects; returns the events each pushed. */
async function bothProjects(script: Script): Promise<{ local: Pushed[]; gitlab: Pushed[] }> {
	const play = async (project: RegisteredTestProject): Promise<Pushed[]> => {
		const run = (...args: string[]) => runTaskCommand(['-p', project.name, ...args], project.dir);
		const a = (JSON.parse((await run('new', 'First task')).output) as { id: string }).id;
		const b = (JSON.parse((await run('new', 'Second task')).output) as { id: string }).id;
		publishMock.mockClear();
		await script(run, [a, b]);
		return pushed();
	};
	return { local: await play(local), gitlab: await play(gitlab) };
}

const shape = (events: Pushed[]): Array<[string, string[]]> => events.map(event => [event.event, event.keys]);

describe('queue events: a gitlab project emits what a local one does', () => {
	it('status, labels, type, link and comment: same events, same payload keys', async () => {
		const events = await bothProjects(async (run, [a, b]) => {
			await run('set-status', a, 'in-progress');
			await run('add-label', a, 'urgent');
			await run('remove-label', a, 'urgent');
			await run('set-type', a, 'bug');
			await run('link', b, 'blockedBy', a);
			await run('comment', a, 'hello');
			await run('set-status', a, 'done');
		});

		expect(events.gitlab.map(event => event.event)).toEqual([
			'onStatusChange',
			'onTaskLabelAdded',
			'onTaskLabelRemoved',
			'onTaskTypeChanged',
			'onTaskLinked',
			'onTaskCommentAdded',
			'onStatusChange',
			'onTaskUnblocked',
		]);
		// One declared difference: GitLab writes a comment as the user of the token, so the comment event always carries `author`.
		const comment = events.gitlab.find(event => event.event === 'onTaskCommentAdded')!;
		expect(comment.payload['author']).toBe('tester');
		const withoutAuthor = events.gitlab.map(event =>
			event.event === 'onTaskCommentAdded'
				? { ...event, keys: event.keys.filter(key => key !== 'author') }
				: event
		);
		expect(shape(withoutAuthor)).toEqual(shape(events.local));
	});

	it('the creation event carries the project of the gitlab task (id, name, folder)', async () => {
		publishMock.mockClear();
		await runTaskCommand(['-p', gitlab.name, 'new', 'Brand new'], gitlab.dir);

		const [event] = pushed();
		expect(event!.event).toBe('onTaskCreated');
		expect(event!.payload).toMatchObject({
			taskId: '1',
			status: 'backlog',
			description: 'Brand new',
			labels: [],
			taskProjectId: gitlab.id,
			taskProjectName: gitlab.name,
			taskProjectPath: gitlab.dir,
		});
	});

	it('is pushed after the write reached GitLab, never before, and never when GitLab or the backend refused it', async () => {
		const order: string[] = [];
		publishMock.mockImplementation(() => {
			order.push(`publish after ${fake.writes().length} write(s)`);
			return Promise.resolve({ status: 'queued', eventId: 'e' });
		});
		await runTaskCommand(['-p', gitlab.name, 'new', 'Task'], gitlab.dir);
		expect(order).toEqual(['publish after 1 write(s)']);

		publishMock.mockClear();
		fake.failNext({ status: 400, method: 'PUT', body: { message: { labels: ['are invalid'] } } });
		const refused = await runTaskCommand(['-p', gitlab.name, 'set-status', '1', 'done'], gitlab.dir);
		const noParent = await runTaskCommand(['-p', gitlab.name, 'set-parent', '1', '1'], gitlab.dir);

		expect(refused.exitCode).toBe(1);
		expect(noParent.exitCode).toBe(1);
		expect(publishMock).not.toHaveBeenCalled();
	});

	it('a change made on GitLab itself emits nothing: reading the project pushes no event (v1, decision R7)', async () => {
		await runTaskCommand(['-p', gitlab.name, 'new', 'Task'], gitlab.dir);
		publishMock.mockClear();
		fake.seedNote(1, 'someone commented');

		const shown = await runTaskCommand(['-p', gitlab.name, 'show', '1', '--json'], gitlab.dir);
		const listed = await runTaskCommand(['-p', gitlab.name, 'list', '--json'], gitlab.dir);

		expect(shown.exitCode).toBe(0);
		expect(listed.exitCode).toBe(0);
		expect(publishMock).not.toHaveBeenCalled();
	});
});
