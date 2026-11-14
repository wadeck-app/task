import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openResolvedProject, ownConfigFile, resolveProject, startTaskServer } from '@wadeck-app/task-service';
import type { EventDelivery, RunningTaskServer, TaskEvent } from '@wadeck-app/task-service';

import { registerTestProject } from './testHelpers.js';
import type { RegisteredTestProject } from './testHelpers.js';

// Queue delivery of THIS process is observed at the SDK boundary, like in TaskIndex.githubEvents.test.ts: a remote project must
// deliver nothing from here (its server raises the events), and the server's own sink sees them.
const publishMock = vi.hoisted(() => vi.fn());
const flushMock = vi.hoisted(() => vi.fn());
const registerMock = vi.hoisted(() => vi.fn());
const createPublisherMock = vi.hoisted(() => vi.fn());
vi.mock('@wadeck-app/queue-sdk', () => ({ createQueuePublisher: createPublisherMock }));

// The setup file swaps the queue sink for an instant fake: this file tests the real one (with a faked SDK).
vi.unmock('@wadeck-app/task-service');

import { runTaskCommand } from './TaskIndex.js';

const TOKEN = 'cli-remote-token-0123456789';
const TOKEN_VARIABLE = 'TASK_CLI_REMOTE_TOKEN';

let tmpDir: string;
let served: RegisteredTestProject;
let client: RegisteredTestProject;
let server: RunningTaskServer;
let serverEvents: TaskEvent[];
let serverOutcome: (event: TaskEvent) => EventDelivery;
let stderr: string[];

const run = (...args: string[]) => runTaskCommand(['-p', client.name, ...args], client.dir);
const json = (output: string): any => JSON.parse(output);

function writeClientConfig(url: string, extra = ''): void {
	fs.writeFileSync(
		ownConfigFile(client.storage),
		`statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
strategy:
    type: remote
    options:
${extra}        transport:
            type: plain-http
            options:
                url: ${url}
                tokenEnv: ${TOKEN_VARIABLE}
                timeoutSeconds: 3
`
	);
}

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-serve-'));
	publishMock.mockImplementation(() => Promise.resolve({ status: 'queued', eventId: 'e1' }));
	flushMock.mockImplementation(() => Promise.resolve());
	registerMock.mockImplementation(() => Promise.resolve({ status: 'registered', count: 5 }));
	createPublisherMock.mockImplementation(() => ({
		publishAndWait: publishMock,
		registerEvents: registerMock,
		flush: flushMock,
	}));
	vi.stubEnv(TOKEN_VARIABLE, TOKEN);
	served = await registerTestProject(path.join(tmpDir, 'served'));
	client = await registerTestProject(path.join(tmpDir, 'client'));
	serverEvents = [];
	serverOutcome = () => ({ delivered: true });
	server = await startTaskServer({
		ctx: openResolvedProject(resolveProject({ cwd: served.dir, projectRef: served.id })),
		token: TOKEN,
		failedAuthDelayMs: 0,
		eventSink: {
			deliver: event => {
				serverEvents.push(event);
				return Promise.resolve(serverOutcome(event));
			},
		},
	});
	writeClientConfig(server.url);
	stderr = [];
	vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
		stderr.push(String(chunk));
		return true;
	});
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await server.close();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('task commands on a remote project', () => {
	it('create, show, list, set-status, comment, link and delete go to the server: the data lands in ITS folder, none on this machine', async () => {
		const a = json((await run('new', 'First task')).output).id as string;
		const b = json((await run('new', 'Second task')).output).id as string;

		const status = await run('set-status', a, 'in-progress');
		const comment = await run('comment', a, 'hello from the other machine');
		const link = await run('link', b, 'blockedBy', a);
		const list = await run('list', '--json');
		const show = await run('show', a, '--json');

		for (const result of [status, comment, link, list, show]) expect(result.exitCode, result.output).toBe(0);
		expect(
			json(list.output)
				.map((task: { id: string }) => task.id)
				.sort()
		).toEqual([a, b].sort());
		expect(json(show.output).status).toBe('in-progress');
		// On the serving machine:
		expect(fs.existsSync(path.join(served.tasksDir, `${a}.json`))).toBe(true);
		const stored = JSON.parse(fs.readFileSync(path.join(served.tasksDir, `${a}.json`), 'utf8'));
		expect(stored.comments[0].text).toBe('hello from the other machine');
		// On this one: nothing at all.
		expect(fs.existsSync(client.tasksDir)).toBe(false);
		expect(fs.existsSync(path.join(client.storage.dataDir, 'task-index.json'))).toBe(false);

		const deleted = await run('delete', b);
		expect(deleted.exitCode, deleted.output).toBe(0);
		expect(fs.existsSync(path.join(served.tasksDir, `${b}.json`))).toBe(false);
	});

	it('the events are raised by the server and by nobody else: the queue of THIS process receives none', async () => {
		const a = json((await run('new', 'First task')).output).id as string;
		const b = json((await run('new', 'Second task')).output).id as string;
		await run('link', b, 'blockedBy', a);
		await run('set-status', a, 'done');
		await run('comment', a, 'bye');
		await run('delete', b);

		expect(serverEvents.map(event => event.name)).toEqual([
			'onTaskCreated',
			'onTaskCreated',
			'onTaskLinked',
			'onStatusChange',
			'onTaskUnblocked',
			'onTaskCommentAdded',
			'onTaskDeleted',
		]);
		expect(serverEvents[0]!.payload).toMatchObject({
			taskProjectId: served.id,
			taskProjectName: served.name,
			taskProjectPath: served.dir,
		});
		expect(JSON.stringify(serverEvents)).not.toContain(client.dir.replaceAll('\\', '\\\\'));
		// Nothing from this process: not even the declaration of the events to the queue.
		expect(publishMock).not.toHaveBeenCalled();
		expect(registerMock).not.toHaveBeenCalled();
	});

	it('an event the server could not deliver is a warning on stderr, the command still succeeds', async () => {
		serverOutcome = () => ({ delivered: false, reason: 'queue daemon not running', status: 'dropped' });

		const created = await run('new', 'First task');

		expect(created.exitCode, created.output).toBe(0);
		expect(stderr.join('')).toMatch(
			/warning: the change is saved on 127\.0\.0\.1:\d+, but the server could not deliver the event onTaskCreated/
		);
		expect(stderr.join('')).toContain('queue daemon not running');
	});

	it('a local project of the same process still raises its own events (the rule is per project)', async () => {
		const local = await registerTestProject(path.join(tmpDir, 'plain'));

		const created = await runTaskCommand(['-p', local.name, 'new', 'A local task'], local.dir);

		expect(created.exitCode, created.output).toBe(0);
		expect(publishMock).toHaveBeenCalledTimes(1);
		expect(publishMock.mock.calls[0]![0]).toBe('onTaskCreated');
	});
});

