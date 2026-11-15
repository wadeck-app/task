import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalBackend } from '@wadeck-app/task-core';
import { openResolvedProject, ownConfigFile, resolveProject } from '@wadeck-app/task-service';
import type { EventSink, ResolvedProject, TaskEvent } from '@wadeck-app/task-service';
import { FakeGitHub } from '@wadeck-app/task-service/fakeGitHub';

import { type RegisteredTestProject, registerTestProject } from '../testHelpers.js';
import { runMigrateStrategy } from './MigrateStrategyCommands.js';
import type { MigrateStrategyDeps } from './MigrateStrategyCommands.js';

// `task strategy migrate finalize` and `abort` end to end: a local project whose tasks go to the fake GitHub, the worker run in this
// process, then the command as the CLI runs it (text, json, events, exit codes). The plugin and the host are tested in task-service.
const TOKEN_VARIABLE = 'TASK_CLI_END_TEST_TOKEN';
let tmpDir: string;
let fake: FakeGitHub;
let project: RegisteredTestProject;
let resolved: ResolvedProject;
let events: TaskEvent[];
let flushed: number;

const CONFIG = (): string => `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
strategy:
    type: migrating
    options:
        current: { type: local }
        new:
            type: github
            options:
                repo: ${fake.repo}
                baseUrl: ${fake.baseUrl}
                tokenEnv: ${TOKEN_VARIABLE}
                writeSpacingSeconds: 0
                timeoutSeconds: 3
                cache: { ttlSeconds: 0 }
                priorityStorage: label
                fills: { meta: labels }
                statusMap:
                    backlog: { state: open }
                    in-progress: { state: open, label: 'status:in-progress' }
                    done: { state: closed }
`;

const sink = (): EventSink => ({
	deliver: event => {
		events.push(event);
		return Promise.resolve({ delivered: true });
	},
	flush: () => {
		flushed++;
		return Promise.resolve();
	},
});

const deps = (extra: Partial<MigrateStrategyDeps> = {}): MigrateStrategyDeps => ({
	launch: () => Promise.reject(new Error('no process is started by this test')),
	out: () => undefined,
	warn: () => undefined,
	sleep: () => Promise.resolve(),
	makeSink: sink,
	...extra,
});
const run = (args: string[], json = false, extra: Partial<MigrateStrategyDeps> = {}) =>
	runMigrateStrategy(args, json, resolved, deps(extra));

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-migrating-'));
	fake = await FakeGitHub.start({ repo: 'acme/shop', searchLagRequests: 0 });
	process.env[TOKEN_VARIABLE] = fake.token;
	project = await registerTestProject(path.join(tmpDir, 'shop'));
	resolved = resolveProject({ cwd: project.dir, projectRef: project.id });
	const current = createLocalBackend(project.tasksDir);
	const epic = await current.create({ title: 'Epic', status: 'backlog' });
	await current.create({ title: 'Child', status: 'in-progress', parentId: epic.id });
	await current.create({ title: 'Loose', status: 'backlog' });
	fs.writeFileSync(ownConfigFile(project.storage), CONFIG());
	events = [];
	flushed = 0;
});

afterEach(async () => {
	delete process.env[TOKEN_VARIABLE];
	await fake.stop();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function moveEverything(): Promise<void> {
	const start = await run(['start', '--allow-loss', 'all'], false, { launch: () => Promise.resolve({}) });
	expect(start.output).toContain('Migration started');
	const worker = await run(['worker']);
	expect(worker.output).toContain('ready-to-finalize');
}

describe('task strategy migrate finalize, end to end over the fake GitHub', () => {
	it('switches the project, says what was kept and what no longer resolves, delivers the summary event once, exit 0', async () => {
		await moveEverything();

		const result = await run(['finalize']);

		expect(result.exitCode).toBe(0);
		expect(result.output).toMatch(/Finalized: 3 moved tasks/);
		expect(result.output).toContain('config.yml.before-migration');
		expect(result.output).toMatch(/idmap\.json/);
		expect(result.output).toMatch(/WARNING: 3 task\(s\) have a new id: the old id no longer resolves/);
		expect(result.output).toContain('NOT deleted');
		expect(events.map(event => event.name)).toEqual(['onTasksMigrated']);
		expect(flushed).toBe(1);
		// the project, opened the normal way, is a GitHub project with the three tasks
		const ctx = openResolvedProject(resolved);
		expect((await ctx.store.list()).map(task => task.title).sort()).toEqual(['Child', 'Epic', 'Loose']);
		await ctx.dispose?.();
		expect((await run(['status'])).output).toMatch(/Migration:\s+finished/);
	});

	it('--json answers the outcome without the event, and finalizing again changes nothing and raises nothing', async () => {
		await moveEverything();

		const first = JSON.parse((await run(['finalize'], true)).output) as Record<string, unknown>;

		expect(first).toMatchObject({ outcome: 'finished', moved: 3, madeInNew: 0, eventDue: true });
		expect(first['events']).toBeUndefined();
		expect(events).toHaveLength(1);

		const again = await run(['finalize'], true);
		expect(again.exitCode).toBe(0);
		expect(JSON.parse(again.output)).toMatchObject({ outcome: 'already-finished' });
		expect(events).toHaveLength(1);
	});

	it('a refusal is {error, hint} with exit 1 and no event', async () => {
		await run(['start', '--allow-loss', 'all'], false, { launch: () => Promise.resolve({}) });

		const result = await run(['finalize'], true);

		expect(result.exitCode).toBe(1);
		const answer = JSON.parse(result.output) as { error: string; hint: string };
		expect(answer.error).toMatch(/finalize refused/);
		expect(answer.hint).toContain('task strategy migrate');
		expect(events).toEqual([]);
	});

	it('abort --keep-moved after the move: GitHub is not written to, the project is local again, the tasks are listed', async () => {
		await moveEverything();
		const writes = fake.writes().length;

		const result = await run(['abort', '--keep-moved']);

		expect(result.exitCode).toBe(0);
		expect(result.output).toMatch(/WARNING: 3 task\(s\) have their truth in "new"/);
		expect(fake.writes().length).toBe(writes);
		const ctx = openResolvedProject(resolved);
		expect((await ctx.store.list()).map(task => task.title).sort()).toEqual(['Child', 'Epic', 'Loose']);
		await ctx.dispose?.();
	});
});
