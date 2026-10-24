import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTaskCommand } from './TaskIndex.js';
import { registerTestProject } from './testHelpers.js';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-index-test-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runTaskCommand — version and help', () => {
	it('--version returns CalVer string without requiring project init', async () => {
		const result = await runTaskCommand(['--version'], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(result.output).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d{6}-\d+-[0-9a-zA-Z]+/);
	});

	it('-V returns CalVer string without requiring project init', async () => {
		const result = await runTaskCommand(['-V'], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(result.output).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d{6}-\d+-[0-9a-zA-Z]+/);
	});

	it('no args returns usage without requiring project init', async () => {
		const result = await runTaskCommand([], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('Usage:');
	});

	it('--help returns usage without requiring project init', async () => {
		const result = await runTaskCommand(['--help'], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('Usage:');
	});

	it('--help documents the queue events: names, when, cwd, failure behaviour and replay', async () => {
		const { output } = await runTaskCommand(['--help'], tmpDir);
		const events = output.slice(output.indexOf('Events ('));

		expect(output).toContain('Events (');
		for (const name of [
			'onTaskCreated',
			'onStatusChange',
			'onTaskLinked',
			'onTaskUnlinked',
			'onTaskUnblocked',
			'onTaskTypeChanged',
			'onTaskLabelAdded',
			'onTaskLabelRemoved',
			'onTaskMetaChanged',
			'onTaskParentChanged',
			'onTaskDeleted',
		]) {
			expect(events, name).toContain(name);
		}
		// The payload fields of the new events and the copy of newStatus are listed.
		for (const field of [
			'oldType',
			'newType',
			'oldValue',
			'newValue',
			'oldParentId',
			'newParentId',
			'orphanedChildIds',
			'removedLinkCount',
		]) {
			expect(events, field).toContain(field);
		}
		expect(events).toContain('status (= newStatus)');
		// Which commands fire what, and the deletion order.
		for (const command of [
			'set-type',
			'add-label',
			'remove-label',
			'set-meta',
			'set-parent',
			'remove-parent',
			'delete',
		]) {
			expect(events, command).toContain(command);
		}
		expect(events).toContain('leaves before parents');
		expect(events).toContain('taskProjectPath');
		expect(events).toContain('.queue/subscribers.yml');
		expect(events).toContain('task cli logs');
		expect(events).toContain('cd ');
		// Delivery goes through the queue SDK: the two outcomes with a doubt are explained.
		expect(events).toContain('@wadeck-app/queue-sdk');
		expect(events).toContain('MAY be recorded');
		expect(events).toContain('queue history');
		expect(events).toContain('queue replay');
	});

	it('--help explains that the events are declared to the queue, when, and how to force it', async () => {
		const { output } = await runTaskCommand(['--help'], tmpDir);
		const events = output.slice(output.indexOf('Events ('));

		expect(events).toContain('declared to the queue');
		expect(events).toContain('queue-events.json');
		expect(events).toContain('task cli declare-events');
		expect(events).toContain('queue events');
		// The usage list names the command too.
		expect(output.slice(0, output.indexOf('Events ('))).toContain('task cli declare-events');
	});
});