describe('failures, said the same way as for any project', () => {
	it('a server that is not running is exit 1 with the address and what to check, in text and in JSON', async () => {
		await server.close();

		const text = await run('list');
		const asJson = await run('list', '--json');

		expect(text.exitCode).toBe(1);
		expect(text.output).toContain(`Cannot reach ${new URL(server.url).host}`);
		expect(text.output).toContain('Is "task serve" running');
		expect(text.output).toContain('task strategy check');
		expect(asJson.exitCode).toBe(1);
		expect(json(asJson.output)).toMatchObject({ error: expect.stringContaining('Cannot reach') });
		expect(json(asJson.output).hint).toContain('task serve');
	});

	it('a wrong token names the server and what to compare; the token itself is never printed', async () => {
		vi.stubEnv(TOKEN_VARIABLE, 'a-wrong-token-0123456789');

		const result = await run('list');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('refused the token');
		expect(result.output).toContain('task serve was started with');
		expect(result.output).not.toContain('a-wrong-token');
		expect(result.output).not.toContain(TOKEN);
	});

	it('no token on this machine is said before anything is sent, with the variable to set', async () => {
		vi.stubEnv(TOKEN_VARIABLE, '');

		const result = await run('list');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(`${TOKEN_VARIABLE} is not set`);
		expect(result.output).toContain(`export ${TOKEN_VARIABLE}=<token>`);
	});

	it('a conflict is the same error as on a local project', async () => {
		const a = json((await run('new', 'First task')).output).id as string;

		const result = await run('set-status', a, 'backlog');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('already in status "backlog"');
	});

	it('a project name that the server does not serve is refused before any write', async () => {
		writeClientConfig(server.url, '        project: warehouse\n');

		const result = await run('new', 'Oops');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(`serves project "${served.name}"`);
		expect(result.output).toContain('strategy.options.project');
		expect(fs.existsSync(served.tasksDir)).toBe(false);
	});
});

describe('task strategy show and check on a remote project', () => {
	it('show prints the transport, the token as a name, and that the events are raised by the server, without contacting it', async () => {
		await server.close();

		const result = await run('strategy', 'show');

		expect(result.exitCode, result.output).toBe(0);
		expect(result.output).toContain('remote');
		expect(result.output).toContain('plugins.plain-http.default');
		expect(result.output).toContain(`${TOKEN_VARIABLE} (environment variable, set)`);
		expect(result.output).toMatch(/events\s+native\s+server/);
		expect(result.output).not.toContain(TOKEN);
	});

	it('check reaches the server and reports every line; exit 0 when healthy', async () => {
		const result = await run('strategy', 'check');

		expect(result.exitCode, result.output).toBe(0);
		for (const name of ['reachable', 'auth', 'protocol', 'project', 'capabilities', 'statuses', 'events']) {
			expect(result.output).toMatch(new RegExp(`\\n\\s+${name}\\s+ok\\s`));
		}
		expect(result.output).toContain('Result: ok');
		expect(result.output).toContain(`"${served.name}" (${served.id})`);
	});

	it('check fails with exit 1 and the fix when the server is gone', async () => {
		await server.close();

		const result = await run('strategy', 'check');

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(/reachable\s+error/);
		expect(result.output).toContain('fix: Is "task serve" running');
		expect(result.output).toContain('Result: FAILED');
	});
});

describe('priority, assignee and claim on a remote project', () => {
	const commands: string[][] = [
		['set-priority', 'ID', 'high'],
		['unset-priority', 'ID'],
		['set-assignee', 'ID', 'bob'],
		['unset-assignee', 'ID'],
		['claim', 'ID', '--as', 'w1'],
		['release', 'ID'],
	];

	it.each(commands)(
		'%s is refused with exit 1 naming the remote strategy, and nothing is raised',
		async (...args) => {
			const id = json((await run('new', 'First task')).output).id as string;
			serverEvents.length = 0;
			const withId = args.map(arg => (arg === 'ID' ? id : arg));

			const text = await run(...withId);
			const asJson = await run(...withId, '--json');

			expect(text.exitCode).toBe(1);
			expect(text.output).toContain('remote');
			expect(asJson.exitCode).toBe(1);
			expect(json(asJson.output)).toMatchObject({
				error: expect.stringContaining('remote'),
				hint: expect.any(String),
			});
			expect(serverEvents).toEqual([]);
			expect(publishMock).not.toHaveBeenCalled();
		}
	);
});
