import { BackendAuthError, RateLimitedError } from '@wadeck-app/task-core';
import { afterEach, describe, expect, it } from 'vitest';

import { FakeGitLab, LIVE_TOKEN_PERMISSIONS } from './fakeGitLab.testkit.js';
import type { FakeGitLabOptions } from './fakeGitLab.testkit.js';
import { GitLabClient, GitLabHttpError } from './gitlabClient.js';
import type { GitLabClientOptions } from './gitlabClient.js';

// GraphQL through GitLabClient against the local mock: the same token, rate limit wait, redaction and error mapping as the REST calls.

const READ = 'query($id: WorkItemID!) { workItem(id: $id) { id iid title } }';
const SET_PARENT =
	'mutation($input: WorkItemUpdateInput!) { workItemUpdate(input: $input) { errors workItem { id iid } } }';

let fake: FakeGitLab | undefined;

afterEach(async () => {
	await fake?.stop();
	fake = undefined;
});

interface Setup {
	fake?: FakeGitLabOptions;
	client?: Partial<GitLabClientOptions>;
}

async function start(
	setup: Setup = {}
): Promise<{ server: FakeGitLab; client: GitLabClient; gid: (iid: number) => string }> {
	const server = await FakeGitLab.start(setup.fake);
	fake = server;
	server.seedIssue({ title: 'Issue' });
	server.seedIssue({ title: 'Task', issueType: 'task' });
	const client = new GitLabClient({
		baseUrl: server.baseUrl,
		token: server.token,
		project: server.project,
		tokenHint: 'the environment variable GITLAB_TOKEN (strategy.options.tokenEnv)',
		timeoutMs: 2000,
		cacheTtlMs: 60_000,
		writeSpacingMs: 0,
		...setup.client,
	});
	return { server, client, gid: iid => `gid://gitlab/WorkItem/${server.issue(iid)!.id}` };
}

interface ReadAnswer {
	data: { workItem: { iid: string; title: string } | null };
}

