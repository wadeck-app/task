import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ownConfigFile } from '@wadeck-app/task-service';
import type { TaskEvent } from '@wadeck-app/task-service';
import { FakeGitHub } from '@wadeck-app/task-service/fakeGitHub';

import { runTaskCommand } from '../TaskIndex.js';
import { type RegisteredTestProject, registerTestProject } from '../testHelpers.js';

// Events reach this list instead of the queue: the CLI builds its sink with createQueueEventSink, replaced here (after the
// instant fake of vitest.setup.ts) by one that records what it is given.
const delivered = vi.hoisted(() => [] as unknown[]);
vi.mock('@wadeck-app/task-service', async importOriginal => {
	const actual = await importOriginal<typeof import('@wadeck-app/task-service')>();
	return {
		...actual,
		createQueueEventSink: (): import('@wadeck-app/task-service').QueueEventSink => ({
			deliver: event => {
				delivered.push(event);
				return Promise.resolve({ delivered: true });
			},
			declareEvents: () => Promise.resolve({ status: 'dropped', reason: 'faked by the test' }),
			flush: () => Promise.resolve(),
		}),
	};
});

let tmpDir: string;
let source: RegisteredTestProject;
let target: RegisteredTestProject;
let stderr: string[];
let fake: FakeGitHub | undefined;
const TOKEN_VARIABLE = 'TASK_CLI_MIGRATE_TEST_TOKEN';

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-migrate-'));
	source = await registerTestProject(path.join(tmpDir, 'old'), {
		name: `old-${path.basename(tmpDir)}`.toLowerCase(),
	});
	target = await registerTestProject(path.join(tmpDir, 'new'), {
		name: `new-${path.basename(tmpDir)}`.toLowerCase(),
	});
	stderr = [];
	delivered.length = 0;
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await fake?.stop();
	fake = undefined;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const run = (cwd: string, ...args: string[]) => runTaskCommand(args, cwd);
const migrate = (...args: string[]) => run(tmpDir, 'migrate', '--from', source.name, '--to', target.name, ...args);

async function newTask(title: string, parent?: string): Promise<string> {
	const result = await run(source.dir, 'new', title, ...(parent === undefined ? [] : ['--parent', parent]));
	return (JSON.parse(result.output) as { id: string }).id;
}

/** A small project: a parent and a child, a task shipped, a label, a blockedBy link, a comment by ann. */
async function seed(): Promise<{ epic: string; child: string; shipped: string }> {
	const epic = await newTask('Epic');
	const child = await newTask('Child', epic);
	const shipped = await newTask('Shipped');
	await run(source.dir, 'set-status', shipped, 'done');
	await run(source.dir, 'add-label', epic, 'planning');
	await run(source.dir, 'link', child, 'blockedBy', shipped);
	await run(source.dir, 'comment', epic, 'a note', '--author', 'ann');
	// The events of the seeding commands are not the migration's.
	delivered.length = 0;
	return { epic, child, shipped };
}

async function titlesOf(project: RegisteredTestProject): Promise<string[]> {
	const result = await run(project.dir, 'list', '--all', '--json');
	return (JSON.parse(result.output) as Array<{ title: string }>).map(task => task.title).sort();
}

function useGithubTarget(): void {
	fs.writeFileSync(
		ownConfigFile(target.storage),
		`statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
strategy:
    type: github
    options:
        repo: acme/shop
        baseUrl: ${fake!.baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        writeSpacingSeconds: 0
        timeoutSeconds: 3
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status:in-progress' }
            done: { state: closed }
`
	);
	vi.stubEnv(TOKEN_VARIABLE, fake!.token);
}

