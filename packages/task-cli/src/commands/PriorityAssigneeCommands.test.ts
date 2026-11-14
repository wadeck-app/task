import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTaskCommand } from '../TaskIndex.js';
import { taskHelp } from '../cli/help.js';
import type { CommandResult } from '../cli/output.js';
import { registerTestProject } from '../testHelpers.js';

// task set-priority, unset-priority, set-assignee, unset-assignee, claim, release and the lease fields of show.

let root: string;
let dir: string;

beforeEach(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-fields-cmd-'));
	dir = path.join(root, 'work');
	await registerTestProject(dir);
	vi.stubEnv('TASK_WORKER', '');
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

const run = (...args: string[]): Promise<CommandResult> => runTaskCommand(args, dir);
const json = <T = Record<string, any>>(result: CommandResult): T => JSON.parse(result.output) as T;

async function newTask(title = 'Task'): Promise<string> {
	const result = await run('new', title);
	expect(result.exitCode, result.output).toBe(0);
	return json<{ id: string }>(result).id;
}

describe('task set-priority / unset-priority', () => {
	it('sets a priority of the project scale through a prefix and prints the task', async () => {
		const id = await newTask();

		const result = await run('set-priority', id.slice(0, 4), 'high');

		expect(result.exitCode, result.output).toBe(0);
		expect(json(result)).toMatchObject({ id, priority: 'high', description: 'Task' });
		expect(json(result)).not.toHaveProperty('revision');
		expect(json(await run('show', id))).toMatchObject({ priority: 'high' });
	});

	it('refuses a priority outside the scale naming the valid ones, exit 1, and JSON {error, hint}', async () => {
		const id = await newTask();

		const text = await run('set-priority', id, 'whenever');
		const asJson = await run('set-priority', id, 'whenever', '--json');

		expect(text.exitCode).toBe(1);
		expect(text.output).toContain('urgent');
		expect(json(asJson)).toHaveProperty('error');
		expect(json(await run('show', id))).not.toHaveProperty('priority');
	});

	it('needs an id and a priority', async () => {
		const result = await run('set-priority', 'abc');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('Usage: task set-priority <id> <priority>');
	});

	it('unset-priority clears it; an unknown flag fails', async () => {
		const id = await newTask();
		await run('set-priority', id, 'low');

		const cleared = await run('unset-priority', id);

		expect(cleared.exitCode, cleared.output).toBe(0);
		expect(json(cleared)).not.toHaveProperty('priority');
		const bad = await run('unset-priority', id, '--bogus');
		expect(bad.exitCode).toBe(1);
		expect(bad.output).toContain('Usage: task unset-priority <id>');
	});
});

describe('task set-assignee / unset-assignee', () => {
	it('joins the words of the name with a space', async () => {
		const id = await newTask();

		const result = await run('set-assignee', id, 'Ada', 'Lovelace');

		expect(result.exitCode, result.output).toBe(0);
		expect(json(result)).toMatchObject({ id, assignee: 'Ada Lovelace' });
	});

	it('accepts a name starting with -- after a --', async () => {
		const id = await newTask();

		const result = await run('set-assignee', id, '--', '--odd');

		expect(json(result).assignee).toBe('--odd');
	});

	it('needs a name and refuses an unknown flag', async () => {
		const id = await newTask();

		expect((await run('set-assignee', id)).output).toContain('Usage: task set-assignee <id> <name...>');
		const bad = await run('set-assignee', id, 'bob', '--as', 'x');
		expect(bad.exitCode).toBe(1);
		expect(bad.output).toContain('unknown flag: --as');
	});

	it('unset-assignee removes the assignee', async () => {
		const id = await newTask();
		await run('set-assignee', id, 'bob');

		const result = await run('unset-assignee', id);

		expect(result.exitCode, result.output).toBe(0);
		expect(json(result)).not.toHaveProperty('assignee');
	});
});

describe('task claim', () => {
	it('--as is required unless TASK_WORKER is set; the error says both', async () => {
		const id = await newTask();

		const missing = await run('claim', id);
		const blank = await run('claim', id, '--as', '  ');

		expect(missing.exitCode).toBe(1);
		expect(missing.output).toContain('--as');
		expect(missing.output).toContain('TASK_WORKER');
		expect(blank.exitCode).toBe(1);
		expect(json(await run('show', id))).not.toHaveProperty('assignee');
	});

	it('prints one line with the lease length (project default 30m) and takes the name from TASK_WORKER', async () => {
		const id = await newTask();
		vi.stubEnv('TASK_WORKER', 'worker-7');

		const result = await run('claim', id);

		expect(result.exitCode, result.output).toBe(0);
		expect(result.output).toMatch(new RegExp(`^claimed ${id} as worker-7 until \\S+Z \\(30m\\)$`));
		expect(json(await run('show', id)).assignee).toBe('worker-7');
	});

	it('--as wins over TASK_WORKER; --lease accepts m, h and d and converts to minutes', async () => {
		const id = await newTask();
		vi.stubEnv('TASK_WORKER', 'from-env');

		const result = await run('claim', id, '--as', 'explicit', '--lease', '2h', '--json');

		const body = json(result);
		expect(result.exitCode, result.output).toBe(0);
		expect(body.assignee).toBe('explicit');
		expect(Date.parse(body.leaseUntil) - Date.parse(body.claimedAt)).toBeGreaterThanOrEqual(120 * 60_000 - 5000);
		expect(Date.parse(body.leaseUntil) - Date.parse(body.claimedAt)).toBeLessThanOrEqual(120 * 60_000 + 5000);
		const days = await run('claim', id, '--as', 'explicit', '--renew', '--lease', '1d', '--json');
		expect(Date.parse(json(days).leaseUntil) - Date.now()).toBeGreaterThan(23 * 3600_000);
	});

	it.each(['30', '30s', '1.5h', 'h', '-5m', '30 m', '0m', '8d', '1w', ''])(
		'rejects the lease %j loudly with the grammar',
		async lease => {
			const id = await newTask();

			const result = await run('claim', id, '--as', 'bob', '--lease', lease);

			expect(result.exitCode).toBe(1);
			expect(result.output).toMatch(/--lease/);
			expect(result.output).toMatch(/30m, 2h, 1d|<n>m|m, h or d/);
			expect(json(await run('show', id))).not.toHaveProperty('assignee');
		}
	);

	it('--lease without a value fails', async () => {
		const id = await newTask();

		const result = await run('claim', id, '--as', 'bob', '--lease');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('--lease requires');
	});

	it.each([
		['--as', ['claim', '--as', '--renew']],
		['--as', ['claim', '--as', '-x']],
		['--lease', ['claim', '--as', 'bob', '--lease', '--force']],
		['--as', ['release', '--as', '--force']],
	])(
		'%s followed by an option is refused naming the flag, with the usage, and writes nothing',
		async (flag, args) => {
			const id = await newTask();
			vi.stubEnv('TASK_WORKER', 'from-env');
			const [command, ...options] = args as [string, ...string[]];

			const result = await run(command, id, ...options);

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`${flag} requires a value`);
			expect(result.output).toContain('Usage: task');
			expect(json(await run('show', id))).not.toHaveProperty('assignee');
		}
	);

	it('the same refusal in --json mode keeps the {error, hint} shape', async () => {
		const id = await newTask();

		const result = await run('claim', id, '--as', '--renew', '--json');

		expect(result.exitCode).toBe(1);
		expect(json(result)).toMatchObject({ error: expect.stringContaining('--as requires a value') });
		expect(json(result).hint).toContain('Usage: task claim');
	});

	it('--json carries taskId, outcome, assignee, claimedAt, leaseUntil, revision and the task', async () => {
		const id = await newTask();

		const result = await run('claim', id, '--as', 'bob', '--json');

		const body = json(result);
		expect(Object.keys(body).sort()).toEqual(
			['assignee', 'claimedAt', 'leaseUntil', 'outcome', 'revision', 'task', 'taskId'].sort()
		);
		expect(body).toMatchObject({ taskId: id, outcome: 'claimed', assignee: 'bob' });
		expect(typeof body.revision).toBe('string');
		expect(body.task).toMatchObject({ id, assignee: 'bob', revision: body.revision, description: 'Task' });
		expect(body.task.leaseUntil).toBe(body.leaseUntil);
	});

	it('another worker on a live lease is a conflict with the holder and the time left; --force takes over', async () => {
		const id = await newTask();
		await run('claim', id, '--as', 'w1', '--lease', '1m');

		const refused = await run('claim', id, '--as', 'w2');
		const refusedJson = await run('claim', id, '--as', 'w2', '--json');
		const forced = await run('claim', id, '--as', 'w2', '--force');
		const forcedJson = await run('claim', id, '--as', 'w3', '--force', '--json');

		expect(refused.exitCode).toBe(1);
		expect(refused.output).toContain('claimed by "w1"');
		expect(refused.output).toContain('--force');
		expect(refusedJson.exitCode).toBe(1);
		expect(json(refusedJson)).toMatchObject({ error: expect.stringContaining('w1'), hint: expect.any(String) });
		expect(forced.exitCode, forced.output).toBe(0);
		expect(forced.output).toMatch(new RegExp(`^took over ${id} from w1 as w2 until \\S+Z \\(30m\\)$`));
		expect(json(forcedJson)).toMatchObject({ outcome: 'takeover', previousAssignee: 'w2', assignee: 'w3' });
	});

	it('the same worker needs --renew, which extends the lease', async () => {
		const id = await newTask();
		const first = json(await run('claim', id, '--as', 'w1', '--lease', '1m', '--json'));

		const refused = await run('claim', id, '--as', 'w1');
		const renewed = await run('claim', id, '--as', 'w1', '--renew', '--lease', '10m');
		const renewedJson = json(await run('claim', id, '--as', 'w1', '--renew', '--json'));

		expect(refused.exitCode).toBe(1);
		expect(refused.output).toContain('--renew');
		expect(renewed.output).toMatch(new RegExp(`^renewed ${id} as w1 until \\S+Z \\(10m\\)$`));
		expect(renewedJson.outcome).toBe('renewed');
		expect(renewedJson.claimedAt).toBe(first.claimedAt);
		expect(renewedJson).not.toHaveProperty('previousAssignee');
	});

	it('an expired lease can be taken by another worker without --force and is recorded as a takeover', async () => {
		const id = await newTask();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-11-14T10:00:00.000Z'));
		await run('claim', id, '--as', 'w1', '--lease', '1m');
		vi.setSystemTime(new Date('2026-11-14T10:05:00.000Z'));

		const taken = await run('claim', id, '--as', 'w2');

		expect(taken.exitCode, taken.output).toBe(0);
		expect(taken.output).toBe(`took over ${id} from w1 as w2 until 2026-11-14T10:35:00.000Z (30m)`);
	});

	it('needs an id and refuses unknown flags and extra words', async () => {
		expect((await run('claim', '--as', 'bob')).output).toContain('Usage: task claim <id>');
		expect((await run('claim', 'a', 'b', '--as', 'bob')).output).toContain('unexpected argument: b');
		expect((await run('claim', 'a', '--as', 'bob', '--bogus')).output).toContain('unknown flag: --bogus');
	});
});