describe('GitLabClient.graphql', () => {
	it('reads a work item at /api/graphql and returns the { data, errors } body as is', async () => {
		const { server, client, gid } = await start();

		const answer = await client.graphql<ReadAnswer>({ query: READ, variables: { id: gid(1) } });

		expect(answer.status).toBe(200);
		expect(answer.body.data.workItem).toMatchObject({ iid: '1', title: 'Issue' });
		const request = server.requestsTo('/api/graphql').at(-1)!;
		expect(request.method).toBe('POST');
		expect(request.path).toBe('/api/graphql');
	});

	it('a read is never cached, and does not expire the read cache of the REST reads', async () => {
		const { server, client, gid } = await start();
		await client.get(`/projects/${server.project.replace('/', '%2F')}/issues`);
		const before = server.requestsTo('/projects').length;

		await client.graphql<ReadAnswer>({ query: READ, variables: { id: gid(1) } });
		await client.graphql<ReadAnswer>({ query: READ, variables: { id: gid(1) } });
		await client.get(`/projects/${server.project.replace('/', '%2F')}/issues`);

		expect(server.requestsTo('/api/graphql')).toHaveLength(2);
		expect(server.requestsTo('/projects')).toHaveLength(before);
	});

	it('a write goes through the write queue and expires the read cache', async () => {
		const { server, client, gid } = await start();
		const issues = `/projects/${server.project.replace('/', '%2F')}/issues`;
		await client.get(issues);
		await client.get(issues);
		expect(server.requestsTo('/projects')).toHaveLength(1);

		const answer = await client.graphql<{ data: { workItemUpdate: { errors: string[] } } }>(
			{ query: SET_PARENT, variables: { input: { id: gid(2), hierarchyWidget: { parentId: gid(1) } } } },
			{ write: true }
		);

		expect(answer.body.data.workItemUpdate.errors).toEqual([]);
		expect(server.issue(2)!.parentIid).toBe(1);
		await client.get(issues);
		expect(server.requestsTo('/projects')).toHaveLength(2);
	});

	it('a 403 insufficient_granular_scope on a read names the permission', async () => {
		const { client, gid } = await start({ fake: { permissions: ['Label: Read'] } });

		const read = (await client
			.graphql<ReadAnswer>({ query: READ, variables: { id: gid(1) } })
			.catch((error: unknown) => error)) as BackendAuthError;

		expect(read).toBeInstanceOf(BackendAuthError);
		expect(read.reason).toBe('forbidden');
		expect(read.message).toContain('Work Item: Read');
		expect(read.hint).toContain('Add the permission Work Item: Read');
	});

	it('a 403 insufficient_granular_scope on a write names the permission', async () => {
		const { client, gid } = await start({
			fake: { permissions: LIVE_TOKEN_PERMISSIONS.filter(name => name !== 'Work Item: Update') },
		});

		const write = (await client
			.graphql(
				{ query: SET_PARENT, variables: { input: { id: gid(2), hierarchyWidget: { parentId: gid(1) } } } },
				{ write: true }
			)
			.catch((error: unknown) => error)) as BackendAuthError;

		expect(write).toBeInstanceOf(BackendAuthError);
		expect(write.message).toContain('Work Item: Update');
	});

	it('waits for the window to reopen once the headers say the quota is empty (one notice), then sends the request', async () => {
		let now = Date.parse('2026-11-09T10:00:00Z');
		const waits: number[] = [];
		const notices: string[] = [];
		const { server, client, gid } = await start({
			fake: { clock: () => now, rateLimit: { limit: 4, windowSeconds: 60 } },
			client: {
				now: () => now,
				sleep: ms => {
					waits.push(ms);
					now += ms;
					return Promise.resolve();
				},
				notice: text => notices.push(text),
			},
		});
		// The queries themselves use up the quota of 4: the fifth finds the headers saying remaining 0 and waits before sending.
		for (let index = 0; index < 4; index++) {
			await client.graphql<ReadAnswer>({ query: READ, variables: { id: gid(1) } });
		}
		expect(waits).toEqual([]);

		const answer = await client.graphql<ReadAnswer>({ query: READ, variables: { id: gid(1) } });

		expect(answer.body.data.workItem).toMatchObject({ iid: '1' });
		expect(waits).toHaveLength(1);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatch(
			/^GitLab rate limit reached \(4 requests per window\): waiting \d+ s for the window to reopen$/
		);
		expect(server.requestsTo('/api/graphql')).toHaveLength(5);
	});

	it('a wait longer than maxWaitMs is a RateLimitedError that names maxWaitSeconds', async () => {
		const now = Date.parse('2026-11-09T10:00:00Z');
		const { client, gid } = await start({
			fake: { clock: () => now, rateLimit: { limit: 1, windowSeconds: 600 } },
			client: { now: () => now, maxWaitMs: 5000 },
		});
		await client.graphql<ReadAnswer>({ query: READ, variables: { id: gid(1) } });

		const error = (await client
			.graphql<ReadAnswer>({ query: READ, variables: { id: gid(1) } })
			.catch((failed: unknown) => failed)) as RateLimitedError;

		expect(error).toBeInstanceOf(RateLimitedError);
		expect(error.hint).toContain('strategy.options.rateLimit.maxWaitSeconds (now 5)');
	});

	it('hides the token in a failure', async () => {
		const { server, client, gid } = await start();
		server.failNext({ status: 400, body: { message: `bad request ${server.token}` } });

		const error = (await client
			.graphql<ReadAnswer>({ query: READ, variables: { id: gid(1) } })
			.catch((failed: unknown) => failed)) as GitLabHttpError;

		expect(error).toBeInstanceOf(GitLabHttpError);
		expect(error.message).toContain('***');
		expect(error.message).not.toContain(server.token);
	});
});
