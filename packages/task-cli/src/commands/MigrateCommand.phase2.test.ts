// task migrate, phase 2: --only-open, --status, --ids, --limit, --comments (parsing, refusals, printing, the in-place partial run).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ownConfigFile } from '@wadeck-app/task-service';
import type { MigrationResult } from '@wadeck-app/task-service';
import { FakeGitHub } from '@wadeck-app/task-service/fakeGitHub';

import { runTaskCommand } from '../TaskIndex.js';
import { commandLine, formatMigration, migrationExitCode, parseMigrateArgs } from './MigrateCommand.js';
import type { ParsedMigrate } from './MigrateCommand.js';
import { type RegisteredTestProject, registerTestProject } from '../testHelpers.js';

const delivered = vi.hoisted(() => [] as unknown[]);
vi.mock('@wadeck-app/task-service', async importOriginal => {
	const actual = await importOriginal<typeof import('@wadeck-app/task-service')>();
	return {
		...actual,
		createQueueEventSink: (): import('@wadeck-app/task-service').QueueEventSink => ({
			deliver: event => {
				delivered.push(event);
				return Promise.resolve({ delivered: true });
			},
			declareEvents: () => Promise.resolve({ status: 'dropped', reason: 'faked by the test' }),
			flush: () => Promise.resolve(),
		}),
	};
});

const BASE = ['--from', 'a', '--to', 'b'];

function parsed(...args: string[]): ParsedMigrate {
	const result = parseMigrateArgs([...BASE, ...args], false);
	if ('exitCode' in result) throw new Error(`expected a parse, got: ${result.output}`);
	return result;
}

function refused(args: string[], jsonMode = false): { exitCode: number; output: string } {
	const result = parseMigrateArgs(args, jsonMode);
	if (!('exitCode' in result)) throw new Error(`expected a refusal for: ${args.join(' ')}`);
	return result;
}

describe('task migrate: the selection and comments flags', () => {
	it('--only-open, --status, --ids, --limit and --comments are read, in both forms of migrate', () => {
		expect(parsed('--only-open').options.selection).toEqual({ onlyOpen: true });
		expect(parsed('--status', 'backlog,in-progress').options.selection).toEqual({
			statuses: ['backlog', 'in-progress'],
		});
		expect(parsed('--status=done').options.selection).toEqual({ statuses: ['done'] });
		expect(parsed('--limit', '25').options.selection).toEqual({ limit: 25 });
		expect(parsed('--ids', 'ab12cd34,ef56ab78').options.selection).toEqual({ ids: ['ab12cd34', 'ef56ab78'] });
		expect(parsed('--only-open', '--limit', '5', '--ids', 'x').options.selection).toEqual({
			onlyOpen: true,
			limit: 5,
			ids: ['x'],
		});
		expect(parsed('--comments', 'digest').options.comments).toBe('digest');
		expect(parsed('--comments=none').options.comments).toBe('none');
		const inPlace = parseMigrateArgs(['--in-place', '--to-config', 'd.yml', '--only-open', '--limit', '3'], false);
		expect('exitCode' in inPlace).toBe(false);
		expect((inPlace as ParsedMigrate).options.selection).toEqual({ onlyOpen: true, limit: 3 });
	});

	it('without them nothing changes: no selection, no comments mode', () => {
		const { options } = parsed();

		expect(options.selection).toBeUndefined();
		expect(options.comments).toBeUndefined();
	});

	it.each<[string, string[], RegExp]>([
		['--only-open with --status', ['--only-open', '--status', 'done'], /--only-open and --status/],
		['--only-open with --status=', ['--status=done', '--only-open'], /--only-open and --status/],
		['--limit 0', ['--limit', '0'], /--limit "0" is not a whole number from 1 to 1000/],
		['--limit 1001', ['--limit', '1001'], /from 1 to 1000/],
		['--limit abc', ['--limit', 'abc'], /--limit "abc"/],
		['--limit 1.5', ['--limit', '1.5'], /--limit "1.5"/],
		['--limit -1', ['--limit', '-1'], /--limit "-1" is not a whole number/],
		['--limit without a value', ['--limit'], /--limit needs a whole number/],
		['--limit before another option', ['--limit', '--dry-run'], /--limit needs a whole number/],
		['--limit twice', ['--limit', '1', '--limit', '2'], /--limit is given twice/],
		['--status without a value', ['--status'], /--status needs/],
		['--status with an empty entry', ['--status', 'a,,b'], /--status.*empty/],
		['--status twice', ['--status', 'a', '--status', 'b'], /--status is given twice/],
		['--ids without a value', ['--ids'], /--ids needs/],
		['--ids with an empty entry', ['--ids', 'a,'], /--ids.*empty/],
		['--ids twice', ['--ids', 'a', '--ids', 'b'], /--ids is given twice/],
		['--comments without a value', ['--comments'], /--comments needs/],
		['--comments with another word', ['--comments', 'weird'], /--comments weird.*each, digest, none/],
		['--comments twice', ['--comments', 'each', '--comments', 'none'], /--comments is given twice/],
		['--comments none with --history-comment', ['--comments', 'none', '--history-comment'], /contradict/],
	])('%s is refused with the fix, before any project is looked up', (_name, args, message) => {
		const result = refused([...BASE, ...args]);

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(message);
	});

	it('the refusals are {error, hint} with --json', () => {
		const result = refused([...BASE, '--limit', '0'], true);

		const body = JSON.parse(result.output) as { error: string; hint?: string };
		expect(body.error).toContain('--limit');
		expect(body.hint).toBeDefined();
	});

	it('the commands the output prints keep the selection and the comments mode, so a resume continues the same run', () => {
		const line = commandLine(
			parsed(
				'--only-open',
				'--limit',
				'5',
				'--ids',
				'a,b',
				'--comments',
				'digest',
				'--allow-loss',
				'links:excluded'
			),
			{ resume: true }
		);

		expect(line).toBe(
			'task migrate --from a --to b --allow-loss links:excluded --only-open --ids a,b --limit 5 --comments digest --resume'
		);
		expect(commandLine(parsed('--status', 'backlog,done'))).toBe(
			'task migrate --from a --to b --status backlog,done'
		);
		expect(commandLine(parsed())).toBe('task migrate --from a --to b');
	});
});

