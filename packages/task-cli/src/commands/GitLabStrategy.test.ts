import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ownConfigFile } from '@wadeck-app/task-service';
import { FakeGitLab } from '@wadeck-app/task-service/fakeGitLab';
import type { FakeTier } from '@wadeck-app/task-service/fakeGitLab';

import { runTaskCommand } from '../TaskIndex.js';
import { type RegisteredTestProject, registerTestProject } from '../testHelpers.js';

// The gitlab strategy through the real CLI entry (runTaskCommand): a project whose config.yml selects it, a fake GitLab server on a
// loopback port, the token in an environment variable. NOT verified against a real GitLab: the fake is modelled on docs.gitlab.com.
let tmpDir: string;
let project: RegisteredTestProject;
let fake: FakeGitLab;
let stderr: string[];

const TOKEN_VARIABLE = 'TASK_CLI_TEST_GITLAB_TOKEN';

function configure(tier: FakeTier, extraOptions = ''): void {
	const sep = tier === 'free' ? ':' : '::';
	fs.writeFileSync(
		ownConfigFile(project.storage),
		`statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
    - { name: cancelled, terminal: true, outcome: negative }
strategy:
    type: gitlab
    options:
        project: ${fake.project}
        tier: ${tier}
        baseUrl: ${fake.baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        cache: { ttlSeconds: 0 }
        timeoutSeconds: 3
        writeSpacingSeconds: 0
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status${sep}in-progress' }
            done: { state: closed }
            cancelled: { state: closed, label: 'status${sep}cancelled' }
${extraOptions}`
	);
}

async function start(tier: FakeTier, extraOptions = ''): Promise<void> {
	fake = await FakeGitLab.start({ project: 'acme/shop', tier });
	configure(tier, extraOptions);
	vi.stubEnv(TOKEN_VARIABLE, fake.token);
}

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-gitlab-'));
	project = await registerTestProject(path.join(tmpDir, 'shop'));
	stderr = [];
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await fake?.stop();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const run = (...args: string[]) => runTaskCommand(args, project.dir);

function seed(tier: FakeTier): void {
	const sep = tier === 'free' ? ':' : '::';
	// #1 alpha (in progress, labelled, bug) ; #2 beta ; #3 gamma closed ; #4 delta cancelled
	fake.seedIssue({
		title: 'Alpha release',
		description: 'The body of alpha',
		labels: [`status${sep}in-progress`, 'billing', `type${sep}bug`],
	});
	fake.seedIssue({ title: 'Beta', labels: ['billing'] });
	fake.seedIssue({ title: 'Gamma', state: 'closed' });
	fake.seedIssue({ title: 'Delta', state: 'closed', labels: [`status${sep}cancelled`] });
	fake.seedNote(2, 'first note', 'ann');
}

