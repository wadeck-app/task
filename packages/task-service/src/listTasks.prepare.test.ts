import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeGitHub } from './plugins/github/fakeGitHub.testkit.js';
import { listTasks } from './listTasks.js';
import { nextTask } from './nextTask.js';
import { openResolvedProject } from './openContext.js';
import { resolveProject } from './resolveProject.js';
import { ownConfigFile } from './storage.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

// A dispatcher ranks the backlog by priority. On a github project whose priorities live in the native issue field, a plain read of an
// `auto` project reads none until the storage is resolved: the dispatch reads (order, priority filter, available...) ask the backend to
// `prepare` first, so they never rank everything as the default priority.
const TOKEN_VARIABLE = 'TASK_PREPARE_TEST_TOKEN';
const FIELDS = [{ id: 501, name: 'Priority', options: ['urgent', 'high', 'medium', 'low'] }];
let sandbox: SharedRegistrySandbox;
let fake: FakeGitHub;

beforeEach(() => {
	sandbox = createSharedRegistrySandbox();
});

afterEach(async () => {
	await fake.stop();
	sandbox.cleanup();
});

async function open(extraOptions = '') {
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
        cache: { ttlSeconds: 0 }
${extraOptions}        statusMap:
            backlog: { state: open }
            done: { state: closed }
`
	);
	return openResolvedProject(resolved, path.join(sandbox.root, 'global'), {
		env: { ...sandbox.env, [TOKEN_VARIABLE]: fake.token },
	});
}

const seed = (): void => {
	// Created low first, then urgent: by age alone the low one would come first.
	fake.setIssueField(fake.addIssue({ title: 'low one' }), 'Priority', 'low');
	fake.setIssueField(fake.addIssue({ title: 'urgent one' }), 'Priority', 'urgent');
};

describe('dispatch reads prepare the backend: the priority is resolved first', () => {
	it('field set by REST, nothing resolved before: --order priority-then-oldest ranks by the field', async () => {
		fake = await FakeGitHub.start({ issueFields: FIELDS, issueFieldDefinitions: 'readable' });
		seed();
		const ctx = await open();
		try {
			const rows = await listTasks(ctx, { order: 'priority-then-oldest' });

			expect(rows.map(row => [row.title, row.priority])).toEqual([
				['urgent one', 'urgent'],
				['low one', 'low'],
			]);
		} finally {
			await ctx.dispose?.();
		}
	});

	it('--priority and task next see the field too', async () => {
		fake = await FakeGitHub.start({ issueFields: FIELDS, issueFieldDefinitions: 'readable' });
		seed();
		const ctx = await open();
		try {
			const urgent = await listTasks(ctx, { priorities: ['urgent'] });
			const next = await nextTask(ctx, { assignee: 'w1' });

			expect(urgent.map(row => row.title)).toEqual(['urgent one']);
			expect(next.claim?.task.title).toBe('urgent one');
		} finally {
			await ctx.dispose?.();
		}
	});

	it('a plain list asks nothing about the priority', async () => {
		fake = await FakeGitHub.start({ issueFields: FIELDS, issueFieldDefinitions: 'readable' });
		seed();
		const ctx = await open();
		try {
			await listTasks(ctx, {});

			expect(fake.requests.some(request => request.path.startsWith('/orgs/'))).toBe(false);
		} finally {
			await ctx.dispose?.();
		}
	});

	it('auto with the definitions refused (403): it ranks by labels, quietly', async () => {
		fake = await FakeGitHub.start({ issueFields: FIELDS });
		fake.addIssue({ title: 'low one', labels: ['priority:low'] });
		fake.addIssue({ title: 'urgent one', labels: ['priority:urgent'] });
		const ctx = await open();
		try {
			const rows = await listTasks(ctx, { order: 'priority-then-oldest' });

			expect(rows.map(row => row.title)).toEqual(['urgent one', 'low one']);
			expect(ctx.takeNotices?.() ?? []).toEqual([]);
		} finally {
			await ctx.dispose?.();
		}
	});

	it('priorityStorage: field with no id and the definitions refused: a loud error with the fix', async () => {
		fake = await FakeGitHub.start({ issueFields: FIELDS });
		seed();
		const ctx = await open('        priorityStorage: field\n');
		try {
			await expect(listTasks(ctx, { order: 'priority-then-oldest' })).rejects.toThrow(
				/priorityStorage: field needs the issue field "Priority"/
			);
		} finally {
			await ctx.dispose?.();
		}
	});

	it('one list request per 100 issues, plus the single definitions request when the storage is unresolved', async () => {
		fake = await FakeGitHub.start({ issueFields: FIELDS, issueFieldDefinitions: 'readable' });
		seed();
		const ctx = await open();
		try {
			fake.requests.splice(0);
			await listTasks(ctx, { order: 'priority-then-oldest' });
			const first = fake.requests.map(request => request.path);
			fake.requests.splice(0);
			await listTasks(ctx, { order: 'priority-then-oldest' });
			const second = fake.requests.map(request => request.path);

			expect(first).toEqual(['/orgs/acme/issue-fields', '/repos/acme/shop/issues']);
			expect(second).toEqual(['/repos/acme/shop/issues']);
		} finally {
			await ctx.dispose?.();
		}
	});
});
