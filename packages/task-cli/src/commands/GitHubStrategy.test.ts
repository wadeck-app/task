import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ownConfigFile } from '@wadeck-app/task-service';
import { FakeGitHub } from '@wadeck-app/task-service/fakeGitHub';

import { runTaskCommand } from '../TaskIndex.js';
import { type RegisteredTestProject, registerTestProject } from '../testHelpers.js';

// The github strategy through the real CLI entry (runTaskCommand): a project whose config.yml selects it, a fake GitHub server
// on a loopback port, the token in an environment variable. The reads work end to end; every write fails with the hint.
let tmpDir: string;
let project: RegisteredTestProject;
let fake: FakeGitHub;
let stderr: string[];

const TOKEN_VARIABLE = 'TASK_CLI_TEST_GITHUB_TOKEN';

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-github-'));
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
	project = await registerTestProject(path.join(tmpDir, 'shop'));
	fs.writeFileSync(
		ownConfigFile(project.storage),
		`statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
    - { name: cancelled, terminal: true, outcome: negative }
strategy:
    type: github
    options:
        repo: acme/shop
        baseUrl: ${fake.baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        cache: { ttlSeconds: 0 }
        timeoutSeconds: 3
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status:in-progress' }
            done: { state: closed }
            cancelled: { state: closed, reason: not_planned }
`
	);
	vi.stubEnv(TOKEN_VARIABLE, fake.token);
	stderr = [];
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await fake.stop();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const run = (...args: string[]) => runTaskCommand(args, project.dir);

function seed(): void {
	// #1 alpha (in progress, labelled) > #2 beta > #4 delta; #3 gamma closed, blocked by beta; #5 epsilon cancelled
	fake.addIssue({
		title: 'Alpha release',
		body: 'The body of alpha',
		labels: ['status:in-progress', 'billing', 'type:bug'],
	});
	fake.addIssue({ title: 'Beta', labels: ['billing'] });
	fake.addIssue({ title: 'Gamma', state: 'closed' });
	fake.addIssue({ title: 'Delta' });
	fake.addIssue({ title: 'Epsilon', state: 'closed', stateReason: 'not_planned' });
	fake.setParent(2, 1);
	fake.setParent(4, 2);
	fake.addBlockedBy(3, 2);
	fake.addComment(4, 'first note', 'ann');
	fake.updateIssue(1, { title: 'Alpha release 1.0' });
}

