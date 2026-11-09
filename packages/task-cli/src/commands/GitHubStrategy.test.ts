import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ownConfigFile } from '@wadeck-app/task-service';
import { FakeGitHub } from '@wadeck-app/task-service/fakeGitHub';

import { runTaskCommand } from '../TaskIndex.js';
import { type RegisteredTestProject, registerTestProject } from '../testHelpers.js';

// The github strategy through the real CLI entry (runTaskCommand): a project whose config.yml selects it, a fake GitHub server
// on a loopback port, the token in an environment variable. Reads and writes work end to end; what needs a fill fails with the key to write.
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
        writeSpacingSeconds: 0
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

describe('task, writes on a github project', () => {
	it('new, set-status, add-label, set-type, comment, link and set-parent reach GitHub, and the reads show them', async () => {
		seed();

		const created = await run('new', 'A new task');
		const moved = await run('set-status', '6', 'in-progress');
		const labelled = await run('add-label', '6', 'urgent');
		const typed = await run('set-type', '6', 'bug');
		const commented = await run('comment', '6', 'hello');
		const linked = await run('link', '6', 'blockedBy', '4');
		const parented = await run('set-parent', '6', '1');

		for (const result of [created, moved, labelled, typed, commented, linked, parented]) {
			expect(result.exitCode, result.output).toBe(0);
		}
		expect(JSON.parse(created.output)).toMatchObject({ id: '6', title: 'A new task', status: 'backlog' });
		expect(fake.issues.get(6)).toMatchObject({
			title: 'A new task',
			labels: ['status:in-progress', 'urgent', 'type:bug'],
		});
		expect(fake.issues.get(6)!.blockedBy).toEqual([4]);
		expect(fake.issues.get(6)!.parent).toBe(1);
		const shown = JSON.parse((await run('show', '6', '--json')).output) as Record<string, unknown>;
		expect(shown).toMatchObject({ id: '6', status: 'in-progress', type: 'bug', labels: ['urgent'], parentId: '1' });
		expect((shown['comments'] as Array<{ text: string }>).map(comment => comment.text)).toEqual(['hello']);
		const history = await run('history', '6', '--all');
		expect(history.output).toContain('Created');
		expect(history.output).toContain('in-progress');
	});

	it('writes nothing in the data folder of the project: the tasks are on GitHub, only the cache is local', async () => {
		seed();
		await run('new', 'A new task');
		await run('set-status', '6', 'done');

		expect(fs.existsSync(path.join(project.storage.dataDir, 'tasks'))).toBe(false);
		expect(fs.existsSync(path.join(project.storage.dataDir, 'task-index.json'))).toBe(false);
	});

	it('a change that GitHub does not know how to hold without a fill exits 1 with the key to write, in text and in --json', async () => {
		seed();

		const meta = await run('set-meta', '1', 'k', 'v');
		const del = await run('delete', '1');
		const json = JSON.parse((await run('set-meta', '1', 'k', 'v', '--json')).output) as {
			error: string;
			hint: string;
		};

		expect(meta.exitCode).toBe(1);
		expect(meta.output).toContain('capability "meta"');
		expect(meta.output).toContain('meta: labels');
		expect(del.exitCode).toBe(1);
		expect(del.output).toContain('capability "delete"');
		expect(del.output).toContain('delete: tombstone');
		expect(json.error).toContain('capability "meta"');
		expect(json.hint).toContain('strategy.options.fills');
		expect(fake.writes()).toEqual([]);
	});

	it('the author of a comment cannot be chosen: GitHub writes it as the token user', async () => {
		seed();

		const result = await run('comment', '1', 'hello', '--author', 'ann');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('--author');
		expect(fake.writes()).toEqual([]);
	});

	it('a status change that GitHub refuses is a clear error, nothing is created locally', async () => {
		seed();
		fake.failNext({ status: 422, method: 'PATCH', body: { message: 'Validation Failed' } });

		const result = await run('set-status', '1', 'done');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('GitHub refused');
		expect(result.output).toContain('Nothing was changed');
	});

	it('a change that stops halfway says what GitHub holds and how to finish it, exit 1', async () => {
		seed();
		// The issue is created, then attached to its parent: the attachment is refused.
		fake.failNext({
			status: 422,
			method: 'POST',
			pathPrefix: '/repos/acme/shop/issues/1/sub_issues',
			body: { message: 'Validation Failed' },
		});

		const result = await run('new', 'Under alpha', '--parent', '1');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('only partly done');
		expect(result.output).toContain('created issue #6');
		expect(result.output).toContain('task set-parent 6 1');
		expect(fake.issues.get(6)!.title).toBe('Under alpha');
	});
});

