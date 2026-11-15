import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ownConfigFile } from '@wadeck-app/task-service';
import { FakeGitHub } from '@wadeck-app/task-service/fakeGitHub';

import type { MigrationResult } from '@wadeck-app/task-service';

import { runTaskCommand } from '../TaskIndex.js';
import { commandLine, formatMigration, parseMigrateArgs } from './MigrateCommand.js';
import { type RegisteredTestProject, registerTestProject } from '../testHelpers.js';

// Events reach this list instead of the queue (see MigrateCommand.test.ts).
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

let tmpDir: string;
let project: RegisteredTestProject;
let stderr: string[];
let fake: FakeGitHub | undefined;
const TOKEN_VARIABLE = 'TASK_CLI_INPLACE_TEST_TOKEN';
const ALLOW = 'history,created-at,marker';
const OLD_CONFIG = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
`;

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-inplace-'));
	project = await registerTestProject(path.join(tmpDir, 'shop'), {
		name: `shop-${path.basename(tmpDir)}`.toLowerCase(),
	});
	fs.mkdirSync(path.dirname(ownConfigFile(project.storage)), { recursive: true });
	fs.writeFileSync(ownConfigFile(project.storage), OLD_CONFIG);
	stderr = [];
	delivered.length = 0;
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await fake?.stop();
	fake = undefined;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const run = (cwd: string, ...args: string[]) => runTaskCommand(args, cwd);

async function newTask(title: string, parent?: string): Promise<string> {
	const result = await run(project.dir, 'new', title, ...(parent === undefined ? [] : ['--parent', parent]));
	return (JSON.parse(result.output) as { id: string }).id;
}

async function seed(): Promise<Record<string, string>> {
	const epic = await newTask('Epic');
	const child = await newTask('Child', epic);
	const shipped = await newTask('Shipped');
	await run(project.dir, 'set-status', shipped, 'done');
	await run(project.dir, 'link', child, 'blockedBy', shipped);
	delivered.length = 0;
	return { Epic: epic, Child: child, Shipped: shipped };
}

async function githubDraft(): Promise<string> {
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
	vi.stubEnv(TOKEN_VARIABLE, fake.token);
	const file = path.join(tmpDir, 'github.yml');
	fs.writeFileSync(
		file,
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
	return file;
}

/** The command line quotes what is not plain (a Windows path with backslashes). */
function quoted(text: string): string {
	return /^[A-Za-z0-9_.@:/-]+$/.test(text) ? text : `"${text}"`;
}

function show(label: string, text: string): void {
	if (process.env['SHOW_SAMPLES'] !== undefined) process.stdout.write(`\n----- ${label}\n${text}\n`);
}

describe('task migrate --in-place: printed commands never carry a sticky flag', () => {
	it('--accept-differences and --accept-draft-change are not copied into the resume or next command', () => {
		const parsed = parseMigrateArgs(
			['--in-place', '--to-config', 'x.yml', '--resume', '--accept-differences', '--accept-draft-change'],
			false
		);
		if ('exitCode' in parsed) throw new Error(parsed.output);

		const line = commandLine(parsed, { resume: true });

		expect(line).toContain('--resume');
		expect(line).not.toContain('--accept-');
	});

	it('when differences were accepted the text says so, and that the printed commands never repeat the flag', () => {
		const result = {
			status: 'completed',
			dryRun: false,
			from: { id: 'a', name: 'shop', kind: 'local' },
			to: { id: 'a', name: 'shop', kind: 'github' },
			counts: { source: 1, created: 1, resumed: 0, skipped: 0, failed: 0, remaining: 0 },
			losses: [],
			blocking: [],
			notes: [],
			warnings: [],
			estimate: { writes: 0, requests: 0, seconds: 0 },
			idMap: [],
			journal: 'j.json',
			events: [],
			inPlace: {
				switched: true,
				idMapFile: 'm.json',
				acceptedDifferences: [{ sourceId: 's', targetId: 't', field: 'title', expected: 'x', actual: 'X' }],
			},
		} as unknown as MigrationResult;
		const parsed = parseMigrateArgs(['--in-place', '--to-config', 'x.yml'], false);
		if ('exitCode' in parsed) throw new Error(parsed.output);

		expect(formatMigration(result, parsed)).toMatch(/never copied into a printed command/);
	});
});

describe('task migrate --in-place: the command line', () => {
	it('--help documents the in-place form, the switch, the id map and the rollback; the main help lists it', async () => {
		const help = await runTaskCommand(['migrate', '--help'], tmpDir);

		expect(help.exitCode).toBe(0);
		for (const text of [
			'--in-place',
			'--to-config <file>',
			'config.yml.before-migration',
			'migrate-idmap-<project id>.json',
			'--dry-run also prints the strategy checks',
			'register a second project',
		]) {
			expect(help.output).toContain(text);
		}
		expect((await runTaskCommand(['--help'], tmpDir)).output).toContain(
			'task migrate --in-place --to-config <file>'
		);
		show('task migrate --help', help.output);
	});

	it.each([
		[['migrate', '--in-place'], /--in-place needs --to-config <file>/],
		[['migrate', '--in-place', '--to-config', 'x.yml', '--from', 'a'], /does not take --from/],
		[['migrate', '--in-place', '--to-config', 'x.yml', '--to', 'a'], /does not take --to/],
		[
			['migrate', '--in-place', '--to-config', 'x.yml', '--from', 'a', '--to', 'b'],
			/does not take --from and --to/,
		],
		[['migrate', '--to-config', 'x.yml'], /--to-config only goes with --in-place/],
		[['migrate', '--in-place', '--to-config'], /--to-config needs the path/],
		[
			['migrate', '--from', 'a', '--to', 'b', '--accept-differences'],
			/--accept-differences only goes with --in-place/,
		],
		[
			['migrate', '--from', 'a', '--to', 'b', '--accept-draft-change'],
			/--accept-draft-change only goes with --in-place/,
		],
		[
			['migrate', '--in-place', '--to-config', 'x.yml', '--accept-draft-change'],
			/--accept-draft-change .* needs --resume/,
		],
	])('%j is refused with an actionable message', async (args, message) => {
		const result = await run(project.dir, ...args);

		expect(result.exitCode).toBe(1);
		expect(JSON.parse((await run(project.dir, ...args, '--json')).output)).toMatchObject({
			error: expect.stringMatching(message),
			hint: expect.any(String),
		});
	});

	it('plain migrate still refuses -p', async () => {
		const result = await run(project.dir, 'migrate', '-p', project.name, '--from', 'a', '--to', 'b');

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(/does not take -p/);
	});

	it('a folder in no registered project is the usual error, nothing is read', async () => {
		const result = await run(tmpDir, 'migrate', '--in-place', '--to-config', 'x.yml');

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(/no project in scope/);
	});

	it('a missing draft is an error naming the file, and the config is untouched', async () => {
		const result = await run(project.dir, 'migrate', '--in-place', '--to-config', 'nope.yml');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(path.join(project.dir, 'nope.yml'));
		expect(fs.readFileSync(ownConfigFile(project.storage), 'utf8')).toBe(OLD_CONFIG);
	});
});

describe('task migrate --in-place over a GitHub draft (the fake server)', () => {
	it('dry run: plan, losses, strategy checks, nothing written; then the real run switches and prints the id map', async () => {
		const ids = await seed();
		const draft = await githubDraft();

		const dry = await run(project.dir, 'migrate', '--in-place', '--to-config', draft, '--dry-run');

		expect(dry.exitCode).toBe(0);
		expect(dry.output).toContain(
			`In-place migration of ${project.name}, storage local -> github: DRY RUN, nothing was written`
		);
		expect(dry.output).toContain('Strategy checks of the draft (nothing is written):');
		expect(dry.output).toContain('[ok] token');
		expect(dry.output).toContain('Switch:    would replace');
		expect(dry.output).toContain('config.yml.before-migration');
		expect(dry.output).toMatch(
			/Next: to accept these losses run: task migrate --in-place --to-config .*github\.yml"? -p /
		);
		expect(fake!.writes()).toEqual([]);
		expect(fs.readFileSync(ownConfigFile(project.storage), 'utf8')).toBe(OLD_CONFIG);
		show('dry run', dry.output);

		const real = await run(project.dir, 'migrate', '--in-place', '--to-config', draft, '--allow-loss', ALLOW);

		expect(real.exitCode).toBe(0);
		expect(real.output).toContain('storage local -> github: done');
		expect(real.output).toContain('Switch:    DONE');
		expect(real.output).toContain('Rollback:  copy');
		expect(real.output).toContain('Id map (old id -> new id):');
		for (const id of Object.values(ids)) expect(real.output).toMatch(new RegExp(`${id} +-> \\d+`));
		expect(stderr.join('')).toMatch(/\[\d\/3\] created /);
		expect(fs.readFileSync(ownConfigFile(project.storage), 'utf8')).toBe(fs.readFileSync(draft, 'utf8'));
		expect(delivered).toHaveLength(1);
		show('real run', real.output);
		// The project now reads GitHub: the tasks are the issues.
		const listed = await run(project.dir, 'list', '--all', '--json');
		expect((JSON.parse(listed.output) as Array<{ title: string }>).map(task => task.title).sort()).toEqual([
			'Child',
			'Epic',
			'Shipped',
		]);
	});

	it('a draft that is only a strategy section drops the other keys of config.yml: a warning in the text and configKeysDropped in --json, with the fix', async () => {
		fs.writeFileSync(
			ownConfigFile(project.storage),
			`${OLD_CONFIG}priorities: [high, low]