describe('task, reads on a github project', () => {
	it('list shows the open issues with their number as id; --all adds the closed ones', async () => {
		seed();

		const open = JSON.parse((await run('list', '--json')).output) as Array<{ id: string; status: string }>;
		const all = JSON.parse((await run('list', '--all', '--json')).output) as Array<{ id: string; status: string }>;

		expect(open.map(task => [task.id, task.status])).toEqual([
			['1', 'in-progress'],
			['2', 'backlog'],
			['4', 'backlog'],
		]);
		expect(all.map(task => [task.id, task.status])).toEqual([
			['1', 'in-progress'],
			['2', 'backlog'],
			['3', 'done'],
			['4', 'backlog'],
			['5', 'cancelled'],
		]);
	});

	it('show gives the record: description, labels, type, parent, children', async () => {
		seed();

		const result = await run('show', '2', '--json');

		expect(result.exitCode).toBe(0);
		const task = JSON.parse(result.output) as Record<string, unknown>;
		expect(task).toMatchObject({ id: '2', title: 'Beta', status: 'backlog', parentId: '1', labels: ['billing'] });
		expect(task['childrenIds']).toEqual(['4']);
		const alpha = JSON.parse((await run('show', '1', '--json')).output) as Record<string, unknown>;
		expect(alpha).toMatchObject({ description: 'The body of alpha', type: 'bug', labels: ['billing'] });
	});

	it('children, parents and tree follow the sub-issues', async () => {
		seed();

		const children = JSON.parse((await run('children', '1', '--recursive')).output) as Array<{
			id: string;
			children: Array<{ id: string }>;
		}>;
		const parents = JSON.parse((await run('parents', '4')).output) as Array<{ id: string }>;
		const tree = JSON.parse((await run('tree', '4')).output) as { id: string; children: unknown[] };

		expect(children.map(node => node.id)).toEqual(['2']);
		expect(children[0]!.children.map(node => node.id)).toEqual(['4']);
		expect(parents.map(task => task.id)).toEqual(['2', '1']);
		expect(tree.id).toBe('1');
	});

	it('links show blockedBy and blocks both ways', async () => {
		seed();

		const gamma = JSON.parse((await run('links', '3')).output) as { blockedBy: Array<{ id: string }> };
		const beta = JSON.parse((await run('links', '2')).output) as { blocks: Array<{ id: string }> };

		expect(gamma.blockedBy.map(task => task.id)).toEqual(['2']);
		expect(beta.blocks.map(task => task.id)).toEqual(['3']);
	});

	it('comments are listed oldest first with their author', async () => {
		seed();

		const result = await run('comments', '4');

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('ann');
		expect(result.output).toContain('first note');
	});

	it('history --all lists the whole activity newest first, history --json the status changes', async () => {
		seed();

		const activity = await run('history', '1', '--all');
		const statuses = JSON.parse((await run('history', '1', '--json')).output) as Array<{ status: string }>;

		expect(activity.exitCode).toBe(0);
		expect(activity.output).toContain('Title edited');
		expect(activity.output).toContain('Created with status in-progress');
		expect(activity.output).toContain('Sub-task 2 Beta added');
		expect(statuses.map(entry => entry.status)).toEqual(['in-progress']);
	});

	it('find ranks over the full list, labels counts, status list prints the project statuses', async () => {
		seed();

		const found = await run('find', 'alpha');
		const labels = JSON.parse((await run('labels', '--json')).output) as Array<{ label: string; count: number }>;
		const statuses = await run('status', 'list');

		expect(found.output).toContain('1');
		expect(found.output).toContain('Alpha release 1.0');
		expect(labels).toEqual([{ label: 'billing', count: 2 }]);
		expect(statuses.output).toBe('backlog (default)\nin-progress\ndone (terminal)\ncancelled (terminal, negative)');
	});

	it('a task that does not exist is the usual not-found error', async () => {
		seed();

		const result = await run('show', '99');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('Task not found: 99');
	});

	it('never sends anything but GET', async () => {
		seed();
		await run('list', '--all');
		await run('show', '1');
		await run('tree', '1');

		expect(fake.writes()).toEqual([]);
	});
});

describe('task, writes on a github project fail loudly', () => {
	it.each([
		[['new', 'A new task']],
		[['set-status', '1', 'done']],
		[['set-title', '1', 'Another title']],
		[['add-label', '1', 'x']],
		[['set-type', '1', 'bug']],
		[['set-meta', '1', 'k', 'v']],
		[['set-parent', '4', '1']],
		[['link', '4', 'blockedBy', '1']],
		[['comment', '1', 'hello']],
		[['delete', '1']],
	])('%j exits 1 with the stage and where to make the change', async args => {
		seed();

		const result = await run(...args);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('does not support');
		expect(result.output).toContain('capability "writes"');
		expect(result.output).toContain('The github strategy is read-only in this version (stage 1');
		// The fake server is not github.com: the page of the issue is on the server's own origin.
		expect(result.output).toMatch(/http:\/\/127\.0\.0\.1:\d+\/acme\/shop\/issues\/(\d+|new)/);
		expect(fake.writes()).toEqual([]);
	});

	it('--json carries the same error and hint', async () => {
		seed();

		const result = await run('set-status', '1', 'done', '--json');

		expect(result.exitCode).toBe(1);
		const body = JSON.parse(result.output) as { error: string; hint: string };
		expect(body.error).toContain('capability "writes"');
		expect(body.hint).toContain('read-only in this version (stage 1');
	});

	it('nothing is created locally: the data folder of the project stays empty of tasks', async () => {
		seed();
		await run('new', 'A new task');
		await run('set-status', '1', 'done');

		expect(fs.existsSync(path.join(project.storage.dataDir, 'tasks'))).toBe(false);
		expect(fs.existsSync(path.join(project.storage.dataDir, 'task-index.json'))).toBe(false);
	});
});