describe('task migrate: the command line', () => {
	it('--help needs no project and describes every option', async () => {
		const result = await runTaskCommand(['migrate', '--help'], tmpDir);

		expect(result.exitCode).toBe(0);
		for (const text of [
			'--from',
			'--to',
			'--dry-run',
			'--allow-loss',
			'--resume',
			'--emit-events',
			'--history-comment',
		]) {
			expect(result.output).toContain(text);
		}
		expect(result.output).toMatch(/history, created-at/);
		expect(result.output).toMatch(/links:causedBy/);
	});

	it('is listed in the main help and in the commands an unknown command suggests', async () => {
		expect((await runTaskCommand(['--help'], tmpDir)).output).toMatch(
			/task migrate --from <project> --to <project>/
		);
		expect((await runTaskCommand(['nonsense'], tmpDir)).output).toMatch(/Valid commands:.*projects, migrate/);
	});

	it.each([
		[['migrate'], /--from <project> and --to <project> are required/],
		[['migrate', '--from', 'a'], /--to <project> is required/],
		[['migrate', '--to', 'a'], /--from <project> is required/],
		[['migrate', '--from'], /--from needs a project/],
		[['migrate', '--from', 'a', '--to', 'b', '--bogus'], /unknown option: --bogus/],
		[['migrate', '--from', 'a', '--to', 'b', 'extra'], /unexpected argument: extra/],
		[['migrate', '--from', 'a', '--to', 'b', '--allow-loss'], /--allow-loss needs a list/],
		[['migrate', '--from', 'a', '--to', 'b', '--allow-loss', ','], /--allow-loss needs a list/],
		[['migrate', '-p', 'a', '--from', 'a', '--to', 'b'], /does not take -p\/--project/],
		[['migrate', '--project=a', '--from', 'a', '--to', 'b'], /does not take -p\/--project/],
	])('%j is an error that says what to type', async (args, message) => {
		const result = await runTaskCommand(args, tmpDir);

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(message);
		expect(result.output).toMatch(/Usage: task migrate/);
	});

	it('the errors are {error, hint} with --json', async () => {
		const result = await runTaskCommand(['migrate', '--json'], tmpDir);

		expect(result.exitCode).toBe(1);
		const body = JSON.parse(result.output) as { error: string; hint: string };
		expect(body.error).toMatch(/required/);
		expect(body.hint).toMatch(/Usage: task migrate/);
	});

	it('a project that is not registered is named with the option it was given to, and the registered ones', async () => {
		const result = await run(tmpDir, 'migrate', '--from', 'nowhere', '--to', target.name);

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(/^Error: --from: /);
		expect(result.output).toContain('nowhere');
	});

	it('the same project on both sides is refused', async () => {
		const result = await run(tmpDir, 'migrate', '--from', source.name, '--to', source.id);

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(/same project/);
		expect(result.output).toMatch(/project add/);
	});

	it('an unknown loss kind lists the valid ones', async () => {
		await seed();

		const result = await migrate('--allow-loss', 'hisotry');

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(/unknown loss kind for --allow-loss: hisotry/);
		expect(result.output).toMatch(/Valid kinds: .*history/);
	});

	it('TASK_PROJECT is not read: the two sides are named by the options only', async () => {
		await seed();
		vi.stubEnv('TASK_PROJECT', 'nonsense-project');

		const result = await migrate('--dry-run');

		expect(result.exitCode).toBe(0);
	});
});

describe('task migrate --dry-run', () => {
	it('prints the plan and the loss table, writes nothing, and says what to type next', async () => {
		await seed();

		const result = await migrate('--dry-run');

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain(
			`Migration ${source.name} (local) -> ${target.name} (local): DRY RUN, nothing was written`
		);
		expect(result.output).toMatch(/Tasks: +3 read; would create 3, finish 0, skip 0/);
		expect(result.output).toMatch(/history +\d+ +BLOCKING/);
		expect(result.output).toMatch(/fix: add --history-comment/);
		expect(result.output).toContain(
			`Next: to accept these losses run: task migrate --from ${source.name} --to ${target.name} --allow-loss history`
		);
		expect(await titlesOf(target)).toEqual([]);
		expect(fs.existsSync(path.join(target.storage.dataDir, `migrate-journal-${source.id}-${target.id}.json`))).toBe(
			false
		);
	});

	it('--json is the plan: status, counts, losses, blocking, estimate, no events', async () => {
		await seed();

		const result = await migrate('--dry-run', '--json');

		expect(result.exitCode).toBe(0);
		const body = JSON.parse(result.output) as Record<string, unknown>;
		expect(body).toMatchObject({
			status: 'dry-run',
			dryRun: true,
			blocking: ['history'],
			counts: { source: 3, created: 3 },
		});
		expect(body['losses']).toHaveLength(1);
		expect(body['events']).toBeUndefined();
		expect(delivered).toEqual([]);
	});

	it('with every loss allowed, it says to run without --dry-run', async () => {
		await seed();

		const result = await migrate('--dry-run', '--allow-loss', 'history');

		expect(result.output).toContain('allowed');
		expect(result.output).toContain(
			`Next: run again without --dry-run: task migrate --from ${source.name} --to ${target.name} --allow-loss history`
		);
	});
});

