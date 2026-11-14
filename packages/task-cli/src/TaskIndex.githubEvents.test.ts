import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ownConfigFile } from '@wadeck-app/task-service';
import { FakeGitHub } from '@wadeck-app/task-service/fakeGitHub';

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

// The same use cases emit the events of a project on GitHub as of a local one, after the awaited write, with a payload of the same
// shape (taskProjectId, taskProjectName, taskProjectPath included). A change made on GitHub itself emits nothing in v1 (R7).
const TOKEN_VARIABLE = 'TASK_CLI_EVENTS_GITHUB_TOKEN';

interface Pushed {
	event: string;
	keys: string[];
	payload: Record<string, unknown>;
}

let tmpDir: string;
let configHome: string;
let previousXdg: string | undefined;
let local: RegisteredTestProject;
let github: RegisteredTestProject;
let fake: FakeGitHub;

const pushed = (): Pushed[] =>
	publishMock.mock.calls.map(call => {
		const payload = JSON.parse(JSON.stringify(call[1])) as Record<string, unknown>;
		return { event: call[0] as string, keys: Object.keys(payload).sort(), payload };
	});

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-events-github-'));
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
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
	vi.stubEnv(TOKEN_VARIABLE, fake.token);
	local = await registerTestProject(path.join(tmpDir, 'local'));
	github = await registerTestProject(path.join(tmpDir, 'remote'));
	fs.writeFileSync(
		ownConfigFile(github.storage),
		`statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
strategy:
    type: github
    options:
        repo: acme/shop
        baseUrl: ${fake.baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        cache: { ttlSeconds: 0 }
        timeoutSeconds: 3
        writeSpacingSeconds: 0
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status:in-progress' }
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
async function bothProjects(script: Script): Promise<{ local: Pushed[]; github: Pushed[] }> {
	const play = async (project: RegisteredTestProject): Promise<Pushed[]> => {
		const run = (...args: string[]) => runTaskCommand(['-p', project.name, ...args], project.dir);
		const a = (JSON.parse((await run('new', 'First task')).output) as { id: string }).id;
		const b = (JSON.parse((await run('new', 'Second task')).output) as { id: string }).id;
		publishMock.mockClear();
		await script(run, [a, b]);
		return pushed();
	};
	return { local: await play(local), github: await play(github) };
}

const shape = (events: Pushed[]): Array<[string, string[]]> => events.map(event => [event.event, event.keys]);

describe('queue events: a github project emits what a local one does', () => {
	it('creation, status, labels, type, parent, link and comment: same events, same payload keys', async () => {
		const events = await bothProjects(async (run, [a, b]) => {
			await run('set-status', a, 'in-progress');
			await run('add-label', a, 'urgent');
			await run('remove-label', a, 'urgent');
			await run('set-type', a, 'bug');
			await run('set-parent', b, a);
			await run('link', b, 'blockedBy', a);
			await run('comment', a, 'hello');
			await run('set-status', a, 'done');
		});

		expect(events.github.map(event => event.event)).toEqual([
			'onStatusChange',
			'onTaskLabelAdded',
			'onTaskLabelRemoved',
			'onTaskTypeChanged',
			'onTaskParentChanged',
			'onTaskLinked',
			'onTaskCommentAdded',
			'onStatusChange',
			'onTaskUnblocked',
		]);
		// One declared difference: GitHub writes a comment as the user of the token, so the comment event always carries `author`
		// (a local comment has one only when --author is given).
		const comment = events.github.find(event => event.event === 'onTaskCommentAdded')!;
		expect(comment.payload['author']).toBe('fake-user');
		const withoutAuthor = events.github.map(event =>
			event.event === 'onTaskCommentAdded'
				? { ...event, keys: event.keys.filter(key => key !== 'author') }
				: event
		);
		expect(shape(withoutAuthor)).toEqual(shape(events.local));
	});

	it('the creation event carries the same keys, and the project of the github task (id, name, folder)', async () => {
		publishMock.mockClear();
		await runTaskCommand(['-p', github.name, 'new', 'Brand new'], github.dir);

		const [event] = pushed();
		expect(event!.event).toBe('onTaskCreated');
		expect(event!.payload).toMatchObject({
			taskId: '1',
			status: 'backlog',
			description: 'Brand new',
			labels: [],
			taskProjectId: github.id,
			taskProjectName: github.name,
			taskProjectPath: github.dir,
		});
		expect(Object.keys(event!.payload).sort()).toEqual(
			['description', 'labels', 'status', 'taskId', 'taskProjectId', 'taskProjectName', 'taskProjectPath'].sort()
		);
	});

	it('is pushed after the write reached GitHub, never before, and never when GitHub refused it', async () => {
		const order: string[] = [];
		publishMock.mockImplementation(() => {
			order.push(`publish after ${fake.writes().length} write(s)`);
			return Promise.resolve({ status: 'queued', eventId: 'e' });
		});
		await runTaskCommand(['-p', github.name, 'new', 'Task'], github.dir);
		expect(order).toEqual(['publish after 1 write(s)']);

		publishMock.mockClear();
		fake.failNext({ status: 422, method: 'PATCH', body: { message: 'Validation Failed' } });
		const refused = await runTaskCommand(['-p', github.name, 'set-status', '1', 'done'], github.dir);

		expect(refused.exitCode).toBe(1);
		expect(publishMock).not.toHaveBeenCalled();
	});

	it('a change made on GitHub itself emits nothing: reading the project pushes no event (v1, decision R7)', async () => {
		await runTaskCommand(['-p', github.name, 'new', 'Task'], github.dir);
		publishMock.mockClear();
		fake.updateIssue(1, { labels: ['status:in-progress'] });
		fake.addComment(1, 'someone commented');

		const shown = await runTaskCommand(['-p', github.name, 'show', '1', '--json'], github.dir);
		const listed = await runTaskCommand(['-p', github.name, 'list', '--json'], github.dir);

		expect(JSON.parse(shown.output)).toMatchObject({ status: 'in-progress' });
		expect(listed.exitCode).toBe(0);
		expect(publishMock).not.toHaveBeenCalled();
	});
});

describe('priority, assignee and claim on a github project', () => {
	const commands: string[][] = [
		['set-priority', '1', 'high'],
		['unset-priority', '1'],
		['set-assignee', '1', 'bob'],
		['unset-assignee', '1'],
		['claim', '1', '--as', 'w1'],
		['release', '1'],
	];

	it.each(commands)(
		'%s is refused with exit 1, the strategy and the local alternative, and raises no event',
		async (...args) => {
			await runTaskCommand(['-p', github.name, 'new', 'Task'], github.dir);
			publishMock.mockClear();

			const text = await runTaskCommand(['-p', github.name, ...args], github.dir);
			const asJson = await runTaskCommand(['-p', github.name, ...args, '--json'], github.dir);

			expect(text.exitCode).toBe(1);
			expect(text.output).toContain('github');
			expect(text.output).toMatch(/local/);
			expect(asJson.exitCode).toBe(1);
			const body = JSON.parse(asJson.output) as { error: string; hint: string };
			expect(body.error).toContain('github');
			expect(body.hint).toMatch(/local/);
			expect(publishMock).not.toHaveBeenCalled();
		}
	);
});