describe.each<FakeTier>(['free', 'premium'])('task, reads and writes on a gitlab project, tier %s', tier => {
	beforeEach(async () => {
		await start(tier);
	});

	it('list shows the open issues with their iid as id; --all adds the closed ones with their status', async () => {
		seed(tier);

		const open = JSON.parse((await run('list', '--json')).output) as Array<{ id: string; status: string }>;
		const all = JSON.parse((await run('list', '--all', '--json')).output) as Array<{ id: string; status: string }>;

		expect(open.map(task => [task.id, task.status])).toEqual([
			['1', 'in-progress'],
			['2', 'backlog'],
		]);
		expect(all.map(task => [task.id, task.status])).toEqual([
			['1', 'in-progress'],
			['2', 'backlog'],
			['3', 'done'],
			['4', 'cancelled'],
		]);
	});

	it('show gives the record: description, labels, type, comments; a missing task is the usual not-found error', async () => {
		seed(tier);

		const alpha = JSON.parse((await run('show', '1', '--json')).output) as Record<string, unknown>;
		const beta = JSON.parse((await run('show', '2', '--json')).output) as Record<string, unknown>;
		const missing = await run('show', '99');

		expect(alpha).toMatchObject({ description: 'The body of alpha', type: 'bug', labels: ['billing'] });
		expect((beta['comments'] as Array<{ text: string; author: string }>)[0]).toMatchObject({
			text: 'first note',
			author: 'ann',
		});
		expect(missing.exitCode).toBe(1);
		expect(missing.output).toContain('Task not found: 99');
	});

	it('new, set-status, add-label, set-type, comment reach GitLab and the reads show them', async () => {
		seed(tier);
		const sep = tier === 'free' ? ':' : '::';

		const created = await run('new', 'A new task');
		const moved = await run('set-status', '5', 'in-progress');
		const labelled = await run('add-label', '5', 'urgent');
		const typed = await run('set-type', '5', 'bug');
		const commented = await run('comment', '5', 'hello');

		for (const result of [created, moved, labelled, typed, commented])
			expect(result.exitCode, result.output).toBe(0);
		expect(JSON.parse(created.output)).toMatchObject({ id: '5', title: 'A new task', status: 'backlog' });
		expect(fake.labelsOf(5).sort()).toEqual(
			['status' + sep + 'in-progress', 'type' + sep + 'bug', 'urgent'].sort()
		);
		const shown = JSON.parse((await run('show', '5', '--json')).output) as Record<string, unknown>;
		expect(shown).toMatchObject({ id: '5', status: 'in-progress', type: 'bug', labels: ['urgent'] });
		expect((shown['comments'] as Array<{ text: string }>).map(comment => comment.text)).toEqual(['hello']);
		const done = await run('set-status', '5', 'done');
		expect(done.exitCode, done.output).toBe(0);
		expect(fake.issue(5)!.state).toBe('closed');
	});

	it('writes nothing in the data folder of the project: the tasks are on GitLab', async () => {
		await run('new', 'A new task');
		await run('set-status', '1', 'done');

		expect(fs.existsSync(path.join(project.storage.dataDir, 'tasks'))).toBe(false);
		expect(fs.existsSync(path.join(project.storage.dataDir, 'task-index.json'))).toBe(false);
	});

	it('set-parent is refused (hierarchy), text and --json, and nothing is written', async () => {
		seed(tier);

		const text = await run('set-parent', '2', '1');
		const json = JSON.parse((await run('set-parent', '2', '1', '--json')).output) as {
			error: string;
			hint: string;
		};

		expect(text.exitCode).toBe(1);
		expect(text.output).toContain('capability "hierarchy"');
		expect(json.error).toContain('capability "hierarchy"');
		expect(json.hint).toMatch(/parent/i);
		expect(fake.writes()).toEqual([]);
	});

	it('meta and delete without their fill exit 1 with the key to write', async () => {
		seed(tier);

		const meta = await run('set-meta', '1', 'k', 'v');
		const del = await run('delete', '1');

		expect(meta.exitCode).toBe(1);
		expect(meta.output).toContain('capability "meta"');
		expect(meta.output).toContain('meta: labels');
		expect(del.exitCode).toBe(1);
		expect(del.output).toContain('capability "delete"');
		expect(del.output).toContain('tombstone');
		expect(fake.writes()).toEqual([]);
	});

	it('the author of a comment cannot be chosen: GitLab writes it as the token user', async () => {
		seed(tier);

		const result = await run('comment', '1', 'hello', '--author', 'ann');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('--author');
		expect(fake.writes()).toEqual([]);
	});

	it('a description that would run a GitLab quick action is refused before any request', async () => {
		const result = await run('new', 'Quick', '--description', 'hello\n/close');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('/');
		expect(fake.writes()).toEqual([]);
		expect(fake.quickActionsRun).toBe(0);
	});

	it('a status change that GitLab refuses is a clear error', async () => {
		seed(tier);
		fake.failNext({ status: 400, method: 'PUT', body: { message: { labels: ['are invalid'] } } });

		const result = await run('set-status', '1', 'done');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('GitLab refused');
		expect(result.output).toContain('are invalid');
	});
});

describe('task, links on a gitlab project', () => {
	it('premium: link blockedBy reaches GitLab as is_blocked_by and links shows it both ways', async () => {
		await start('premium');
		seed('premium');

		const linked = await run('link', '2', 'blockedBy', '1');
		const beta = JSON.parse((await run('links', '2')).output) as { blockedBy: Array<{ id: string }> };
		const alpha = JSON.parse((await run('links', '1')).output) as { blocks: Array<{ id: string }> };

		expect(linked.exitCode, linked.output).toBe(0);
		expect(fake.links(2)).toEqual([{ iid: 1, type: 'is_blocked_by' }]);
		expect(beta.blockedBy.map(task => task.id)).toEqual(['1']);
		expect(alpha.blocks.map(task => task.id)).toEqual(['2']);
	});

	it('free: link blockedBy is refused with the tier named in the hint, in text and in --json', async () => {
		await start('free');
		seed('free');

		const text = await run('link', '2', 'blockedBy', '1');
		const json = JSON.parse((await run('link', '2', 'blockedBy', '1', '--json')).output) as {
			error: string;
			hint: string;
		};

		expect(text.exitCode).toBe(1);
		expect(text.output).toContain('capability "linkTypes"');
		expect(text.output).toMatch(/Premium/);
		expect(json.hint).toContain('tier');
		expect(fake.writes()).toEqual([]);
	});

	it('causedBy without its fill is refused with the fill to write; with the fill it is a managed block and a relates_to link', async () => {
		await start('free');
		seed('free');
		const refused = await run('link', '2', 'causedBy', '1');
		expect(refused.exitCode).toBe(1);
		expect(refused.output).toContain('relate-block');

		configure('free', '        fills:\n            linkTypes.causedBy: { use: relate-block, fidelity: degrade }\n');
		fs.writeFileSync(
			ownConfigFile(project.storage),
			fs
				.readFileSync(ownConfigFile(project.storage), 'utf8')
				.replace('strategy:\n', 'strategy:\n    fidelity: degrade\n')
		);
		const linked = await run('link', '2', 'causedBy', '1');

		expect(linked.exitCode, linked.output).toBe(0);
		expect(fake.issue(2)!.description).toContain('"type":"causedBy"');
		expect(fake.links(2)).toEqual([{ iid: 1, type: 'relates_to' }]);
	});
});