describe('task release', () => {
	it('prints who held the task and clears the fields', async () => {
		const id = await newTask();
		await run('claim', id, '--as', 'w1');

		const result = await run('release', id);

		expect(result.exitCode, result.output).toBe(0);
		expect(result.output).toBe(`released ${id} (was held by w1)`);
		const shown = json(await run('show', id));
		expect(shown).not.toHaveProperty('assignee');
		expect(shown).not.toHaveProperty('leaseUntil');
		expect(shown).not.toHaveProperty('leaseExpired');
	});

	it('--json prints {taskId, previousAssignee, task}', async () => {
		const id = await newTask();
		await run('claim', id, '--as', 'w1');

		const body = json(await run('release', id, '--json'));

		expect(Object.keys(body).sort()).toEqual(['previousAssignee', 'task', 'taskId']);
		expect(body).toMatchObject({ taskId: id, previousAssignee: 'w1' });
		expect(body.task).not.toHaveProperty('assignee');
	});

	it('--as w2 on a task held by w1 is refused unless --force; a task nobody holds is a conflict with a hint', async () => {
		const id = await newTask();
		const nobody = await run('release', id);
		await run('claim', id, '--as', 'w1');

		const refused = await run('release', id, '--as', 'w2');
		const forced = await run('release', id, '--as', 'w2', '--force');

		expect(nobody.exitCode).toBe(1);
		expect(nobody.output).toContain('not claimed');
		expect(refused.exitCode).toBe(1);
		expect(refused.output).toContain('w1');
		expect(forced.output).toBe(`released ${id} (was held by w1)`);
	});

	it('TASK_WORKER is not read by release', async () => {
		const id = await newTask();
		await run('claim', id, '--as', 'w1');
		vi.stubEnv('TASK_WORKER', 'w2');

		const result = await run('release', id);

		expect(result.exitCode, result.output).toBe(0);
	});
});

