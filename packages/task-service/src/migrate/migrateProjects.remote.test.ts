import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openResolvedProject } from '../openContext.js';
import { resolveProject } from '../resolveProject.js';
import type { ResolvedProject } from '../resolveProject.js';
import { startTaskServer } from '../server/taskServer.js';
import type { RunningTaskServer } from '../server/taskServer.js';
import { ownConfigFile } from '../storage.js';
import { createSharedRegistrySandbox } from '../testHelpers.js';
import type { SharedRegistrySandbox } from '../testHelpers.js';
import type { EventDelivery, TaskEvent } from '../events.js';
import { MigrationRefusedError } from './migrateErrors.js';
import { migrateProjects } from './migrateProjects.js';
import type { MigrateProjectsInput } from './migrateProjects.js';
import { DEFAULT_MIGRATION_OPTIONS } from './migrateTypes.js';
import type { MigrationOptions } from './migrateTypes.js';

// task migrate with a REMOTE side: local -> remote and remote -> local, over a real task serve in this process. The engine is the one
// tested in migrateRun.test.ts; here the point is that the remote backend is a first-class side (read, write, markers, read-back, resume)
// and that the events stay the server's business.
const TOKEN = 'migrate-remote-token-0123456789';
const TOKEN_VARIABLE = 'TASK_MIGRATE_REMOTE_TOKEN';
const STATUSES_CONFIG = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
`;

let sandbox: SharedRegistrySandbox;
let server: RunningTaskServer | undefined;
let serverEvents: TaskEvent[];
let serverOutcome: (event: TaskEvent) => EventDelivery;

beforeEach(() => {
	sandbox = createSharedRegistrySandbox();
	serverEvents = [];
	serverOutcome = () => ({ delivered: true });
});

afterEach(async () => {
	await server?.close();
	server = undefined;
	sandbox.cleanup();
});

const global = (): string => path.join(sandbox.root, 'global');

async function project(name: string, config = ''): Promise<ResolvedProject> {
	const dir = sandbox.dir(name);
	const added = await sandbox.register(name, dir);
	const resolved = resolveProject({ cwd: dir, projectRef: added.id, env: sandbox.env });
	fs.mkdirSync(path.dirname(ownConfigFile(resolved.storage)), { recursive: true });
	fs.writeFileSync(ownConfigFile(resolved.storage), STATUSES_CONFIG + config);
	return resolved;
}

/** A project whose tasks live behind a task serve started here, and the client project that points at it. */
async function remotePair(): Promise<{ served: ResolvedProject; client: ResolvedProject }> {
	const served = await project('served');
	server = await startTaskServer({
		ctx: openResolvedProject(served, global(), { env: sandbox.env }),
		token: TOKEN,
		failedAuthDelayMs: 0,
		eventSink: {
			deliver: event => {
				serverEvents.push(event);
				return Promise.resolve(serverOutcome(event));
			},
		},
	});
	const client = await project('client', clientConfig(server.url));
	return { served, client };
}

function clientConfig(url: string): string {
	return `strategy:
    type: remote
    options:
        transport:
            type: plain-http
            options:
                url: ${url}
                tokenEnv: ${TOKEN_VARIABLE}
                timeoutSeconds: 5