describe('task, the token and the network', () => {
	it('a token that is not set is an error naming the variable, the file and the fix, even for a read', async () => {
		vi.stubEnv(TOKEN_VARIABLE, '');

		const result = await run('list');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(`No GitHub token: the environment variable ${TOKEN_VARIABLE} is not set`);
		expect(result.output).toContain(ownConfigFile(project.storage));
		expect(result.output).toContain(`export ${TOKEN_VARIABLE}=<token>`);
		expect(fake.requests).toEqual([]);
	});

	it('a rejected token never appears in the output', async () => {
		vi.stubEnv(TOKEN_VARIABLE, 'a-wrong-token-value');

		const result = await run('list');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('GitHub refused the token (401');
		expect(result.output).not.toContain('a-wrong-token-value');
		expect(stderr.join('')).not.toContain('a-wrong-token-value');
	});

	it('an exhausted quota says when to retry', async () => {
		fake.setRateLimit('core', { remaining: 0, resetAt: Math.floor(Date.now() / 1000) + 600 });

		const result = await run('list');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('rate limit is reached');
		expect(result.output).toMatch(/Retry after 20\d\d-/);
	});

	it('when GitHub cannot be reached the cached answer is shown with a warning on stderr, in text and in --json', async () => {
		seed();
		await run('list', '--all', '--json');
		fake.dropNext(20);

		const result = await run('list', '--all', '--json');

		expect(result.exitCode).toBe(0);
		expect((JSON.parse(result.output) as unknown[]).length).toBe(5);
		const warnings = stderr
			.join('')
			.split('\n')
			.filter(line => line.startsWith('warning: '));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('Cannot reach');
		expect(warnings[0]).toMatch(/showing what was read on 20\d\d-/);
	});

	it('without anything cached an unreachable GitHub is an error with the network fix', async () => {
		seed();
		fake.dropNext(20);

		const result = await run('list');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('Cannot reach');
		expect(result.output).toContain('baseUrl');
	});

	it('the cache is a folder of the project data in the registry, with no token in it', async () => {
		seed();
		await run('list', '--all');

		const dir = path.join(project.storage.dataDir, 'cache', 'github');
		const files = fs.readdirSync(dir);
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) expect(fs.readFileSync(path.join(dir, file), 'utf8')).not.toContain(fake.token);
		expect(fs.existsSync(path.join(project.dir, '.task'))).toBe(false);
	});
});

describe('task strategy on a github project', () => {
	it('show lists the capabilities (writes unsupported) and the token variable, never its value', async () => {
		const result = await run('strategy', 'show');

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('github (plugins.github.default)');
		expect(result.output).toMatch(/writes\s+unsupported/);
		expect(result.output).toMatch(/ids\s+native\s+assigned/);
		expect(result.output).toMatch(/hierarchy\s+partial\s+sub-issues: 8 levels, 100 per parent/);
		expect(result.output).toContain(`${TOKEN_VARIABLE} (environment variable, set)`);
		expect(result.output).not.toContain(fake.token);
	});

	it('check contacts GitHub and prints the lines with the fix of each problem; exit 1 on an error', async () => {
		seed();

		const ok = await run('strategy', 'check');
		vi.stubEnv(TOKEN_VARIABLE, 'a-wrong-token-value');
		const bad = await run('strategy', 'check');

		expect(ok.exitCode).toBe(0);
		expect(ok.output).toContain('acme/shop (private)');
		expect(ok.output).toContain('4 statuses mapped');
		expect(ok.output).toContain('labels');
		expect(ok.output).toContain('Result: ok');
		expect(bad.exitCode).toBe(1);
		expect(bad.output).toContain('GitHub refused the token (401');
		expect(bad.output).toContain('Result: FAILED');
		expect(bad.output).not.toContain('a-wrong-token-value');
	});
});