describe('task delete on a gitlab project with a delete fill', () => {
	it('tombstone: one PUT closes the issue and labels it task:deleted; it is then hidden', async () => {
		await start('free', '        fills:\n            delete: tombstone\n');
		fs.writeFileSync(
			ownConfigFile(project.storage),
			fs
				.readFileSync(ownConfigFile(project.storage), 'utf8')
				.replace('strategy:\n', 'strategy:\n    fidelity: degrade\n')
		);
		seed('free');

		const result = await run('delete', '2');

		expect(result.exitCode, result.output).toBe(0);
		expect(fake.issue(2)!.state).toBe('closed');
		expect(fake.labelsOf(2)).toContain('task:deleted');
		const listed = JSON.parse((await run('list', '--all', '--json')).output) as Array<{ id: string }>;
		expect(listed.map(task => task.id)).toEqual(['1', '3', '4']);
		expect(stderr.join('')).toContain('delete is emulated');
	});

	it('hard: DELETE the issue, it is gone', async () => {
		await start('premium', '        fills:\n            delete: hard\n');
		seed('premium');

		const result = await run('delete', '2');

		expect(result.exitCode, result.output).toBe(0);
		expect(fake.issue(2)).toBeUndefined();
		expect(fake.writes().map(request => `${request.method} ${request.path}`)).toEqual([
			'DELETE /projects/42/issues/2',
		]);
	});

	it('hard without the right: the error names the tombstone fill', async () => {
		fake = await FakeGitLab.start({ project: 'acme/shop', tier: 'free', canDelete: false });
		configure('free', '        fills:\n            delete: hard\n');
		vi.stubEnv(TOKEN_VARIABLE, fake.token);
		seed('free');

		const result = await run('delete', '2');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('tombstone');
	});
});