describe('task migrate: the text of a run with a selection', () => {
	function result(change: Partial<MigrationResult>): MigrationResult {
		return {
			status: 'completed',
			dryRun: false,
			from: { id: 'aaaa1111', name: 'old', kind: 'local' },
			to: { id: 'bbbb2222', name: 'new', kind: 'github' },
			counts: { source: 6, created: 2, resumed: 0, skipped: 1, failed: 0, remaining: 0 },
			losses: [],
			blocking: [],
			notes: [],
			warnings: [],
			estimate: { writes: 0, requests: 0, seconds: 0 },
			idMap: [],
			journal: 'j.json',
			events: [],
			...change,
		};
	}
	const selection = {
		total: 6,
		selected: 2,
		alreadyMigrated: 1,
		excluded: 3,
		excludedBy: { status: 1, ids: 0, limit: 2 },
		deferred: { parents: 1, links: 2 },
	};

	it('says what was selected, what was left out and why, and what is written later', () => {
		const text = formatMigration(result({ selection }), parsed('--only-open', '--limit', '2'));

		expect(text).toContain('Selection: 2 selected, 1 already migrated, 3 left out (1 by status, 2 by --limit)');
		expect(text).toContain('1 parent(s) and 2 link(s) wait for the run that copies their other end');
		expect(text).toContain('Next: task migrate --from a --to b --only-open --limit 2');
	});

	it('says what --comments did to the number of writes', () => {
		const text = formatMigration(
			result({ comments: { mode: 'digest', planned: 3, saved: 5 } }),
			parsed('--comments', 'digest')
		);

		expect(text).toContain('Comments:  digest: 3 comment(s) written, 5 write(s) saved');
	});

	it('a partial in-place run is not a failure: exit 0, the switch is said NOT done, and the next command is named', () => {
		const partial = result({
			status: 'partial',
			selection,
			inPlace: { switched: false, idMapFile: 'map.json', config: 'config.yml' },
			resumeCommand: 'task migrate --in-place --to-config d.yml -p cccc3333 --only-open --resume',
		});
		const parse = parseMigrateArgs(['--in-place', '--to-config', 'd.yml', '--only-open'], false) as ParsedMigrate;

		const text = formatMigration(partial, parse);

		expect(migrationExitCode(partial, parse)).toBe(0);
		expect(text).toContain('PARTIAL');
		expect(text).toContain('config.yml is unchanged');
		expect(text).toContain('only when every task of the source is copied');
		expect(text).toContain('task migrate --in-place --to-config d.yml -p cccc3333 --only-open --resume');
	});
});