describe('task migrate', () => {
	it('is blocked while a loss is not allowed: exit 1, nothing written, the exact command to accept it', async () => {
		await seed();

		const result = await migrate();

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(/BLOCKED, nothing was written/);
		expect(result.output).toContain('--allow-loss history');
		expect(await titlesOf(target)).toEqual([]);
	});

	it('migrates, one line per task on stderr, a summary on stdout; --json is the result', async () => {
		const { epic } = await seed();

		const result = await migrate('--allow-loss', 'history');

		expect(result.exitCode).toBe(0);
		expect(result.output).toMatch(/: done\n/);
		expect(result.output).toMatch(/Tasks: +3 read; created 3, finished 0, skipped 0, failed 0, remaining 0/);
		expect(result.output).toMatch(/Verified: +3 task\(s\) read back, all as planned/);
		expect(result.output).toContain('migrate-journal-');
		const progress = stderr
			.join('')
			.split('\n')
			.filter(line => /^\[\d+\/3\] created /.test(line));
		expect(progress).toHaveLength(3);
		expect(progress[0]).toMatch(new RegExp(`^\\[1/3\\] created ${epic} -> \\w+ +Epic$`));
		expect(await titlesOf(target)).toEqual(['Child', 'Epic', 'Shipped']);
	});

	it('--json after a run: status completed, counts, id map, verification, journal', async () => {
		await seed();

		const result = await migrate('--allow-loss', 'history', '--json');

		const body = JSON.parse(result.output) as Record<string, any>;
		expect(body['status']).toBe('completed');
		expect(body['counts']).toMatchObject({ source: 3, created: 3, failed: 0, remaining: 0 });
		expect(body['idMap']).toHaveLength(3);
		expect(body['verification']).toEqual({ checked: 3, mismatches: [] });
		expect(body['journal']).toContain(`migrate-journal-${source.id}-${target.id}.json`);
		expect(body['events']).toBeUndefined();
	});

	it('a second run creates nothing and says so', async () => {
		await seed();
		await migrate('--allow-loss', 'history');

		const again = await migrate('--allow-loss', 'history');

		expect(again.exitCode).toBe(0);
		expect(again.output).toMatch(/Tasks: +3 read; created 0, finished 0, skipped 3/);
		expect(await titlesOf(target)).toEqual(['Child', 'Epic', 'Shipped']);
	});

	it('keeps the original instants and the authors in the text of the comments', async () => {
		const { epic } = await seed();
		await migrate('--allow-loss', 'history');

		const targetEpic = (
			JSON.parse((await run(target.dir, 'list', '--all', '--json')).output) as Array<{
				id: string;
				title: string;
			}>
		).find(task => task.title === 'Epic')!;
		const comments = JSON.parse((await run(target.dir, 'comments', targetEpic.id, '--json')).output) as Array<{
			author?: string;
			text: string;
		}>;
		const original = JSON.parse((await run(source.dir, 'comments', epic, '--json')).output) as Array<{
			at: string;
		}>;

		expect(comments[0]!.author).toBe('ann');
		expect(comments[0]!.text).toContain(`Originally posted ${original[0]!.at}`);
	});

	it('delivers one summary event, in the target project, and the per-task events only with --emit-events', async () => {
		await seed();

		await migrate('--allow-loss', 'history');
		const names = (): string[] => delivered.map(event => (event as TaskEvent).name);
		expect(names()).toEqual(['onTasksMigrated']);
		expect((delivered[0] as TaskEvent).payload).toMatchObject({
			created: 3,
			complete: true,
			toProjectId: target.id,
		});

		delivered.length = 0;
		fs.rmSync(path.join(target.storage.dataDir), { recursive: true, force: true });
		await migrate('--allow-loss', 'history', '--emit-events');
		expect(names().filter(name => name === 'onTaskCreated')).toHaveLength(3);
		expect(names()[names().length - 1]).toBe('onTasksMigrated');
	});
});

describe('task migrate over a GitHub target (the fake server)', () => {
	it('prints the estimate, stops on the rate limit with the exact command and the time, and --resume finishes', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		useGithubTarget();
		await seed();
		const allow = ['--allow-loss', 'history,created-at,marker'];

		const dry = await migrate('--dry-run', ...allow);
		expect(dry.output).toMatch(/Estimate: +about \d+ writes, \d+ requests, /);
		expect(fake.writes()).toEqual([]);

		// Enough quota for the first task or two, not for the whole run.
		fake.setRateLimit('core', {
			limit: 5000,
			remaining: 15,
			resetAt: Math.floor(Date.parse('2030-01-01T00:00:00Z') / 1000),
		});
		const stopped = await migrate(...allow);
		expect(stopped.exitCode).toBe(1);
		expect(stopped.output).toMatch(/STOPPED on the rate limit/);
		expect(stopped.output).toContain('Retry after 2030-01-01T00:00:00.000Z');
		const resumeCommand = `task migrate --from ${source.name} --to ${target.name} --allow-loss history,created-at,marker --resume`;
		expect(stopped.output).toContain(resumeCommand);
		const stoppedJson = JSON.parse((await migrate(...allow, '--json')).output) as { error?: string };
		expect(stoppedJson.error).toMatch(/did not finish/);

		fake.setRateLimit('core', { limit: 5000, remaining: 5000 });
		const resumed = await migrate(...allow, '--resume');
		expect(resumed.exitCode).toBe(0);
		expect(resumed.output).toMatch(/Verified: /);
		expect([...fake.issues.values()].map(issue => issue.title).sort()).toEqual(['Child', 'Epic', 'Shipped']);

		const writes = fake.writes().length;
		const again = await migrate(...allow);
		expect(again.output).toMatch(/created 0, finished 0, skipped 3/);
		expect(fake.writes().length).toBe(writes);
	});
});