describe('runTaskCommand — project guard', () => {
	it('fails with human-readable message when project not initialized', async () => {
		const result = await runTaskCommand(['list'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('project add');
		expect(result.output).not.toMatch(/^\{/); // not JSON
	});

	it('--json flag returns JSON error', async () => {
		const result = await runTaskCommand(['--json', 'list'], tmpDir);
		expect(result.exitCode).toBe(1);
		const parsed = JSON.parse(result.output) as { error: string };
		expect(parsed.error).toContain('no project in scope');
	});

	it('list, new, show, set-status all need a project (a folder of a registered project)', async () => {
		const commands = [['list'], ['new', 'test task'], ['show', 'abc123'], ['set-status', 'abc123', 'done']];
		for (const cmd of commands) {
			const result = await runTaskCommand(cmd, tmpDir);
			expect(result.exitCode, `command "${cmd[0]}" should need a project`).toBe(1);
			expect(result.output).toContain('project add');
			expect(result.output).not.toContain('task init');
		}
	});

	it('approve is no longer a valid command', async () => {
		await registerTestProject(tmpDir);
		const result = await runTaskCommand(['approve', 'abc123'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('unknown command');
	});
});

describe('runTaskCommand — a registered project', () => {
	it('after the folder is registered, list succeeds', async () => {
		await registerTestProject(tmpDir);
		const result = await runTaskCommand(['list'], tmpDir);
		expect(result.exitCode).toBe(0);
	});
});

describe('runTaskCommand — prefix match', () => {
	beforeEach(async () => {
		await registerTestProject(tmpDir);
	});

	it('show accepts a full id', async () => {
		const created = await runTaskCommand(['new', 'prefix test'], tmpDir);
		const task = JSON.parse(created.output) as { id: string };
		const result = await runTaskCommand(['show', task.id], tmpDir);
		expect(result.exitCode).toBe(0);
		const shown = JSON.parse(result.output) as { id: string };
		expect(shown.id).toBe(task.id);
	});

	it('show accepts a prefix', async () => {
		const created = await runTaskCommand(['new', 'prefix test'], tmpDir);
		const task = JSON.parse(created.output) as { id: string };
		const prefix = task.id.slice(0, 3);
		const result = await runTaskCommand(['show', prefix], tmpDir);
		expect(result.exitCode).toBe(0);
		const shown = JSON.parse(result.output) as { id: string };
		expect(shown.id).toBe(task.id);
	});

	it('show fails with not found for unknown prefix', async () => {
		const result = await runTaskCommand(['show', 'zzzzz'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('not found');
	});

	it('set-status accepts a prefix', async () => {
		const created = await runTaskCommand(['new', 'status test'], tmpDir);
		const task = JSON.parse(created.output) as { id: string };
		const prefix = task.id.slice(0, 4);
		const result = await runTaskCommand(['set-status', prefix, 'in-progress'], tmpDir);
		expect(result.exitCode).toBe(0);
		const updated = JSON.parse(result.output) as { status: string };
		expect(updated.status).toBe('in-progress');
	});
});

describe('runTaskCommand — set-status error messages', () => {
	beforeEach(async () => {
		await registerTestProject(tmpDir);
	});

	it('shows human-readable error with Did you mean suggestion', async () => {
		const created = await runTaskCommand(['new', 'typo test'], tmpDir);
		const task = JSON.parse(created.output) as { id: string };
		const result = await runTaskCommand(['set-status', task.id, 'in-progres'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('unknown status');
		expect(result.output).toContain('Did you mean: in-progress');
	});

	it('--json returns structured error for invalid status', async () => {
		const created = await runTaskCommand(['new', 'json err test'], tmpDir);
		const task = JSON.parse(created.output) as { id: string };
		const result = await runTaskCommand(['--json', 'set-status', task.id, 'nope'], tmpDir);
		expect(result.exitCode).toBe(1);
		const parsed = JSON.parse(result.output) as { error: string; hint: string };
		// Same wording as the text mode: the message, and the hint line as its own key.
		expect(parsed).toEqual({
			error: 'unknown status "nope"',
			hint: 'Valid statuses: backlog, in-progress, done\nDid you mean: done?',
		});
	});

	it('--json keeps the "Did you mean" suggestion in the hint', async () => {
		const created = await runTaskCommand(['new', 'json typo'], tmpDir);
		const task = JSON.parse(created.output) as { id: string };
		const result = await runTaskCommand(['--json', 'set-status', task.id, 'in-progres'], tmpDir);
		expect((JSON.parse(result.output) as { hint: string }).hint).toContain('Did you mean: in-progress');
	});

	it('--json link with an unknown link type carries the valid types and the suggestion in the hint', async () => {
		const a = JSON.parse((await runTaskCommand(['new', 'a'], tmpDir)).output) as { id: string };
		const b = JSON.parse((await runTaskCommand(['new', 'b'], tmpDir)).output) as { id: string };
		const result = await runTaskCommand(['--json', 'link', a.id, 'blockedby', b.id], tmpDir);
		expect(result.exitCode).toBe(1);
		const parsed = JSON.parse(result.output) as { error: string; hint: string };
		expect(parsed.error).toContain('unknown link type');
		expect(parsed.hint).toContain('Valid types: ');
	});

	it('--json set-type with a type outside the configured list names the valid types in the error (the strategy puts them in the message, there is no separate hint)', async () => {
		await runTaskCommand(['type', 'add', 'bug'], tmpDir);
		const a = JSON.parse((await runTaskCommand(['new', 'a'], tmpDir)).output) as { id: string };
		const result = await runTaskCommand(['--json', 'set-type', a.id, 'bgu'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect((JSON.parse(result.output) as { error: string }).error).toBe('unknown type "bgu". Valid types: bug');
	});
});

describe('runTaskCommand — -p flag', () => {
	let projectDir: string;
	let projectName: string;

	beforeEach(async () => {
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-project-flag-test-'));
		projectName = (await registerTestProject(projectDir)).name;
	});

	afterEach(() => {
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	it('-p loads the project of the registry, not the one of the cwd (tmpDir is in no registered project)', async () => {
		const created = await runTaskCommand(['new', 'project flag task'], projectDir);
		const task = JSON.parse(created.output) as { id: string };

		const result = await runTaskCommand(['show', task.id, '-p', projectName], tmpDir);
		expect(result.exitCode).toBe(0);
		const shown = JSON.parse(result.output) as { id: string };
		expect(shown.id).toBe(task.id);
	});

	it('absent -p falls back to cwd (existing behavior unchanged)', async () => {
		const created = await runTaskCommand(['new', 'cwd fallback task'], projectDir);
		const task = JSON.parse(created.output) as { id: string };

		const result = await runTaskCommand(['show', task.id], projectDir);
		expect(result.exitCode).toBe(0);
	});

	it('-p is filtered from args passed to the command', async () => {
		// set-status with -p should not confuse the command's arg parsing
		const created = await runTaskCommand(['new', 'filter test'], projectDir);
		const task = JSON.parse(created.output) as { id: string };

		const result = await runTaskCommand(['set-status', task.id, 'done', '-p', projectName], tmpDir);
		expect(result.exitCode).toBe(0);
		const updated = JSON.parse(result.output) as { status: string };
		expect(updated.status).toBe('done');
	});
});

describe('runTaskCommand — delete', () => {
	beforeEach(async () => {
		await registerTestProject(tmpDir);
	});

	it('deletes a task by full id', async () => {
		const created = await runTaskCommand(['new', 'task to delete'], tmpDir);
		const task = JSON.parse(created.output) as { id: string };

		const result = await runTaskCommand(['delete', task.id], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('Deleted 1 task(s).');

		const listResult = await runTaskCommand(['list'], tmpDir);
		const tasks = JSON.parse(listResult.output) as unknown[];
		expect(tasks).toHaveLength(0);
	});

	it('deletes a task by id prefix', async () => {
		const created = await runTaskCommand(['new', 'prefix delete'], tmpDir);
		const task = JSON.parse(created.output) as { id: string };
		const prefix = task.id.slice(0, 4);

		const result = await runTaskCommand(['delete', prefix], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('Deleted 1 task(s).');
	});

	it('deletes multiple tasks by comma-separated ids', async () => {
		const a = JSON.parse((await runTaskCommand(['new', 'task A'], tmpDir)).output) as { id: string };
		const b = JSON.parse((await runTaskCommand(['new', 'task B'], tmpDir)).output) as { id: string };
		await runTaskCommand(['new', 'task C'], tmpDir);

		const result = await runTaskCommand(['delete', `${a.id},${b.id}`], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('Deleted 2 task(s).');

		const listResult = await runTaskCommand(['list'], tmpDir);
		const tasks = JSON.parse(listResult.output) as Array<{ title: string }>;
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.title).toBe('task C');
	});

	it('warns but continues when deleting a non-existent id', async () => {
		await runTaskCommand(['new', 'real task'], tmpDir);

		const result = await runTaskCommand(['delete', 'zzzzzzzz'], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('Nothing to delete.');
	});

	it('deletes all tasks with --all', async () => {
		await runTaskCommand(['new', 'alpha'], tmpDir);
		await runTaskCommand(['new', 'beta'], tmpDir);
		await runTaskCommand(['new', 'gamma'], tmpDir);

		const result = await runTaskCommand(['delete', '--all'], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('Deleted 3 task(s).');

		const listResult = await runTaskCommand(['list'], tmpDir);
		const tasks = JSON.parse(listResult.output) as unknown[];
		expect(tasks).toHaveLength(0);
	});

	it('--all on empty store returns Nothing to delete', async () => {
		const result = await runTaskCommand(['delete', '--all'], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe('Nothing to delete.');
	});

	it('deletes tasks by status filter', async () => {
		const t1 = JSON.parse((await runTaskCommand(['new', 'done task'], tmpDir)).output) as { id: string };
		await runTaskCommand(['set-status', t1.id, 'done'], tmpDir);
		await runTaskCommand(['new', 'active task'], tmpDir);

		const result = await runTaskCommand(['delete', '--filter', 'status=done'], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('Deleted 1 task(s).');

		const listResult = await runTaskCommand(['list'], tmpDir);
		const tasks = JSON.parse(listResult.output) as Array<{ title: string }>;
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.title).toBe('active task');
	});

	it('deletes tasks matching multiple status values', async () => {
		const t1 = JSON.parse((await runTaskCommand(['new', 'done task'], tmpDir)).output) as { id: string };
		await runTaskCommand(['set-status', t1.id, 'done'], tmpDir);
		const t2 = JSON.parse((await runTaskCommand(['new', 'in-progress task'], tmpDir)).output) as { id: string };
		await runTaskCommand(['set-status', t2.id, 'in-progress'], tmpDir);
		await runTaskCommand(['new', 'created task'], tmpDir);

		const result = await runTaskCommand(['delete', '--filter', 'status=done,in-progress'], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('Deleted 2 task(s).');
	});

	it('deletes tasks matching title glob', async () => {
		await runTaskCommand(['new', 'hello world'], tmpDir);
		await runTaskCommand(['new', 'hello there'], tmpDir);
		await runTaskCommand(['new', 'goodbye'], tmpDir);

		const result = await runTaskCommand(['delete', '--filter', 'title=hello*'], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('Deleted 2 task(s).');

		const listResult = await runTaskCommand(['list'], tmpDir);
		const tasks = JSON.parse(listResult.output) as Array<{ title: string }>;
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.title).toBe('goodbye');
	});

	it('--dry-run shows tasks without deleting', async () => {
		await runTaskCommand(['new', 'dry run target'], tmpDir);
		const t2 = JSON.parse((await runTaskCommand(['new', 'another task'], tmpDir)).output) as { id: string };
		await runTaskCommand(['set-status', t2.id, 'done'], tmpDir);

		const result = await runTaskCommand(['delete', '--filter', 'status=done', '--dry-run'], tmpDir);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('Would delete:');
		expect(result.output).toContain('[done]');

		// Tasks must still exist (--all needed: one of them is 'done', a terminal status hidden by default)
		const listResult = await runTaskCommand(['list', '--all'], tmpDir);
		const tasks = JSON.parse(listResult.output) as unknown[];
		expect(tasks).toHaveLength(2);
	});

	it('--dry-run counts a task once when it is given twice (full id and prefix)', async () => {
		const created = JSON.parse((await runTaskCommand(['new', 'given twice'], tmpDir)).output) as { id: string };

		const result = await runTaskCommand(['delete', '--dry-run', created.id, created.id.slice(0, 5)], tmpDir);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('Total: 1 task(s).');
		expect(result.output.match(new RegExp(created.id, 'g'))).toHaveLength(1);
	});

	it('errors when --all and --filter are combined', async () => {
		const result = await runTaskCommand(['delete', '--all', '--filter', 'status=done'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('--all and --filter cannot be combined');
	});

	it('errors when positional IDs and --all are combined', async () => {
		const created = JSON.parse((await runTaskCommand(['new', 'task'], tmpDir)).output) as { id: string };
		const result = await runTaskCommand(['delete', created.id, '--all'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('cannot be combined');
	});

	it('errors when positional IDs and --filter are combined', async () => {
		const created = JSON.parse((await runTaskCommand(['new', 'task'], tmpDir)).output) as { id: string };
		const result = await runTaskCommand(['delete', created.id, '--filter', 'status=done'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('cannot be combined');
	});

	it('errors on unknown filter field', async () => {
		const result = await runTaskCommand(['delete', '--filter', 'priority=high'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('unknown filter field');
		expect(result.output).toContain('id, title, status');
	});

	it('errors with missing arguments when no selector given', async () => {
		const result = await runTaskCommand(['delete'], tmpDir);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('missing arguments');
	});

	it('requires project initialization', async () => {
		const uninitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-delete-uninit-'));
		try {
			const result = await runTaskCommand(['delete', 'abc123'], uninitDir);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain('project add');
		} finally {
			fs.rmSync(uninitDir, { recursive: true, force: true });
		}
	});

	it('--json returns JSON error for unknown filter field', async () => {
		const result = await runTaskCommand(['--json', 'delete', '--filter', 'unknown=foo'], tmpDir);
		expect(result.exitCode).toBe(1);
		const parsed = JSON.parse(result.output) as { error: string };
		expect(parsed.error).toContain('unknown filter field');
	});
});

describe('runTaskCommand — list hides terminal statuses by default', () => {
	beforeEach(async () => {
		await registerTestProject(tmpDir);
	});

	it('list omits tasks in a terminal status (done) unless --all is passed', async () => {
		const t1 = JSON.parse((await runTaskCommand(['new', 'done task'], tmpDir)).output) as { id: string };
		await runTaskCommand(['set-status', t1.id, 'done'], tmpDir);
		await runTaskCommand(['new', 'active task'], tmpDir);

		const defaultList = JSON.parse((await runTaskCommand(['list'], tmpDir)).output) as Array<{ title: string }>;
		expect(defaultList).toHaveLength(1);
		expect(defaultList[0]!.title).toBe('active task');

		const fullList = JSON.parse((await runTaskCommand(['list', '--all'], tmpDir)).output) as unknown[];
		expect(fullList).toHaveLength(2);
	});

	it('new tasks start in the configured default status (backlog)', async () => {
		const created = JSON.parse((await runTaskCommand(['new', 'fresh task'], tmpDir)).output) as { status: string };
		expect(created.status).toBe('backlog');
	});
});

describe('runTaskCommand — TASK_PROJECT env var', () => {
	let projectDir: string;
	let projectName: string;
	const origEnv = process.env;

	beforeEach(async () => {
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-env-dir-test-'));
		process.env = { ...origEnv };
		delete process.env['TASK_PROJECT'];
		projectName = (await registerTestProject(projectDir)).name;
	});

	afterEach(() => {
		process.env = origEnv;
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	it('TASK_PROJECT is used when no -p flag', async () => {
		const created = await runTaskCommand(['new', 'env task'], projectDir);
		const task = JSON.parse(created.output) as { id: string };

		process.env['TASK_PROJECT'] = projectName;
		const result = await runTaskCommand(['show', task.id], tmpDir);
		expect(result.exitCode).toBe(0);
		const shown = JSON.parse(result.output) as { id: string };
		expect(shown.id).toBe(task.id);
	});

	it('-p takes precedence over TASK_PROJECT', async () => {
		const created = await runTaskCommand(['new', 'flag wins task'], projectDir);
		const task = JSON.parse(created.output) as { id: string };

		process.env['TASK_PROJECT'] = 'no-such-project';
		const result = await runTaskCommand(['show', task.id, '-p', projectName], tmpDir);
		expect(result.exitCode).toBe(0);
		const shown = JSON.parse(result.output) as { id: string };
		expect(shown.id).toBe(task.id);
	});

	it('no env var and no flag falls back to cwd', async () => {
		const created = await runTaskCommand(['new', 'no env task'], projectDir);
		const task = JSON.parse(created.output) as { id: string };

		const result = await runTaskCommand(['show', task.id], projectDir);
		expect(result.exitCode).toBe(0);
	});
});
