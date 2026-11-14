import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeGitHub } from './plugins/github/fakeGitHub.testkit.js';
import { listTasks } from './listTasks.js';
import { openResolvedProject } from './openContext.js';
import { resolveProject } from './resolveProject.js';
import { ownConfigFile } from './storage.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

const TOKEN_VARIABLE = 'TASK_FRESH_TEST_TOKEN';
let sandbox: SharedRegistrySandbox;
let fake: FakeGitHub;

beforeEach(async () => {
	sandbox = createSharedRegistrySandbox();
	fake = await FakeGitHub.start();
	fake.addIssue({ title: 'first' });
});

afterEach(async () => {
	await fake.stop();
	sandbox.cleanup();
});

async function openGithubProject() {
	const dir = sandbox.dir('forge');
	const added = await sandbox.register('forge', dir);
	const resolved = resolveProject({ cwd: dir, projectRef: added.id, env: sandbox.env });
	fs.mkdirSync(path.dirname(ownConfigFile(resolved.storage)), { recursive: true });
	fs.writeFileSync(
		ownConfigFile(resolved.storage),
		`statuses:
    - backlog
    - { name: done, terminal: true }
strategy:
    type: github
    options:
        repo: ${fake.repo}
        baseUrl: ${fake.baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        writeSpacingSeconds: 0
        timeoutSeconds: 3
        cache: { ttlSeconds: 600 }
        statusMap:
            backlog: { state: open }
            done: { state: closed }
`
	);
	return openResolvedProject(resolved, path.join(sandbox.root, 'global'), {
		env: { ...sandbox.env, [TOKEN_VARIABLE]: fake.token },
	});
}

/** The requests that read the issue list (not a single issue, not the timeline). */
const listReads = (): number =>
	fake.requests.filter(request => request.method === 'GET' && request.path === `/repos/${fake.repo}/issues`).length;

describe('listTasks fresh', () => {
	it('a default list inside the cache TTL asks GitHub once; fresh: true asks again, for that call only', async () => {
		const ctx = await openGithubProject();
		try {
			await listTasks(ctx, {});
			const afterFirst = listReads();
			expect(afterFirst).toBeGreaterThan(0);

			await listTasks(ctx, {});
			expect(listReads()).toBe(afterFirst);

			const rows = await listTasks(ctx, { fresh: true });
			expect(rows.map(row => row.title)).toEqual(['first']);
			expect(listReads()).toBeGreaterThan(afterFirst);

			// The next default list is back inside the TTL of the context: nothing asked, the context itself was never made fresh.
			const afterFresh = listReads();
			await listTasks(ctx, {});
			expect(listReads()).toBe(afterFresh);
		} finally {
			await ctx.dispose?.();
		}
	});

	it('the filtered and ordered list honours fresh too', async () => {
		const ctx = await openGithubProject();
		try {
			await listTasks(ctx, { limit: 5 });
			const before = listReads();
			await listTasks(ctx, { limit: 5 });
			expect(listReads()).toBe(before);
			await listTasks(ctx, { limit: 5, fresh: true });
			expect(listReads()).toBeGreaterThan(before);
		} finally {
			await ctx.dispose?.();
		}
	});

	it('fresh on a hand-built context of a forge project is a loud error, never a silent cached read', async () => {
		const ctx = await openGithubProject();
		try {
			const { openFresh: _openFresh, ...handBuilt } = ctx;
			await expect(listTasks(handBuilt, { fresh: true })).rejects.toThrow(
				'fresh reads were asked for on a github project'
			);
		} finally {
			await ctx.dispose?.();
		}
	});
});