describe('task migrate with a selection, through the command', () => {
	let tmpDir: string;
	let project: RegisteredTestProject;
	let target: RegisteredTestProject;
	let fake: FakeGitHub | undefined;
	const TOKEN_VARIABLE = 'TASK_CLI_PHASE2_TEST_TOKEN';
	const ALLOW = 'history,created-at,marker,links:excluded';
	const OLD_CONFIG = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
`;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-phase2-'));
		project = await registerTestProject(path.join(tmpDir, 'shop'), {
			name: `shop-${path.basename(tmpDir)}`.toLowerCase(),
		});
		target = await registerTestProject(path.join(tmpDir, 'new'), {
			name: `new-${path.basename(tmpDir)}`.toLowerCase(),
		});
		fs.mkdirSync(path.dirname(ownConfigFile(project.storage)), { recursive: true });
		fs.writeFileSync(ownConfigFile(project.storage), OLD_CONFIG);
		fs.mkdirSync(path.dirname(ownConfigFile(target.storage)), { recursive: true });
		fs.writeFileSync(ownConfigFile(target.storage), OLD_CONFIG);
		delivered.length = 0;
		vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await fake?.stop();
		fake = undefined;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	const run = (cwd: string, ...args: string[]) => runTaskCommand(args, cwd);

	async function newTask(title: string): Promise<string> {
		const result = await run(project.dir, 'new', title);
		return (JSON.parse(result.output) as { id: string }).id;
	}

	async function seed(): Promise<Record<string, string>> {
		const open = await newTask('Open one');
		const other = await newTask('Open two');
		const shipped = await newTask('Shipped');
		await run(project.dir, 'set-status', shipped, 'done');
		await run(project.dir, 'link', open, 'blockedBy', shipped);
		delivered.length = 0;
		return { open, other, shipped };
	}

	const titlesOf = async (side: RegisteredTestProject): Promise<string[]> =>
		(JSON.parse((await run(side.dir, 'list', '--all', '--json')).output) as Array<{ title: string }>)
			.map(task => task.title)
			.sort();

	it('--only-open between projects: the dry run reports the selection, the link left out blocks until it is allowed, the run copies the open tasks', async () => {
		await seed();
		const migrate = (...args: string[]) =>
			run(tmpDir, 'migrate', '--from', project.name, '--to', target.name, ...args);

		const dry = await migrate('--only-open', '--allow-loss', 'history,created-at', '--dry-run', '--json');
		expect(dry.exitCode).toBe(0);
		const plan = JSON.parse(dry.output) as MigrationResult;
		expect(plan.selection).toMatchObject({ total: 3, selected: 2, excluded: 1, excludedBy: { status: 1 } });
		expect(plan.blocking).toEqual(['links:excluded']);

		const blocked = await migrate('--only-open', '--allow-loss', 'history,created-at');
		expect(blocked.exitCode).toBe(1);
		expect(blocked.output).toContain('links:excluded');
		expect(blocked.output).toContain('--only-open');

		const done = await migrate('--only-open', '--allow-loss', ALLOW);
		expect(done.exitCode).toBe(0);
		expect(done.output).toContain('Selection: 2 selected');
		expect(await titlesOf(target)).toEqual(['Open one', 'Open two']);

		// The rest later: the closed task joins and the link it was left out of is written on the open one.
		const rest = await migrate('--allow-loss', ALLOW);
		expect(rest.exitCode).toBe(0);
		expect(await titlesOf(target)).toEqual(['Open one', 'Open two', 'Shipped']);
		const open = (
			JSON.parse((await run(target.dir, 'list', '--json')).output) as Array<{ id: string; title: string }>
		).find(task => task.title === 'Open one')!;
		const links = JSON.parse((await run(target.dir, 'show', open.id)).output) as { links?: unknown[] };
		expect(links.links).toHaveLength(1);
	});

	it('--status with an unknown status lists the statuses of the source', async () => {
		await seed();

		const result = await run(tmpDir, 'migrate', '--from', project.name, '--to', target.name, '--status', 'donee');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('unknown status "donee"');
		expect(result.output).toContain('Valid statuses: backlog, in-progress, done');
	});

	it('--limit copies the first tasks and the same command continues with the next ones', async () => {
		await seed();
		const migrate = () =>
			run(tmpDir, 'migrate', '--from', project.name, '--to', target.name, '--allow-loss', ALLOW, '--limit', '2');

		const first = await migrate();
		expect(first.exitCode).toBe(0);
		expect(await titlesOf(target)).toHaveLength(2);
		const second = await migrate();
		expect(second.exitCode).toBe(0);
		expect(await titlesOf(target)).toEqual(['Open one', 'Open two', 'Shipped']);
	});

	it('in place with --only-open: PARTIAL, the config is NOT switched, the next command is printed; the run without selection switches', async () => {
		await seed();
		fake = await FakeGitHub.start({ repo: 'acme/shop' });
		vi.stubEnv(TOKEN_VARIABLE, fake.token);
		const draft = path.join(tmpDir, 'github.yml');
		fs.writeFileSync(
			draft,
			`${OLD_CONFIG}strategy:
    type: github
    options:
        repo: acme/shop
        baseUrl: ${fake.baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        writeSpacingSeconds: 0
        timeoutSeconds: 3
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status:in-progress' }
            done: { state: closed }
`
		);
		const before = fs.readFileSync(ownConfigFile(project.storage), 'utf8');

		const first = await run(
			project.dir,
			'migrate',
			'--in-place',
			'--to-config',
			draft,
			'--only-open',
			'--allow-loss',
			ALLOW,
			'--json'
		);

		expect(first.exitCode).toBe(0);
		const partial = JSON.parse(first.output) as MigrationResult;
		expect(partial.status).toBe('partial');
		expect(partial.inPlace).toMatchObject({ switched: false });
		expect(partial.selection).toMatchObject({ selected: 2, excluded: 1 });
		expect(partial.resumeCommand).toContain('--only-open');
		expect(partial.resumeCommand).toContain('--resume');
		expect(fs.readFileSync(ownConfigFile(project.storage), 'utf8')).toBe(before);

		const text = await run(
			project.dir,
			'migrate',
			'--in-place',
			'--to-config',
			draft,
			'--only-open',
			'--resume',
			'--allow-loss',
			ALLOW
		);
		expect(text.exitCode).toBe(0);
		expect(text.output).toContain('PARTIAL');
		expect(text.output).toContain('NOT done');

		const last = await run(
			project.dir,
			'migrate',
			'--in-place',
			'--to-config',
			draft,
			'--resume',
			'--allow-loss',
			ALLOW,
			'--json'
		);
		expect(last.exitCode).toBe(0);
		const finished = JSON.parse(last.output) as MigrationResult;
		expect(finished.status).toBe('completed');
		expect(finished.inPlace).toMatchObject({ switched: true });
		expect(fs.readFileSync(ownConfigFile(project.storage), 'utf8')).toContain('strategy:');
		expect([...fake.issues.values()].map(issue => issue.title).sort()).toEqual(['Open one', 'Open two', 'Shipped']);
	});
});

describe('task migrate --help', () => {
	it('describes the subset, the comments modes and the new loss kinds, and lists every loss kind', async () => {
		const { MIGRATE_HELP } = await import('../cli/help.js');
		const { LOSS_KINDS } = await import('@wadeck-app/task-service');

		for (const word of ['--only-open', '--status', '--ids', '--limit', '--comments', 'PARTIAL', 'NEVER switches']) {
			expect(MIGRATE_HELP).toContain(word);
		}
		for (const kind of LOSS_KINDS) expect(MIGRATE_HELP, `loss kind ${kind}`).toContain(kind);
	});
});