`
		);
		const draft = await githubDraft();

		const text = await run(project.dir, 'migrate', '--in-place', '--to-config', draft, '--dry-run');
		const json = await run(project.dir, 'migrate', '--in-place', '--to-config', draft, '--dry-run', '--json');

		expect(text.output).toMatch(/Warnings:[\s\S]*does not have priorities: that key is gone after the switch/);
		expect(text.output).toContain('copy the current config.yml, add the strategy section');
		expect(text.output).toContain(`-p ${project.id}`);
		expect(
			(JSON.parse(json.output) as { inPlace: { configKeysDropped: string[] } }).inPlace.configKeysDropped
		).toEqual(['priorities']);
	});

	it('--json: idMap, inPlace (switched, idMapFile, config, backup, rollback), no events', async () => {
		await seed();
		const draft = await githubDraft();

		const result = await run(
			project.dir,
			'migrate',
			'--in-place',
			'--to-config',
			draft,
			'--allow-loss',
			ALLOW,
			'--json'
		);

		expect(result.exitCode).toBe(0);
		const json = JSON.parse(result.output) as {
			status: string;
			idMap: Array<{ source: string; target: string }>;
			inPlace: Record<string, unknown>;
			events?: unknown;
		};
		expect(json.status).toBe('completed');
		expect(json.idMap).toHaveLength(3);
		expect(json.inPlace).toMatchObject({
			switched: true,
			draft,
			config: ownConfigFile(project.storage),
			backup: `${ownConfigFile(project.storage)}.before-migration`,
		});
		expect(json.inPlace['idMapFile']).toMatch(/migrate-idmap-.*\.json$/);
		expect(json.events).toBeUndefined();
	});

	it('a stopped run prints the exact resume command (draft absolute, project named) and --resume finishes it', async () => {
		await seed();
		const draft = await githubDraft();
		fake!.failNext({
			status: 422,
			method: 'POST',
			pathPrefix: '/repos/acme/shop/issues',
			skip: 1,
			body: { message: 'Validation Failed' },
		});

		const first = await run(
			tmpDir,
			'migrate',
			'--in-place',
			'--to-config',
			'github.yml',
			'-p',
			project.name,
			'--allow-loss',
			ALLOW
		);

		expect(first.exitCode).toBe(1);
		expect(first.output).toContain('Switch:    NOT done');
		expect(first.output).toContain(
			`task migrate --in-place --to-config ${quoted(draft)} -p ${project.id} --allow-loss ${ALLOW} --resume`
		);
		show('stopped run', first.output);

		const second = await run(
			tmpDir,
			'migrate',
			'--in-place',
			'--to-config',
			draft,
			'-p',
			project.name,
			'--allow-loss',
			ALLOW,
			'--resume'
		);

		expect(second.exitCode).toBe(0);
		expect(second.output).toContain('Switch:    DONE');
		expect(fake!.issues.size).toBe(3);
	});

	it('config.yml.before-migration in the way: exit 1 with the file and the fix, dry run included', async () => {
		await seed();
		const draft = await githubDraft();
		const backup = `${ownConfigFile(project.storage)}.before-migration`;
		fs.writeFileSync(backup, 'statuses: [x]\n');

		for (const extra of [['--dry-run'], ['--allow-loss', ALLOW]]) {
			const result = await run(project.dir, 'migrate', '--in-place', '--to-config', draft, ...extra, '--json');
			expect(result.exitCode).toBe(1);
			expect(JSON.parse(result.output)).toMatchObject({
				error: expect.stringContaining(backup),
				hint: expect.stringMatching(/delete/),
			});
		}
		expect(fake!.writes()).toEqual([]);
	});
});