describe('task show carries the fields', () => {
	it('priority, assignee, claimedAt, leaseUntil and leaseExpired appear only when set', async () => {
		const id = await newTask();
		const plain = json(await run('show', id));
		for (const key of ['priority', 'assignee', 'claimedAt', 'leaseUntil', 'leaseExpired']) {
			expect(plain).not.toHaveProperty(key);
		}
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-11-14T10:00:00.000Z'));
		await run('set-priority', id, 'urgent');
		await run('claim', id, '--as', 'w1', '--lease', '10m');

		const live = json(await run('show', id));
		vi.setSystemTime(new Date('2026-11-14T10:10:01.000Z'));
		const over = json(await run('show', id));

		expect(live).toMatchObject({
			priority: 'urgent',
			assignee: 'w1',
			claimedAt: '2026-11-14T10:00:00.000Z',
			leaseUntil: '2026-11-14T10:10:00.000Z',
			leaseExpired: false,
		});
		expect(over.leaseExpired).toBe(true);
	});

	it('a hand-made assignee has no lease and so no leaseExpired', async () => {
		const id = await newTask();
		await run('set-assignee', id, 'bob');

		const shown = json(await run('show', id));

		expect(shown.assignee).toBe('bob');
		expect(shown).not.toHaveProperty('leaseExpired');
	});
});

describe('help', () => {
	it('documents every new command, the lease grammar, TASK_WORKER and the new events', () => {
		const help = taskHelp();

		for (const text of [
			'task set-priority <id> <priority>',
			'task unset-priority <id>',
			'task set-assignee <id> <name...>',
			'task unset-assignee <id>',
			'task claim <id> --as <name>',
			'task release <id>',
			'--lease',
			'TASK_WORKER',
			'onTaskPriorityChanged',
			'onTaskAssigneeChanged',
		]) {
			expect(help, text).toContain(text);
		}
	});

	it('the unknown-command hint lists the new commands', async () => {
		const result = await run('bogus');

		for (const word of ['set-priority', 'unset-priority', 'set-assignee', 'unset-assignee', 'claim', 'release']) {
			expect(result.output, word).toContain(word);
		}
	});
});
