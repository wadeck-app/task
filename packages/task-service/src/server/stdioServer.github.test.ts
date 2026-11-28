import { Readable } from 'node:stream';

import { UnsupportedByBackendError } from '@wadeck-app/task-core';
import type { TaskResolvedConfig } from '@wadeck-app/task-core';
import { afterEach, describe, expect, it } from 'vitest';

import type { TaskServiceContext } from '../context.js';
import type { EventDelivery, EventSink, TaskEvent } from '../events.js';
import { FakeGitHub } from '../plugins/github/fakeGitHub.testkit.js';
import { WRITE_STATUS_MAP, WRITE_STATUSES, makeGitHubBackend } from '../plugins/github/githubBackend.testkit.js';
import { GITHUB_CAPABILITIES } from '../plugins/github/GitHubBackend.js';
import { createMachinePlugin } from '../plugins/machine/machinePlugin.js';
import type { MachineRunner } from '../plugins/machine/machineRunner.js';
import { RemoteBackend } from '../plugins/remote/RemoteBackend.js';
import { serveStdioRequest } from './stdioServer.js';

// Issue #52: `task serve` serves a project of ANY storage but `remote`. Here the served project is a GITHUB one (the real GitHubBackend
// over the fake GitHub server) behind the stdio pipeline, read through the remote backend over the machine transport (only the process
// boundary of `machine run` is faked). It pins: the capabilities the client reports are github's (not a local store's), the common
// operations work end to end, an operation github refuses comes back as a typed `unsupported` with its hint, and WHICH process raises
// the queue events (the serving process, from the records before and after each write, never GitHub itself).

const CONFIG: TaskResolvedConfig = {
	statuses: WRITE_STATUSES.map(status => status.name),
	defaultStatus: 'backlog',
	terminalStatuses: ['done', 'cancelled', 'duplicate'],
	negativeStatuses: ['cancelled', 'duplicate'],
	types: ['bug', 'feature'],
	priorities: ['urgent', 'high', 'medium', 'low'],
	defaults: { priority: 'medium', leaseMinutes: 30 },
};

interface Served {
	remote: RemoteBackend;
	events: TaskEvent[];
	fake: FakeGitHub;
	dispose: () => Promise<void>;
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of open.splice(0)) await dispose();
});

async function served(): Promise<Served> {
	const fake = await FakeGitHub.start({ searchLagRequests: 0 });
	const { backend } = makeGitHubBackend(fake, {
		statuses: WRITE_STATUSES,
		projectTypes: ['bug', 'feature'],
		options: { statusMap: WRITE_STATUS_MAP },
	});
	const ctx: TaskServiceContext = {
		store: backend,
		config: CONFIG,
		storage: { dataDir: 'unused', configFiles: [] },
		project: { id: 'ab12cd34', name: 'on-github', path: 'unused' },
	};
	const events: TaskEvent[] = [];
	// The queue of the SERVING process: it records what that process raises.
	const eventSink: EventSink = {
		deliver(event): Promise<EventDelivery> {
			events.push(event);
			return Promise.resolve({ delivered: true });
		},
	};
	const runner: MachineRunner = {
		async run(call) {
			const answer = await serveStdioRequest(Readable.from([Buffer.from(call.stdin, 'utf8')]), { ctx, eventSink });
			return { kind: 'ran', exitCode: 0, stdout: JSON.stringify(answer), stderr: '', timedOut: false, truncated: false };
		},
	};
	const transport = await createMachinePlugin(runner).create({ peer: 'thinkcentre', project: 'on-github' }, { env: {} });
	const remote = new RemoteBackend({ transport });
	const dispose = async (): Promise<void> => {
		await transport.dispose();
		await fake.stop();
	};
	open.push(dispose);
	return { remote, events, fake, dispose };
}

describe('task serve --stdio over a GitHub-backed project (fake GitHub server)', () => {
	it('reports the capabilities of GitHub, not a local store: the server advertises them in info and the client carries them', async () => {
		const { remote } = await served();

		const info = await remote.info();

		expect(info.capabilities).toMatchObject({ meta: GITHUB_CAPABILITIES.meta, hierarchy: GITHUB_CAPABILITIES.hierarchy });
		expect(remote.capabilities.meta).toBe(false);
		expect(remote.capabilities.events).toBe('server');
	});

	it('creates, moves, comments on, reads, lists and prioritizes a task end to end', async () => {
		const { remote, fake } = await served();

		const created = await remote.create({ title: 'Served from GitHub', status: 'backlog' });
		const moved = await remote.updateStatus(created.id, 'in-progress');
		const commented = await remote.addComment(created.id, `a comment with an accent: ${String.fromCharCode(0xe9)}`);
		const read = await remote.get(created.id);
		const listed = await remote.list();
		const prioritized = await remote.setPriority!(created.id, 'high');

		expect(moved.status).toBe('in-progress');
		expect(commented.comment.text).toContain('accent');
		expect(read.title).toBe('Served from GitHub');
		expect(read.status).toBe('in-progress');
		expect(listed.map(task => task.id)).toContain(created.id);
		expect(prioritized.priority).toBe('high');
		// The writes really went to the (fake) GitHub repository: the issue exists there, in its final state.
		expect(fake.issues.size).toBe(1);
		const [issue] = [...fake.issues.values()];
		expect(issue?.title).toBe('Served from GitHub');
	});

	it('an operation GitHub refuses answers 422 unsupported with its hint (meta without a fill), typed as UnsupportedByBackendError', async () => {
		const { remote } = await served();
		const created = await remote.create({ title: 'No meta here', status: 'backlog' });

		const refused = await remote.setMeta(created.id, 'k', 'v').catch((error: unknown) => error);

		expect(refused).toBeInstanceOf(UnsupportedByBackendError);
		expect((refused as UnsupportedByBackendError).hint.length).toBeGreaterThan(10);
		expect((refused as UnsupportedByBackendError).capability).toBe('meta');
	});

	it('the events are raised by the SERVING process from the records before and after each write (GitHub raises none)', async () => {
		const { remote, events } = await served();

		const created = await remote.create({ title: 'Event source', status: 'backlog' });
		await remote.updateStatus(created.id, 'done');
		await remote.get(created.id);
		await remote.list();

		const names = events.map(event => event.name);
		expect(names).toContain('onTaskCreated');
		expect(names).toContain('onStatusChange');
		// A read raises nothing, and nothing happens in the sink for what nobody did through this server.
		expect(names.filter(name => name === 'onTaskCreated')).toHaveLength(1);
		const change = events.find(event => event.name === 'onStatusChange');
		expect(change?.payload).toMatchObject({ taskId: created.id, newStatus: 'done', taskProjectName: 'on-github' });
	});
});
