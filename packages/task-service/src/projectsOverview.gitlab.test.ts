import * as fs from 'node:fs';
import * as path from 'node:path';

import { FakeGitLab } from './plugins/gitlab/fakeGitLab.testkit.js';
import { openResolvedProject } from './openContext.js';
import { NoReadableProjectsError } from './errors.js';
import { listTasksAcrossProjects, summarizeProjects } from './projectsOverview.js';
import { resolveProject } from './resolveProject.js';
import { ownConfigFile } from './storage.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

// One project on the gitlab strategy among local ones: its failures (no token, unreachable, rate limited) make THAT project
// unreadable, with the reason and the fix, and never fail the views of the others. NOT verified against a real GitLab (fake server).
const TOKEN_VARIABLE = 'TASK_OVERVIEW_GITLAB_TOKEN';

let sandbox: SharedRegistrySandbox;
let fake: FakeGitLab;

beforeEach(async () => {
	fake = await FakeGitLab.start({ project: 'acme/shop' });
	sandbox = createSharedRegistrySandbox();
	vi.stubEnv(TOKEN_VARIABLE, fake.token);

	const local = sandbox.dir('local');
	await sandbox.register('local', local);
	const localProject = resolveProject({ cwd: local, env: sandbox.env });
	fs.mkdirSync(path.dirname(ownConfigFile(localProject.storage)), { recursive: true });
	fs.writeFileSync(
		ownConfigFile(localProject.storage),
		'statuses:\n  - backlog\n  - { name: done, terminal: true }\n'
	);
	const ctx = openResolvedProject(localProject);
	await ctx.store.create({ title: 'local one', status: 'backlog' });
	await ctx.store.create({ title: 'local two', status: 'backlog' });

	const remote = sandbox.dir('remote');
	await sandbox.register('remote', remote);
	const remoteProject = resolveProject({ cwd: remote, env: sandbox.env });
	fs.mkdirSync(path.dirname(ownConfigFile(remoteProject.storage)), { recursive: true });
	fs.writeFileSync(
		ownConfigFile(remoteProject.storage),
		`statuses:
    - backlog
    - { name: done, terminal: true }
strategy:
    type: gitlab
    options:
        project: acme/shop
        baseUrl: ${fake.baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        timeoutSeconds: 2
        statusMap:
            backlog: { state: open }
            done: { state: closed }
`
	);
	fake.seedIssue({ title: 'remote one' });
	fake.seedIssue({ title: 'remote done', state: 'closed' });
});

afterEach(async () => {
	vi.unstubAllEnvs();
	sandbox.cleanup();
	await fake.stop();
});

describe('summarizeProjects with a gitlab project', () => {
	it('counts it like any other when it can be read', async () => {
		const summary = await summarizeProjects({ env: sandbox.env });

		expect(summary.readableCount).toBe(2);
		expect(summary.projects.map(p => [p.name, p.open, p.total, p.error])).toEqual([
			['local', 2, 2, null],
			['remote', 1, 2, null],
		]);
		expect(summary.open).toBe(3);
	});

	it('a missing token makes it unreadable, with the reason and the fix, and the other project is still counted', async () => {
		vi.stubEnv(TOKEN_VARIABLE, '');

		const summary = await summarizeProjects({ env: sandbox.env });

		expect(summary.readableCount).toBe(1);
		const remote = summary.projects.find(p => p.name === 'remote')!;
		expect([remote.open, remote.total]).toEqual([null, null]);
		expect(remote.error).toContain(`No GitLab token: the environment variable ${TOKEN_VARIABLE} is not set`);
		expect(remote.error).toContain(`export ${TOKEN_VARIABLE}=<token>`);
		expect(summary.open).toBe(2);
	});

	it('an unreachable GitLab and a rate limit are reasons too', async () => {
		fake.dropNext(1);
		const unreachable = await summarizeProjects({ env: sandbox.env });
		// Longer than the 70 s a command waits for the window to reopen: the project is reported unreadable.
		fake.forceRateLimit({ retryAfterSeconds: 600, times: 1 });
		const limited = await summarizeProjects({ env: sandbox.env });

		expect(unreachable.projects.find(p => p.name === 'remote')!.error).toContain('Cannot reach');
		expect(limited.projects.find(p => p.name === 'remote')!.error).toContain('GitLab rate limit reached');
		expect(limited.readableCount).toBe(1);
		expect(limited.open).toBe(2);
	});

	it('when no project can be read it fails with the reasons, as for any unreadable project', async () => {
		vi.stubEnv(TOKEN_VARIABLE, '');
		const local = resolveProject({ cwd: path.join(sandbox.root, 'work'), env: sandbox.env, projectRef: 'local' });
		fs.writeFileSync(ownConfigFile(local.storage), 'strategy: [broken');

		await expect(summarizeProjects({ env: sandbox.env })).rejects.toBeInstanceOf(NoReadableProjectsError);
	});
});

describe('listTasksAcrossProjects with a gitlab project', () => {
	it('lists its issues tagged with the project', async () => {
		const listed = await listTasksAcrossProjects({ env: sandbox.env, showAll: true });

		expect(listed.tasks.map(t => [t.project.name, t.title])).toEqual([
			['local', 'local one'],
			['local', 'local two'],
			['remote', 'remote one'],
			['remote', 'remote done'],
		]);
		expect(listed.unreadable).toEqual([]);
	});

	it('a token that is not set leaves the project in `unreadable`, with the fix, and lists the others', async () => {
		vi.stubEnv(TOKEN_VARIABLE, '');

		const listed = await listTasksAcrossProjects({ env: sandbox.env });

		expect(listed.tasks.map(t => t.title)).toEqual(['local one', 'local two']);
		expect(listed.unreadable).toHaveLength(1);
		expect(listed.unreadable[0]).toMatchObject({ name: 'remote' });
		expect(listed.unreadable[0]!.error).toContain('No GitLab token');
		expect(listed.unreadable[0]!.error).toContain(`export ${TOKEN_VARIABLE}=<token>`);
	});

	it('a refused token is a reason, and the token is not in it', async () => {
		vi.stubEnv(TOKEN_VARIABLE, 'the-wrong-token');

		const listed = await listTasksAcrossProjects({ env: sandbox.env });

		expect(listed.unreadable[0]!.error).toContain('GitLab refused the token (401');
		expect(listed.unreadable[0]!.error).not.toContain('the-wrong-token');
	});
});
