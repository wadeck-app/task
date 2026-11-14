// Request budget of the common writes on the github strategy, through the use cases (what `task <command>` runs), against the fake
// server that records every request. A command opens a fresh context (a CLI process), and the cache TTL is 0 (the worst case: every
// read revalidates). The budget is the number of requests each operation may cost; a change that adds one fails here, a change that
// removes one lowers the number (and the table printed below says by how much).
//
// What each request is for, and why the kept ones stay (see CLAUDE.md, "Storage strategy: github"):
//  - the id is resolved with ONE read of the issue (`resolve`), never the whole record;
//  - the write re-reads the issue with a conditional GET before sending (the `expectedRevision` check, the parts it compares);
//  - the record returned is read again after the write (what GitHub holds; the counts and the timeline lag, a PATCH answer has no
//    timeline); a status label that is not known yet costs one probe (a label is created by the project, not by the write).
import * as fs from 'node:fs';
import * as path from 'node:path';

import { FakeGitHub } from './fakeGitHub.testkit.js';
import { addComment } from '../../comments.js';
import { createTask } from '../../createTask.js';
import { executeDelete, planDelete } from '../../deleteTasks.js';
import { setParent } from '../../hierarchy.js';
import { linkTasks } from '../../links.js';
import { openResolvedProject } from '../../openContext.js';
import { resolveProject } from '../../resolveProject.js';
import { setStatus } from '../../setStatus.js';
import { setTaskText } from '../../setTaskText.js';
import { ownConfigFile } from '../../storage.js';
import { addLabel } from '../../taskFields.js';
import { createSharedRegistrySandbox } from '../../testHelpers.js';
import type { SharedRegistrySandbox } from '../../testHelpers.js';
import type { TaskServiceContext } from '../../context.js';

const TOKEN_VARIABLE = 'TASK_BUDGET_GITHUB_TOKEN';

let sandbox: SharedRegistrySandbox;
let fake: FakeGitHub;
let projectDir: string;

beforeEach(async () => {
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
	sandbox = createSharedRegistrySandbox();
	vi.stubEnv(TOKEN_VARIABLE, fake.token);
	projectDir = sandbox.dir('shop');
	await sandbox.register('shop', projectDir);
	const project = resolveProject({ cwd: projectDir, env: sandbox.env });
	fs.mkdirSync(path.dirname(ownConfigFile(project.storage)), { recursive: true });
	fs.writeFileSync(
		ownConfigFile(project.storage),
		`statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
strategy:
    type: github
    fidelity: degrade
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
        fills:
            delete: { use: tombstone, fidelity: degrade }
`
	);
	// The labels the writes need exist already: the budget is the steady state, label creation is measured by its own tests.
	fake.addRepoLabel('status:in-progress');
	fake.addRepoLabel('task:deleted');
	fake.addRepoLabel('urgent');
});

afterEach(async () => {
	vi.unstubAllEnvs();
	sandbox.cleanup();
	await fake.stop();
});

/** A fresh context, like a new `task` process. */
function open(): TaskServiceContext {
	return openResolvedProject(resolveProject({ cwd: projectDir, env: sandbox.env }));
}

interface Measure {
	total: number;
	writes: number;
	lines: string[];
}

/** Runs `operation` on a fresh context and returns the requests it cost. */
async function measure(operation: (ctx: TaskServiceContext) => Promise<unknown>): Promise<Measure> {
	const ctx = open();
	fake.requests.splice(0);
	try {
		await operation(ctx);
	} finally {
		await ctx.dispose?.();
	}
	const lines = fake.requests.map(request => `${request.method} ${request.path.replace('/repos/acme/shop', '')}`);
	return { total: fake.requests.length, writes: fake.writes().length, lines };
}

// What each operation may cost, in requests (reads + writes), with its writes: { total, writes }.
const BUDGET: Record<string, { total: number; writes: number }> = {
	create: { total: 3, writes: 1 },
	'set-status': { total: 6, writes: 1 },
	'set-title': { total: 5, writes: 1 },
	'add-label': { total: 6, writes: 1 },
	'set-parent': { total: 7, writes: 1 },
	'link blockedBy': { total: 9, writes: 1 },
	comment: { total: 7, writes: 1 },
	// An issue with comments and a blocker: the record read after the write has the comments and the blockers, the resolution has not.
	'set-status (3 comments, 1 blocker)': { total: 8, writes: 1 },
	'delete (tombstone)': { total: 9, writes: 2 },
};

const results = new Map<string, Measure>();

describe('request budget of the github writes (ttl 0, fresh process per command)', () => {
	it('measures every common write and stays within its budget', async () => {
		const a = fake.addIssue({ title: 'First task' });
		const b = fake.addIssue({ title: 'Second task' });
		const c = fake.addIssue({ title: 'Third task' });

		results.set('create', await measure(ctx => createTask(ctx, { title: 'New task' })));
		results.set('set-status', await measure(ctx => setStatus(ctx, { id: String(a), status: 'in-progress' })));
		results.set('set-title', await measure(ctx => setTaskText(ctx, { id: String(a), title: 'Renamed' })));
		results.set('add-label', await measure(ctx => addLabel(ctx, { id: String(a), label: 'urgent' })));
		results.set('set-parent', await measure(ctx => setParent(ctx, { id: String(b), parent: String(a) })));
		results.set(
			'link blockedBy',
			await measure(ctx => linkTasks(ctx, { id: String(c), type: 'blockedBy', target: String(a) }))
		);
		results.set('comment', await measure(ctx => addComment(ctx, { id: String(a), text: 'hello' })));
		const busy = fake.addIssue({ title: 'Busy task' });
		for (const text of ['one', 'two', 'three']) fake.addComment(busy, text);
		fake.addBlockedBy(busy, b);
		results.set(
			'set-status (3 comments, 1 blocker)',
			await measure(ctx => setStatus(ctx, { id: String(busy), status: 'in-progress' }))
		);
		results.set(
			'delete (tombstone)',
			await measure(async ctx => {
				const plan = await planDelete(ctx, { selector: { kind: 'ids', ids: [String(c)] } });
				await executeDelete(ctx, plan);
			})
		);

		const table = [...results].map(
			([name, m]) => `${name.padEnd(36)} ${String(m.total).padStart(3)} requests, ${m.writes} write(s)`
		);
		process.stdout.write(`\nGitHub request budget (fake server, ttl 0)\n${table.join('\n')}\n`);
		for (const [name, m] of results) process.stdout.write(`  ${name}: ${m.lines.join(' | ')}\n`);

		const over = [...results]
			.filter(([name, m]) => m.total > BUDGET[name]!.total || m.writes !== BUDGET[name]!.writes)
			.map(
				([name, m]) =>
					`${name}: ${m.total} requests / ${m.writes} writes, budget ${BUDGET[name]!.total} / ${BUDGET[name]!.writes}`
			);
		expect(over).toEqual([]);
	});
});
