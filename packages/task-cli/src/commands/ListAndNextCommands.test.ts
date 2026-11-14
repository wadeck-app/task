import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTaskCommand } from '../TaskIndex.js';
import type { CommandResult } from '../cli/output.js';
import { registerTestProject } from '../testHelpers.js';
import { describeNoTask } from './NextCommand.js';

// task list --status/--assignee/--unassigned/--available/--priority/--order/--limit/--fresh and task next.

let root: string;
let dir: string;
let dataDir: string;

beforeEach(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-list-cmd-'));
	dir = path.join(root, 'work');
	dataDir = (await registerTestProject(dir)).storage.dataDir;
	vi.stubEnv('TASK_WORKER', '');
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

const run = (...args: string[]): Promise<CommandResult> => runTaskCommand(args, dir);
const json = <T = any>(result: CommandResult): T => JSON.parse(result.output) as T;

async function newTask(title: string, priority?: string): Promise<string> {
	const created = await run('new', title);
	expect(created.exitCode, created.output).toBe(0);
	const id = json<{ id: string }>(created).id;
	if (priority !== undefined) expect((await run('set-priority', id, priority)).exitCode).toBe(0);
	return id;
}

describe('task list with filters', () => {
	it('the plain list keeps its rows: no priority key, no lease facts', async () => {
		await newTask('a');
		const rows = json<Array<Record<string, unknown>>>(await run('list'));

		expect(Object.keys(rows[0]!).sort()).toEqual(['createdAt', 'id', 'status', 'title']);
	});

	it('--available --order priority-then-oldest --limit prints ordered rows with the effective priority', async () => {
		const low = await newTask('low', 'low');
		const urgent = await newTask('urgent', 'urgent');
		const plain = await newTask('plain');

		const all = json<Array<{ id: string; priority: string }>>(
			await run('list', '--available', '--order', 'priority-then-oldest')
		);
		const top = json<Array<{ id: string }>>(await run('list', '--order', 'priority-then-oldest', '--limit', '2'));

		expect(all.map(row => [row.id, row.priority])).toEqual([
			[urgent, 'urgent'],
			[plain, 'medium'],
			[low, 'low'],
		]);
		expect(top.map(row => row.id)).toEqual([urgent, plain]);
	});

	it('--status and --priority take comma lists; --assignee and --unassigned select by holder', async () => {
		const a = await newTask('a', 'high');
		const b = await newTask('b', 'low');
		await run('set-status', b, 'in-progress');
		await run('claim', a, '--as', 'w1');

		const ids = async (...args: string[]) => json<Array<{ id: string }>>(await run('list', ...args)).map(r => r.id);

		expect(await ids('--status', 'in-progress,done')).toEqual([b]);
		expect(await ids('--priority', 'high,low')).toEqual([a, b].sort((x, y) => (x === a ? -1 : y === a ? 1 : 0)));
		expect(await ids('--assignee', 'w1')).toEqual([a]);
		expect(await ids('--unassigned')).toEqual([b]);
		const held = json<Array<{ leaseUntil: string; leaseExpired: boolean }>>(await run('list', '--assignee', 'w1'));
		expect(held[0]).toMatchObject({ leaseExpired: false });
		expect(typeof held[0]!.leaseUntil).toBe('string');
	});

	it('works with --parent and --all, and --fresh changes nothing on a local project', async () => {
		const parent = await newTask('parent');
		const child = json<{ id: string }>(await run('new', 'child', '--parent', parent)).id;
		await run('set-status', child, 'done');

		expect(json<unknown[]>(await run('list', '--parent', parent, '--unassigned'))).toHaveLength(0);
		expect(json<unknown[]>(await run('list', '--parent', parent, '--unassigned', '--all'))).toHaveLength(1);
		expect(json(await run('list', '--fresh'))).toEqual(json(await run('list')));
	});

	it('rejects a missing value, a value starting with "-" and an empty list entry, in text and JSON', async () => {
		for (const [args, text] of [
			[['list', '--status'], '--status requires a value'],
			[['list', '--assignee', '--unassigned'], '--assignee requires a value, found "--unassigned"'],
			[['list', '--order', '-x'], '--order requires a value'],
			[['list', '--priority', 'a,,b'], 'empty entry'],
			[['list', '--limit', '0'], '--limit "0" is not a whole number from 1 to 1000'],
			[['list', '--limit', '--fresh'], '--limit requires a value'],
			[['list', '--limit', '1001'], '--limit "1001" is not a whole number from 1 to 1000'],
			[['list', '--limit', 'ten'], 'is not a whole number'],
			[['list', '--assignee', ' '], 'blank'],
		] as const) {
			const result = await run(...args);
			expect(result.exitCode, args.join(' ')).toBe(1);
			expect(result.output, args.join(' ')).toContain(text);
			expect(json(await run(...args, '--json'))).toHaveProperty('error');
		}
	});

	it('names the valid statuses, priorities and orders, and the contradicting pair', async () => {
		await newTask('a');
		const status = await run('list', '--status', 'doing');
		const priority = await run('list', '--priority', 'critical');
		const order = await run('list', '--order', 'newest');
		const pair = await run('list', '--unassigned', '--available');

		expect(status.exitCode).toBe(1);
		expect(status.output).toContain('Valid statuses: backlog, in-progress, done');
		expect(priority.output).toContain('urgent, high, medium, low');
		expect(order.exitCode).toBe(1);
		expect(order.output).toContain('priority-then-oldest (plugins.ordering.default)');
		expect(pair.exitCode).toBe(1);
		expect(pair.output).toContain('unassigned and available cannot be combined');
	});

	it('refuses the new flags with --tree and --follow, naming the flag', async () => {
		for (const flag of [['--status', 'done'], ['--unassigned'], ['--limit', '3'], ['--fresh']]) {
			const tree = await run('list', '--tree', ...flag);
			expect(tree.exitCode).toBe(1);
			expect(tree.output).toContain(`${flag[0]} cannot be combined with --tree`);
		}
		const follow = await run('list', '--follow', '--order', 'priority-then-oldest');
		expect(follow.exitCode).toBe(1);
		expect(follow.output).toContain('--order cannot be combined with --follow');
	});

	it('refuses the new flags with --all-projects in the shape of the existing conflicts', async () => {
		for (const flag of [
			['--status', 'done'],
			['--assignee', 'w1'],
			['--available'],
			['--order', 'x'],
			['--fresh'],
		]) {
			const result = await run('list', '--all-projects', ...flag);
			expect(result.exitCode, flag.join(' ')).toBe(1);
			expect(result.output).toContain(`--all-projects cannot be combined with ${flag[0]}: `);
		}
	});
});

describe('task next', () => {
	it('claims the most urgent task and prints what claim prints', async () => {
		await newTask('low', 'low');
		const urgent = await newTask('urgent', 'urgent');

		const text = await run('next', '--as', 'w1', '--lease', '5m');

		expect(text.exitCode, text.output).toBe(0);
		expect(text.output).toMatch(new RegExp(`^claimed ${urgent} as w1 until \\S+Z \\(5m\\)$`));
		const next = json(await run('next', '--as', 'w2', '--json'));
		expect(next).toMatchObject({ outcome: 'claimed', assignee: 'w2' });
		expect(next.taskId).not.toBe(urgent);
		expect(typeof next.revision).toBe('string');
	});

	it('TASK_WORKER stands in for --as; --status and --priority narrow the candidates', async () => {
		await newTask('a', 'high');
		const wanted = await newTask('b', 'low');
		vi.stubEnv('TASK_WORKER', 'env-worker');

		const result = json(await run('next', '--priority', 'low', '--json'));

		expect(result).toMatchObject({ taskId: wanted, assignee: 'env-worker' });
	});

	it('answers "no available task" with exit 0, and {"task": null} with --json', async () => {
		const id = await newTask('only');
		await run('claim', id, '--as', 'w9');

		const text = await run('next', '--as', 'w1');
		const asJson = await run('next', '--as', 'w1', '--json');

		expect(text).toEqual({ exitCode: 0, output: 'no available task' });
		expect(asJson.exitCode).toBe(0);
		expect(json(asJson)).toEqual({ task: null, lost: 0, skippedBlocked: 0 });
	});

	it('never offers a terminal task by default, and --status can ask for one', async () => {
		const id = await newTask('finished');
		await run('set-status', id, 'done');

		expect((await run('next', '--as', 'w1')).output).toBe('no available task');
		// A terminal task cannot be claimed: the claim says so, nothing is written.
		const closed = await run('next', '--as', 'w1', '--status', 'done');
		expect(closed.exitCode).toBe(1);
	});

	it('needs a worker name, and rejects bad flags and values', async () => {
		for (const [args, text] of [
			[['next'], 'who is claiming?'],
			[['next', '--as'], '--as requires a value'],
			[['next', '--as', '--fresh'], '--as requires a value'],
			[['next', '--as', 'w1', '--lease', '5'], 'is not a duration'],
			[['next', '--as', 'w1', '--lease'], '--lease requires a value'],
			[['next', '--as', 'w1', '--unassigned'], 'unknown flag: --unassigned'],
			[['next', '--as', 'w1', 'extra'], 'unexpected argument: extra'],
			[['next', '--as', 'w1', '--order', 'newest'], 'unknown ordering plugin "newest"'],
			[['next', '--as', 'w1', '--status', 'doing'], 'unknown status "doing"'],
		] as const) {
			const result = await run(...args);
			expect(result.exitCode, args.join(' ')).toBe(1);
			expect(result.output, args.join(' ')).toContain(text);
		}
	});

	it('is listed in the help and in the valid commands', async () => {
		const help = await run('--help');
		expect(help.output).toContain('task next --as <name>');
		expect(help.output).toContain('task list [--status a,b]');
		expect((await run('nope')).output).toContain('claim, release, next, find');
	});

	it('rejects a repeated flag, naming it', async () => {
		for (const [args, flag] of [
			[['list', '--status', 'a', '--status', 'b'], '--status'],
			[['list', '--priority', 'low', '--priority', 'high'], '--priority'],
			[['list', '--order', 'priority-then-oldest', '--order', 'priority-then-oldest'], '--order'],
			[['list', '--assignee', 'a', '--assignee', 'b'], '--assignee'],
			[['list', '--limit', '1', '--limit', '2'], '--limit'],
			[['next', '--as', 'a', '--as', 'b'], '--as'],
			[['next', '--as', 'a', '--lease', '5m', '--lease', '6m'], '--lease'],
			[['next', '--as', 'a', '--status', 'backlog', '--status', 'done'], '--status'],
			[['next', '--as', 'a', '--priority', 'low', '--priority', 'high'], '--priority'],
			[['next', '--as', 'a', '--order', 'x', '--order', 'y'], '--order'],
		] as const) {
			const result = await run(...args);
			expect(result.exitCode, args.join(' ')).toBe(1);
			expect(result.output, args.join(' ')).toContain(`${flag} was given twice`);
		}
		// Boolean flags may repeat.
		expect((await run('list', '--unassigned', '--unassigned', '--fresh', '--fresh')).exitCode).toBe(0);
	});

	describe('a stored lease that is not a date', () => {
		it('adds leaseProblem to the row, warns once per task on stderr, and keeps the task out of --available', async () => {
			const bad = await newTask('bad');
			const free = await newTask('free');
			await run('claim', bad, '--as', 'w1');
			const indexFile = path.join(dataDir, 'task-index.json');
			fs.writeFileSync(
				indexFile,
				fs.readFileSync(indexFile, 'utf8').replace(/"leaseUntil": "[^"]*"/, '"leaseUntil": "soon"')
			);
			const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
			let warnings: string[];
			let result: CommandResult;
			try {
				result = await run('list', '--assignee', 'w1');
				warnings = write.mock.calls.map(call => String(call[0]));
			} finally {
				write.mockRestore();
			}

			expect(json<Array<{ leaseProblem: string }>>(result)[0]!.leaseProblem).toBe(
				'leaseUntil soon is not a valid date'
			);
			expect(warnings).toEqual([
				`warning: task ${bad}: leaseUntil soon is not a valid date; fix with: task release ${bad} --force
`,
			]);
			expect(json<Array<{ id: string }>>(await run('list', '--available')).map(row => row.id)).toEqual([free]);
		});
	});
});

describe('task next and blocked work', () => {
	it('skips a task with an open blocker, reports skippedBlocked, and --include-blocked opts out', async () => {
		const blocker = await newTask('blocker', 'low');
		const blocked = await newTask('blocked', 'urgent');
		expect((await run('link', blocked, 'blockedBy', blocker)).exitCode).toBe(0);

		const skipped = json(await run('next', '--as', 'w1', '--json'));
		expect(skipped).toMatchObject({ taskId: blocker, skippedBlocked: 1 });
		await run('release', blocker);
		const included = json(await run('next', '--as', 'w1', '--include-blocked', '--json'));
		expect(included.taskId).toBe(blocked);
		expect(included.skippedBlocked).toBe(0);
	});

	it('claim output keeps its old keys (no skippedBlocked) for the plain claim command', async () => {
		const id = await newTask('x');
		expect(json(await run('claim', id, '--as', 'w1', '--json'))).not.toHaveProperty('skippedBlocked');
	});

	it('does not confuse a lost race with an empty queue', () => {
		expect(describeNoTask(0, 0, false)).toEqual({ exitCode: 0, output: 'no available task' });
		expect(describeNoTask(2, 0, false).output).toBe(
			'no available task: 2 candidate(s) were claimed by other workers meanwhile, retry'
		);
		expect(JSON.parse(describeNoTask(2, 1, true).output)).toEqual({ task: null, lost: 2, skippedBlocked: 1 });
	});
});