describe('task delete on a github project with a delete fill', () => {
	const withFills = (fills: string): void => {
		const file = ownConfigFile(project.storage);
		const text = fs.readFileSync(file, 'utf8');
		fs.writeFileSync(
			file,
			text.replace('    options:\n', `    fidelity: degrade\n    options:\n        fills:\n${fills}`)
		);
	};

	it('tombstone: the issue is closed as not planned and labelled task:deleted, then hidden; its children become root tasks', async () => {
		seed();
		withFills('            delete: tombstone\n');

		const result = await run('delete', '2');

		expect(result.exitCode, result.output).toBe(0);
		expect(fake.issues.get(2)).toMatchObject({ state: 'closed', stateReason: 'not_planned' });
		expect(fake.issues.get(2)!.labels).toContain('task:deleted');
		expect(fake.issues.get(4)!.parent).toBeNull();
		const listed = JSON.parse((await run('list', '--all', '--json')).output) as Array<{ id: string }>;
		expect(listed.map(task => task.id)).toEqual(['1', '3', '4', '5']);
		expect(stderr.join('')).toContain('delete is emulated');
	});

	it('a task created a moment ago is found by list and delete although GitHub lists a new issue seconds late', async () => {
		await fake.stop();
		fake = await FakeGitHub.start({ repo: 'acme/shop', listLagRequests: 6 });
		fs.writeFileSync(
			ownConfigFile(project.storage),
			fs.readFileSync(ownConfigFile(project.storage), 'utf8').replace(/baseUrl: .*/, `baseUrl: ${fake.baseUrl}`)
		);
		vi.stubEnv(TOKEN_VARIABLE, fake.token);
		withFills('            delete: hard\n');

		const created = JSON.parse((await run('new', 'Fresh', '--json')).output) as { id: string };
		const listed = JSON.parse((await run('list', '--json')).output) as Array<{ id: string }>;
		const deleted = await run('delete', created.id);

		expect(listed.map(task => task.id)).toEqual([created.id]);
		expect(deleted.exitCode, deleted.output).toBe(0);
		expect(fake.issues.get(Number(created.id))!.deleted).toBe(true);
	});

	it('hard: GraphQL deleteIssue, the issue is gone', async () => {
		seed();
		withFills('            delete: hard\n');

		const result = await run('delete', '4');

		expect(result.exitCode, result.output).toBe(0);
		expect(fake.issues.get(4)!.deleted).toBe(true);
		expect(fake.writes().map(request => request.path)).toEqual(['/graphql']);
	});
});

describe('task labels sync on a github project', () => {
	it('--dry-run lists the labels the configuration needs and creates none', async () => {
		const result = await run('labels', 'sync', '--dry-run');

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('Dry run');
		expect(result.output).toMatch(/would create\s+status:in-progress/);
		expect(fake.writes()).toEqual([]);
	});

	it('creates the missing labels, then says there is nothing to do', async () => {
		const first = await run('labels', 'sync');
		const second = await run('labels', 'sync');

		expect(first.exitCode).toBe(0);
		expect(first.output).toMatch(/created\s+status:in-progress/);
		expect([...fake.repoLabels.keys()]).toEqual(['status:in-progress']);
		expect(second.output).toContain('nothing to create');
		expect(fake.writes()).toHaveLength(1);
	});

	it('--json is the report of the service', async () => {
		const report = JSON.parse((await run('labels', 'sync', '--json')).output) as {
			dryRun: boolean;
			created: string[];
			existing: string[];
		};

		expect(report).toMatchObject({ dryRun: false, created: ['status:in-progress'], existing: [] });
	});

	it('an unknown argument is a usage error', async () => {
		const result = await run('labels', 'sync', '--force');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('Usage: task labels sync [--dry-run] [--json]');
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
	it('show lists the capabilities (writes native, meta and delete unsupported without their fill) and the token variable, never its value', async () => {
		const result = await run('strategy', 'show');

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('github (plugins.github.default)');
		expect(result.output).toMatch(/writes\s+native\s+full/);
		expect(result.output).toMatch(/meta\s+unsupported/);
		expect(result.output).toMatch(/delete\s+unsupported/);
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
