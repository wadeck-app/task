import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalBackend } from '@wadeck-app/task-core';
import { ownConfigFile, resolveProject } from '@wadeck-app/task-service';
import type { ResolvedProject } from '@wadeck-app/task-service';

import { type RegisteredTestProject, registerTestProject } from '../testHelpers.js';
import {
	isMigrateStrategy,
	isMigrateStrategyHelp,
	migrateStrategyHelp,
	runMigrateStrategy,
} from './MigrateStrategyCommands.js';
import type { LaunchRequest, MigrateStrategyDeps } from './MigrateStrategyCommands.js';

// `task strategy migrate`: start, status, pause, resume, log, and the hidden worker, over a project whose strategy is migrating (two
// strategies that store the tasks themselves). The launch of the worker process is a dependency, so no process is started here.
let tmpDir: string;
let project: RegisteredTestProject;
let resolved: ResolvedProject;
let launches: LaunchRequest[];
let out: string[];
let warnings: string[];

const MIGRATING = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
strategy:
    type: migrating
    options:
        current: { type: local }
        new: { type: local }
`;

const lockFile = (): string => path.join(project.storage.dataDir, 'migrating', 'worker.lock');

/** The worker a launch would have started: the lock of a live process (this one), as the real worker writes it. */
function pretendWorkerRuns(pid = process.pid): void {
	fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
	fs.writeFileSync(
		lockFile(),
		JSON.stringify({ pid, host: os.hostname(), startedAt: new Date().toISOString(), token: 'test' })
	);
}

function deps(extra: Partial<MigrateStrategyDeps> = {}): MigrateStrategyDeps {
	return {
		launch: request => {
			launches.push(request);
			pretendWorkerRuns();
			return Promise.resolve({});
		},
		out: text => void out.push(text),
		warn: text => void warnings.push(text),
		sleep: () => Promise.resolve(),
		workerStartTimeoutMs: 200,
		...extra,
	};
}

const run = (args: string[], extra: Partial<MigrateStrategyDeps> = {}, json = false) =>
	runMigrateStrategy(args, json, resolved, deps(extra));

async function seedTasks(): Promise<void> {
	const current = createLocalBackend(project.tasksDir);
	const parent = await current.create({ title: 'Parent', status: 'backlog' });
	const child = await current.create({ title: 'Child', status: 'in-progress', parentId: parent.id });
	await current.addLabel(child.id, 'x');
	await current.create({ title: 'Loose', status: 'backlog' });
}

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-migrating-'));
	project = await registerTestProject(path.join(tmpDir, 'shop'));
	fs.writeFileSync(ownConfigFile(project.storage), MIGRATING);
	resolved = resolveProject({ cwd: project.dir, projectRef: project.id });
	launches = [];
	out = [];
	warnings = [];
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('task strategy migrate: usage', () => {
	it('recognises the family, and its help, without a project', () => {
		expect(isMigrateStrategy(['migrate', 'status'])).toBe(true);
		expect(isMigrateStrategy(['show'])).toBe(false);
		for (const rest of [['migrate'], ['migrate', '--help'], ['migrate', 'help']]) {
			expect(isMigrateStrategyHelp(rest)).toBe(true);
		}
		expect(isMigrateStrategyHelp(['migrate', 'status'])).toBe(false);
	});

	it('the help lists every subcommand and says plainly which ones are not available yet', () => {
		const { exitCode, output } = migrateStrategyHelp();

		expect(exitCode).toBe(0);
		for (const sub of ['start', 'status', 'pause', 'resume', 'log'])
			expect(output).toContain(`task strategy migrate ${sub}`);
		expect(output).toMatch(/finalize\s+NOT AVAILABLE YET/);
		expect(output).toMatch(/abort\s+NOT AVAILABLE YET/);
		expect(output).toContain('worker');
		expect(output).toMatch(/internal/i);
	});

	it('an unknown subcommand lists the valid ones, in text and in json', async () => {
		const text = await run(['bogus']);
		expect(text.exitCode).toBe(1);
		expect(text.output).toContain('unknown task strategy migrate subcommand: bogus');
		expect(text.output).toContain('start, status, pause, resume, log');

		const json = await run(['bogus'], {}, true);
		expect(JSON.parse(json.output)).toMatchObject({ error: expect.stringContaining('bogus') as unknown });
	});

	it.each(['finalize', 'abort'])(
		'%s is not available yet: exit 1, saying which phase brings it and what to do meanwhile',
		async sub => {
			const result = await run([sub]);

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`task strategy migrate ${sub} is not available yet`);
			expect(result.output).toMatch(/phase P4/);
			expect(result.output).toContain('task strategy migrate pause');
		}
	);

	it('an unknown option or an extra argument is refused with the usage', async () => {
		const option = await run(['start', '--bogus']);
		expect(option.exitCode).toBe(1);
		expect(option.output).toContain('unknown option: --bogus');
		expect(option.output).toContain('Usage: task strategy migrate start');

		const extra = await run(['status', 'x']);
		expect(extra.exitCode).toBe(1);
		expect(extra.output).toContain('unexpected argument: x');

		const missing = await run(['start', '--allow-loss']);
		expect(missing.exitCode).toBe(1);
		expect(missing.output).toContain('--allow-loss needs a value');
	});
});

describe('task strategy migrate start', () => {
	it('--dry-run prints the plan and writes nothing: no state, no index, no worker', async () => {
		await seedTasks();

		const result = await run(['start', '--dry-run']);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('3 task(s) to move');
		expect(result.output).toMatch(/history\s+\d+ task\(s\)/);
		expect(result.output).toContain('BLOCKED');
		expect(result.output).toContain('--allow-loss');
		expect(fs.existsSync(path.join(project.storage.dataDir, 'migrating', 'state.json'))).toBe(false);
		expect(fs.existsSync(path.join(project.storage.dataDir, 'migrating', 'index.json'))).toBe(false);
		expect(launches).toEqual([]);
	});

	it('--dry-run --json answers the plan as data', async () => {
		await seedTasks();

		const result = await run(['start', '--dry-run', '--allow-loss', 'all'], {}, true);

		const plan = JSON.parse(result.output) as {
			dryRun: boolean;
			blocked: boolean;
			plan: { tasks: number; estimate: { requests: number } };
		};
		expect(plan).toMatchObject({ dryRun: true, started: false, blocked: false });
		expect(plan.plan.tasks).toBe(3);
		expect(plan.plan.estimate.requests).toBeGreaterThan(0);
	});

	it('refuses a plan that loses something nobody accepted, naming it, and starts nothing', async () => {
		await seedTasks();

		const result = await run(['start']);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('would lose');
		expect(result.output).toContain('history');
		expect(result.output).toContain('--allow-loss');
		expect(launches).toEqual([]);
		expect(fs.existsSync(path.join(project.storage.dataDir, 'migrating', 'state.json'))).toBe(false);
	});

	it('starts: routes every task, stores what was accepted, launches the worker and says so', async () => {
		await seedTasks();

		const result = await run(['start', '--allow-loss', 'all']);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('Migration started');
		expect(result.output).toContain('3 task(s)');
		expect(result.output).toContain('task strategy migrate status');
		expect(launches).toEqual([{ projectId: project.id, dataDir: project.storage.dataDir, cwd: project.dir }]);
		const state = JSON.parse(
			fs.readFileSync(path.join(project.storage.dataDir, 'migrating', 'state.json'), 'utf8')
		) as {
			status: string;
			acceptedLosses: string[];
		};
		expect(state).toMatchObject({ status: 'running', acceptedLosses: ['all'] });
	});

	it('--json carries the plan, the state and whether the worker runs', async () => {
		await seedTasks();

		const result = await run(['start', '--allow-loss', 'history,comments'], {}, true);

		const answer = JSON.parse(result.output) as {
			started: boolean;
			worker: { launched: boolean; running: boolean };
		};
		expect(answer.started).toBe(true);
		expect(answer.worker).toMatchObject({ launched: true, running: true });
	});

	it('says what to do when the worker does not appear: the migration is started, exit 1', async () => {
		await seedTasks();

		const result = await run(['start', '--allow-loss', 'all'], { launch: () => Promise.resolve({}) });

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('worker did not start');
		expect(result.output).toContain('worker.out.log');
		expect(result.output).toContain('task strategy migrate resume');
		expect(fs.existsSync(path.join(project.storage.dataDir, 'migrating', 'state.json'))).toBe(true);
	});

	it('says what to do when the launch itself fails: the migration is started, exit 1', async () => {
		await seedTasks();

		const result = await run(['start', '--allow-loss', 'all'], {
			launch: () => Promise.reject(new Error('cannot start the background worker: spawn ENOENT')),
		});

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('The migration was started, but its worker could not be launched');
		expect(result.output).toContain('ENOENT');
		expect(result.output).toContain('task strategy migrate resume');
	});

	it('a second start is refused and points to status', async () => {
		await seedTasks();
		await run(['start', '--allow-loss', 'all']);

		const again = await run(['start', '--allow-loss', 'all']);

		expect(again.exitCode).toBe(1);
		expect(again.output).toContain('already started');
		expect(again.output).toContain('task strategy migrate status');
		expect(launches).toHaveLength(1);
	});

	it('refuses a project whose strategy is not migrating, with the section to write', async () => {
		fs.writeFileSync(
			ownConfigFile(project.storage),
			'statuses:\n    - backlog\n    - { name: done, terminal: true }\n'
		);

		const result = await run(['start', '--dry-run']);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('not "migrating"');
		expect(result.output).toContain('type: migrating');
	});
});

describe('task strategy migrate status, pause, resume', () => {
	it('status of a project that never started says so and how to plan, exit 0', async () => {
		const result = await run(['status']);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('No migration was started');
		expect(result.output).toContain('task strategy migrate start --dry-run');
	});

	it('status shows the counts, the worker, the pace, the open work and the next action', async () => {
		await seedTasks();
		await run(['start', '--allow-loss', 'all']);

		const result = await run(['status']);

		expect(result.exitCode).toBe(0);
		expect(result.output).toMatch(/Migration:\s+running/);
		expect(result.output).toMatch(/Tasks:\s+0 of 3 moved \(0%\)/);
		expect(result.output).toMatch(/in current 3/);
		expect(result.output).toMatch(/Worker:\s+running, pid \d+/);
		expect(result.output).toMatch(/Next:/);
	});

	it('status --json is the report', async () => {
		await seedTasks();
		await run(['start', '--allow-loss', 'all']);

		const report = JSON.parse((await run(['status'], {}, true)).output) as {
			started: boolean;
			status: string;
			counts: { total: number; inCurrent: number };
			worker: { running: boolean };
		};

		expect(report).toMatchObject({
			started: true,
			status: 'running',
			counts: { total: 3, inCurrent: 3 },
			worker: { running: true },
		});
	});

	it('pause asks the live worker; resume cancels the request without a second worker', async () => {
		await seedTasks();
		await run(['start', '--allow-loss', 'all']);

		const pause = await run(['pause']);
		expect(pause.exitCode).toBe(0);
		expect(pause.output).toContain('Pause requested');
		expect(pause.output).toContain('task strategy migrate resume');

		const resume = await run(['resume']);
		expect(resume.exitCode).toBe(0);
		expect(resume.output).toContain('pause was cancelled');
		expect(launches).toHaveLength(1);
	});

	it('resume relaunches the worker of a migration whose worker is gone', async () => {
		await seedTasks();
		await run(['start', '--allow-loss', 'all']);
		fs.rmSync(lockFile());
		const paused = await run(['pause']);
		expect(paused.output).toContain('paused');

		const resumed = await run(['resume']);

		expect(resumed.exitCode).toBe(0);
		expect(resumed.output).toContain('Worker launched');
		expect(launches).toHaveLength(2);
	});

	it('pause and resume of a project that never started: exit 1 with the command to plan it', async () => {
		for (const sub of ['pause', 'resume']) {
			const result = await run([sub]);
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain('no migration was started');
			expect(result.output).toContain('task strategy migrate start');
		}
	});
});

describe('task strategy migrate log', () => {
	it('prints the last entries of the migration log, oldest first, and --json a list', async () => {
		await seedTasks();
		await run(['start', '--allow-loss', 'all']);

		const text = await run(['log']);
		expect(text.exitCode).toBe(0);
		expect(text.output).toContain('migration started');

		const json = JSON.parse((await run(['log'], {}, true)).output) as Array<{ message: string }>;
		expect(json.some(entry => entry.message.includes('migration started'))).toBe(true);
		const tail = JSON.parse((await run(['log', '--tail', '1'], {}, true)).output) as unknown[];
		expect(tail).toHaveLength(1);
	});

	it('says there is nothing yet when the log is empty', async () => {
		const result = await run(['log']);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('The migration log is empty');
	});

	it('--follow prints the last entries, then every line that is added, until the signal ends it', async () => {
		await seedTasks();
		await run(['start', '--allow-loss', 'all']);
		const controller = new AbortController();
		const log = path.join(project.storage.dataDir, 'migrating', 'log.ndjson');
		setTimeout(() => {
			fs.appendFileSync(
				log,
				`${JSON.stringify({ at: '2026-11-16T10:00:00.000Z', level: 'info', message: 'one more line' })}\n`
			);
		}, 40);
		setTimeout(() => controller.abort(), 250);

		const result = await run(['log', '--follow', '--tail', '1'], {
			signal: controller.signal,
			followIntervalMs: 10,
		});

		expect(result.exitCode).toBe(0);
		expect(out.join('\n')).toContain('one more line');
		expect(warnings.join('\n')).toContain('Following the migration log');
	});
});

describe('task strategy migrate worker (internal: what the background process runs)', () => {
	it('moves every task in this process and ends ready to finalize, exit 0', async () => {
		await seedTasks();
		await run(['start', '--allow-loss', 'all']);
		fs.rmSync(lockFile());

		const result = await run(['worker']);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('ready-to-finalize');
		expect(result.output).toContain('3 task(s) moved');
		const index = JSON.parse(
			fs.readFileSync(path.join(project.storage.dataDir, 'migrating', 'index.json'), 'utf8')
		) as {
			rows: Array<{ state: string }>;
		};
		expect(index.rows.map(row => row.state)).toEqual(['in-b', 'in-b', 'in-b']);
		const status = JSON.parse((await run(['status'], {}, true)).output) as {
			status: string;
			counts: { moved: number };
		};
		expect(status).toMatchObject({ status: 'ready-to-finalize', counts: { moved: 3 } });
	});

	it('is refused, with the command to run first, when no migration was started', async () => {
		const result = await run(['worker']);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('no migration was started');
		expect(result.output).toContain('task strategy migrate start');
	});

	it('refuses to run beside another worker, naming its pid', async () => {
		await seedTasks();
		await run(['start', '--allow-loss', 'all']);

		const result = await run(['worker']);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(`pid ${process.pid}`);
	});

	it('ends as a pause, exit 0, when its signal is aborted', async () => {
		await seedTasks();
		await run(['start', '--allow-loss', 'all']);
		fs.rmSync(lockFile());
		const controller = new AbortController();
		controller.abort();

		const result = await run(['worker'], { signal: controller.signal });

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('paused');
	});
});