describe('task labels sync on a gitlab project', () => {
	beforeEach(async () => {
		await start('free');
	});

	it('--dry-run lists the labels the configuration needs and creates none', async () => {
		const result = await run('labels', 'sync', '--dry-run');

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('Dry run');
		expect(result.output).toMatch(/would create\s+status:in-progress/);
		expect(fake.writes()).toEqual([]);
	});

	it('creates the missing labels with a colour, then says there is nothing to do', async () => {
		const first = await run('labels', 'sync');
		const second = await run('labels', 'sync');

		expect(first.exitCode, first.output).toBe(0);
		expect(first.output).toMatch(/created\s+status:in-progress/);
		expect(fake.projectLabels().map(label => label.name)).toEqual(['status:in-progress', 'status:cancelled']);
		expect(fake.projectLabels()[0]!.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
		expect(second.output).toContain('nothing to create');
	});

	it('--json is the report of the service', async () => {
		const report = JSON.parse((await run('labels', 'sync', '--json')).output) as {
			dryRun: boolean;
			created: string[];
		};

		expect(report).toMatchObject({ dryRun: false, created: ['status:in-progress', 'status:cancelled'] });
	});
});

describe('task, the token and the network', () => {
	beforeEach(async () => {
		await start('free');
	});

	it('a token that is not set is an error naming the variable, the file and the fix, even for a read', async () => {
		vi.stubEnv(TOKEN_VARIABLE, '');

		const result = await run('list');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(`No GitLab token: the environment variable ${TOKEN_VARIABLE} is not set`);
		expect(result.output).toContain(ownConfigFile(project.storage));
		expect(result.output).toContain(`export ${TOKEN_VARIABLE}=<token>`);
		expect(fake.requests).toEqual([]);
	});

	it('a rejected token (401) never appears in the output and the hint names the scope', async () => {
		vi.stubEnv(TOKEN_VARIABLE, 'a-wrong-token-value');

		const result = await run('list');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('GitLab refused the token (401');
		expect(result.output).toContain('scope');
		expect(result.output).not.toContain('a-wrong-token-value');
		expect(stderr.join('')).not.toContain('a-wrong-token-value');
	});

	it('a 429 says when to retry', async () => {
		fake.forceRateLimit({ retryAfterSeconds: 120, times: 1 });

		const result = await run('list');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('rate limit is reached');
		expect(result.output).toMatch(/Retry after 20\d\d-/);
	});

	it('an unreachable GitLab is an error with the network fix', async () => {
		seed('free');
		fake.dropNext(20);

		const result = await run('list');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('Cannot reach');
		expect(result.output).toContain('baseUrl');
	});

	it('a read-only token (read_api) reads, and a write is refused naming the scope api', async () => {
		await fake.stop();
		fake = await FakeGitLab.start({ project: 'acme/shop', tier: 'free', readOnlyToken: true });
		configure('free');
		vi.stubEnv(TOKEN_VARIABLE, fake.token);
		seed('free');

		const read = await run('list');
		const write = await run('set-status', '1', 'done');

		expect(read.exitCode, read.output).toBe(0);
		expect(write.exitCode).toBe(1);
		expect(write.output).toContain('api');
		expect(write.output).not.toContain(fake.token);
	});

	it('never sends anything but GET for a read', async () => {
		seed('free');
		await run('list', '--all');
		await run('show', '1');

		expect(fake.writes()).toEqual([]);
	});
});

describe('task strategy on a gitlab project', () => {
	it('show lists the tier, the capabilities (writes native, hierarchy unsupported, meta and delete unsupported without fill) and the token variable, never its value', async () => {
		await start('free');

		const result = await run('strategy', 'show');

		expect(result.exitCode, result.output).toBe(0);
		expect(result.output).toContain('gitlab (plugins.gitlab.default)');
		expect(result.output).toMatch(/Tier:\s+free \(declared\)/);
		expect(result.output).toMatch(/writes\s+native\s+full/);
		expect(result.output).toMatch(/hierarchy\s+unsupported/);
		expect(result.output).toMatch(/meta\s+unsupported/);
		expect(result.output).toMatch(/delete\s+unsupported/);
		expect(result.output).toMatch(/linkTypes\.blockedBy\s+unsupported/);
		expect(result.output).toContain(`${TOKEN_VARIABLE} (environment variable, set)`);
		expect(result.output).not.toContain(fake.token);
	});

	it('show on premium has the blocking links natively', async () => {
		await start('premium');

		const result = await run('strategy', 'show');

		expect(result.output).toMatch(/linkTypes\.blockedBy\s+native/);
	});

	it('check contacts GitLab, shows the tier, ends with the not-verified warning, exit 0 with warnings only; --json carries the same lines', async () => {
		await start('premium');
		seed('premium');

		const ok = await run('strategy', 'check');
		const json = JSON.parse((await run('strategy', 'check', '--json')).output) as {
			ok: boolean;
			warnings: number;
			lines: Array<{ name: string; status: string; text: string }>;
		};

		expect(ok.exitCode, ok.output).toBe(0);
		expect(ok.output).toMatch(/tier\s+ok\s+.*premium/);
		expect(ok.output).toContain('not been verified against a real GitLab instance');
		expect(ok.output).toMatch(/Result: ok/);
		expect(ok.output).not.toContain(fake.token);
		expect(json.ok).toBe(true);
		expect(json.lines.at(-1)).toMatchObject({ name: 'verification', status: 'warn' });
	});

	it('check with a wrong token is exit 1, names the 401 and still ends with the not-verified warning', async () => {
		await start('free');
		vi.stubEnv(TOKEN_VARIABLE, 'a-wrong-token-value');

		const bad = await run('strategy', 'check');

		expect(bad.exitCode).toBe(1);
		expect(bad.output).toContain('GitLab refused the token (401');
		expect(bad.output).toContain('not been verified against a real GitLab instance');
		expect(bad.output).toContain('Result: FAILED');
		expect(bad.output).not.toContain('a-wrong-token-value');
	});

	it('check warns when the declared tier is higher than the plan GitLab reports', async () => {
		fake = await FakeGitLab.start({ project: 'acme/shop', tier: 'premium', namespacePlan: 'free' });
		configure('premium');
		vi.stubEnv(TOKEN_VARIABLE, fake.token);

		const result = await run('strategy', 'check');

		expect(result.exitCode, result.output).toBe(0);
		expect(result.output).toMatch(/tier\s+warn/);
	});
});