`;
}

function migrate(
	from: ResolvedProject,
	to: ResolvedProject,
	options: Partial<MigrationOptions> = {},
	extra: Partial<MigrateProjectsInput> = {}
) {
	return migrateProjects({
		from,
		to,
		options: { ...DEFAULT_MIGRATION_OPTIONS, ...options },
		resumeCommand: 'task migrate --resume',
		globalConfigDir: global(),
		env: { ...sandbox.env, [TOKEN_VARIABLE]: TOKEN },
		...extra,
	});
}

async function seed(from: ResolvedProject): Promise<void> {
	const ctx = openResolvedProject(from, global(), { env: { ...sandbox.env, [TOKEN_VARIABLE]: TOKEN } });
	const epic = await ctx.store.create({ title: 'Epic', status: 'backlog' });
	const child = await ctx.store.create({ title: 'Child', status: 'backlog', parentId: epic.id });
	await ctx.store.addLabel(epic.id, 'planning');
	await ctx.store.setType(child.id, 'bug');
	await ctx.store.updateStatus(child.id, 'in-progress');
	const shipped = await ctx.store.create({ title: 'Shipped', status: 'done' });
	await ctx.store.addLink(child.id, 'blockedBy', shipped.id);
	await ctx.store.addComment(epic.id, 'a note', { author: 'ann' });
	await ctx.dispose?.();
}

async function titlesOf(resolved: ResolvedProject): Promise<string[]> {
	const ctx = openResolvedProject(resolved, global(), { env: { ...sandbox.env, [TOKEN_VARIABLE]: TOKEN } });
	const titles = (await ctx.store.list()).map(task => task.title).sort();
	await ctx.dispose?.();
	return titles;
}

describe('local to remote', () => {
	it('copies every task to the server, verifies by reading it back, and writes its journal on THIS machine', async () => {
		const { served, client } = await remotePair();
		const from = await project('old');
		await seed(from);

		const result = await migrate(from, client, { allowLoss: ['history', 'created-at'] });

		expect(result.status).toBe('completed');
		expect(result.to).toMatchObject({ id: client.id, kind: 'remote' });
		expect(result.verification?.mismatches ?? []).toEqual([]);
		expect(await titlesOf(served)).toEqual(['Child', 'Epic', 'Shipped']);
		expect(result.journal).toBe(path.join(client.storage.dataDir, `migrate-journal-${from.id}-${client.id}.json`));
		expect(fs.existsSync(result.journal)).toBe(true);
		// The server holds the structure, the comment with its author and the marker.
		const ctx = openResolvedProject(served, global());
		const tasks = await ctx.store.getMany((await ctx.store.list()).map(task => task.id));
		const child = tasks.find(task => task.title === 'Child')!;
		const epic = tasks.find(task => task.title === 'Epic')!;
		expect(child.parentId).toBe(epic.id);
		expect(child.status).toBe('in-progress');
		expect(child.type).toBe('bug');
		expect(child.links).toHaveLength(1);
		expect(epic.comments?.[0]?.author).toBe('ann');
		expect(epic.comments?.[0]?.text).toContain('a note');
		expect(epic.meta?.['migratedFrom']).toMatch(new RegExp(`^${from.id}/`));
		await ctx.dispose?.();
	});

	it('a second run creates nothing and writes nothing (the markers on the server are recognised)', async () => {
		const { client } = await remotePair();
		const from = await project('old');
		await seed(from);
		await migrate(from, client, { allowLoss: ['history', 'created-at'] });
		const eventsBefore = serverEvents.length;

		const again = await migrate(from, client, { allowLoss: ['history', 'created-at'] });

		expect(again.status).toBe('completed');
		expect(again.counts.created).toBe(0);
		expect(serverEvents.length).toBe(eventsBefore);
	});

	it('raises no event per task on the server, and none of its own for a remote target (the server decides what it raises)', async () => {
		const { client } = await remotePair();
		const from = await project('old');
		await seed(from);

		const result = await migrate(from, client, { allowLoss: ['history', 'created-at'] });

		expect(serverEvents).toEqual([]);
		expect(result.events).toEqual([]);
		expect(result.warnings.join('\n')).toContain('raised by its server');
		expect(result.warnings.join('\n')).toContain('onTasksMigrated');
	});

	it('with --emit-events the SERVER raises the per-task events, and the client hands none to its own queue', async () => {
		const { client } = await remotePair();
		const from = await project('old');
		await seed(from);

		const result = await migrate(from, client, { allowLoss: ['history', 'created-at'], emitEvents: true });

		expect(serverEvents.filter(event => event.name === 'onTaskCreated')).toHaveLength(3);
		expect(
			serverEvents.every(event => (event.payload as { taskProjectName: string }).taskProjectName === 'served')
		).toBe(true);
		expect(result.events).toEqual([]);
	});

	it('a target on the same server as the source is refused: it is the same storage', async () => {
		const { client } = await remotePair();
		const other = await project('other-client', clientConfig(server!.url));

		const error = await migrate(client, other).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(MigrationRefusedError);
		expect((error as Error).message).toContain('are the same repository');
		expect((error as Error).message).toContain(`remote http://127.0.0.1:${server!.port}`);
	});

	it('stops with the typed error and the resume command when the server goes away, and resumes to completion', async () => {
		const { client, served } = await remotePair();
		const from = await project('old');
		await seed(from);
		const allowLoss = ['history', 'created-at'];
		let created = 0;
		const first = await migrate(
			from,
			client,
			{ allowLoss },
			{
				onProgress: progress => {
					// The server stops answering after the second task: the run must stop there, not go on or hang.
					if (progress.stage === 'create' && progress.action === 'created' && ++created === 2)
						void server!.close();
				},
			}
		);

		expect(first.status).toBe('failed');
		expect(first.failure?.message).toContain('Cannot reach');
		expect(first.failure?.hint).toContain('task serve');
		expect(first.resumeCommand).toBe('task migrate --resume');

		// The server comes back (another port): the client config points at it, and the same migration finishes what was left.
		server = await startTaskServer({
			ctx: openResolvedProject(served, global(), { env: sandbox.env }),
			token: TOKEN,
			failedAuthDelayMs: 0,
		});
		fs.writeFileSync(ownConfigFile(client.storage), STATUSES_CONFIG + clientConfig(server.url));

		const finished = await migrate(from, client, { allowLoss, resume: true });

		expect(finished.status).toBe('completed');
		expect(await titlesOf(served)).toEqual(['Child', 'Epic', 'Shipped']);
	});
});

describe('remote to local', () => {
	it('reads every task from the server and copies it into a local project, then a second run changes nothing', async () => {
		const { served, client } = await remotePair();
		await seed(served);
		const to = await project('mirror');

		const result = await migrate(client, to, { allowLoss: ['history', 'created-at'] });
		const again = await migrate(client, to, { allowLoss: ['history', 'created-at'] });

		expect(result.status).toBe('completed');
		expect(result.from).toMatchObject({ id: client.id, kind: 'remote' });
		expect(await titlesOf(to)).toEqual(['Child', 'Epic', 'Shipped']);
		expect(again.counts.created).toBe(0);
		// The source is only read: the server's tasks are untouched and raised nothing.
		expect(serverEvents.filter(event => event.name !== 'onTaskCreated')).toEqual([]);
		expect(await titlesOf(served)).toEqual(['Child', 'Epic', 'Shipped']);
	});

	it('an unreachable server as the source is an error that names the address, and the target is untouched', async () => {
		const { client } = await remotePair();
		const url = server!.url;
		await server!.close();
		const to = await project('mirror');

		const error = await migrate(client, to).catch((e: unknown) => e);

		expect((error as Error).message).toContain(new URL(url).host);
		expect(await titlesOf(to)).toEqual([]);
	});
});
