import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ownConfigFile } from '@wadeck-app/task-service';
import { FakeGitHub } from '@wadeck-app/task-service/fakeGitHub';

import { runTaskCommand } from '../TaskIndex.js';
import { type RegisteredTestProject, registerTestProject } from '../testHelpers.js';

// `task strategy show` and `task strategy check` on a project whose strategy is `migrating`: both sides are reported (the files of the
// project and a fake API), each with its own findings and its own fix; the intersection is what the project offers.
let tmpDir: string;
let project: RegisteredTestProject;
let fake: FakeGitHub;
let stderr: string[];

const TOKEN_VARIABLE = 'TASK_CLI_TEST_MIGRATING_TOKEN';

function configure(newBlock: string): void {
	fs.writeFileSync(
		ownConfigFile(project.storage),
		`statuses:
    - backlog
    - { name: done, terminal: true }
strategy:
    type: migrating
    options:
        current: { type: local }
        new:
${newBlock}
`
	);
}

const GITHUB_BLOCK = (extra = ''): string => `            type: github
            options:
                repo: acme/shop
                baseUrl: ${fake.baseUrl}
                tokenEnv: ${TOKEN_VARIABLE}
                cache: { ttlSeconds: 0 }
                timeoutSeconds: 3
                writeSpacingSeconds: 0
                statusMap:
                    backlog: { state: open }
                    done: { state: closed }
${extra}`;

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-migrating-'));
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
	project = await registerTestProject(path.join(tmpDir, 'shop'));
	vi.stubEnv(TOKEN_VARIABLE, fake.token);
	stderr = [];
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await fake.stop();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const run = (...args: string[]) => runTaskCommand(args, project.dir);

describe('task strategy show on a migrating project', () => {
	it('names the strategy, each side with its type and summary, and the intersected capabilities', async () => {
		configure(GITHUB_BLOCK());

		const result = await run('strategy', 'show');

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('migrating (plugins.migrating.default)');
		expect(result.output).toMatch(/Current:\s+local \(plugins\.local\.default\)/);
		expect(result.output).toMatch(/New:\s+github \(plugins\.github\.default\)/);
		// the table of the strategy is the intersection: what the files do and the API does not is not offered
		expect(result.output).toMatch(/meta\s+unsupported/);
		expect(result.output).toMatch(/delete\s+unsupported/);
		expect(result.output).toMatch(/writes\s+native\s+full/);
	});

	it('prints the table of each side, so the person sees which one holds a capability back', async () => {
		configure(GITHUB_BLOCK());

		const result = await run('strategy', 'show');

		const current = result.output.slice(
			result.output.indexOf('Capabilities of "current":'),
			result.output.indexOf('Capabilities of "new":')
		);
		const next = result.output.slice(result.output.indexOf('Capabilities of "new":'));
		expect(current).toMatch(/meta\s+native/);
		expect(next).toMatch(/meta\s+unsupported/);
	});

	it('lists the token of the second side under its full key and never its value', async () => {
		configure(GITHUB_BLOCK());

		const result = await run('strategy', 'show');

		expect(result.output).toContain(
			`strategy.options.new.options.tokenEnv: ${TOKEN_VARIABLE} (environment variable, set)`
		);
		expect(result.output).not.toContain(fake.token);
	});

	it('--json carries the sides and their capabilities', async () => {
		configure(GITHUB_BLOCK());

		const result = await run('strategy', 'show', '--json');

		const report = JSON.parse(result.output) as {
			subStrategies: Array<{
				slot: string;
				type: string;
				kind: string;
				capabilities: Array<{ capability: string; state: string }>;
			}>;
		};
		expect(report.subStrategies.map(side => [side.slot, side.type, side.kind])).toEqual([
			['current', 'local', 'local'],
			['new', 'github', 'github'],
		]);
		expect(report.subStrategies[1]!.capabilities.find(row => row.capability === 'meta')?.state).toBe('unsupported');
	});

	it('a config problem in the second side names the file and the dotted key, exit 1', async () => {
		configure(GITHUB_BLOCK().replace('repo: acme/shop', 'repo: not-a-repo'));

		const result = await run('strategy', 'show');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('strategy.options.new.options.repo');
	});
});

describe('task strategy check on a migrating project', () => {
	it('checks both sides, every line named after its side, and says nothing moves yet, with the fix', async () => {
		configure(GITHUB_BLOCK());

		const result = await run('strategy', 'check');

		expect(result.exitCode).toBe(0);
		expect(result.output).toMatch(/state\s+warn\s+in-a: every operation goes to "current"/);
		expect(result.output).toMatch(/fix: This version does not move tasks yet/);
		expect(result.output).toMatch(/current\.data\s+ok/);
		expect(result.output).toMatch(/current\.tasks\s+ok\s+0 tasks/);
		expect(result.output).toMatch(/new\.reachable\s+ok/);
		// the findings of the second side (its own warnings) are listed too, each with its fix
		expect(result.output).toMatch(/Result: ok \(0 errors, \d+ warnings?\)/);
	});

	it('check sends no write to the second side', async () => {
		configure(GITHUB_BLOCK());

		await run('strategy', 'check');

		expect(fake.writes()).toEqual([]);
	});

	it('a refused token on the second side is an error line of that side with its own fix, exit 1', async () => {
		configure(GITHUB_BLOCK());
		vi.stubEnv(TOKEN_VARIABLE, 'a-wrong-token-value');

		const result = await run('strategy', 'check');

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(/new\.auth\s+error\s+GitHub refused the token/);
		expect(result.output).toContain('Result: FAILED');
		expect(result.output).not.toContain('a-wrong-token-value');
	});

	it('an unset token variable is an error line naming the full key of the second side, with a fix', async () => {
		configure(GITHUB_BLOCK());
		vi.stubEnv(TOKEN_VARIABLE, '');

		const result = await run('strategy', 'check');

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(/token\s+error\s+\S+ is not set \(strategy\.options\.new\.options\.tokenEnv\)/);
		expect(result.output).toMatch(/fix: /);
	});

	it('an emulated fill on the second side is a warning naming the side, with a fix', async () => {
		configure(GITHUB_BLOCK('                fills: { meta: { use: body-block, fidelity: degrade } }'));

		const result = await run('strategy', 'check');

		expect(result.output).toMatch(/fills\s+warn\s+new: meta is emulated via body-block/);
		expect(result.output).toContain('Accepted by fidelity: degrade');
	});

	it('--json keeps both sides in the report and every warning has a fix', async () => {
		configure(GITHUB_BLOCK());

		const result = await run('strategy', 'check', '--json');

		const check = JSON.parse(result.output) as {
			lines: Array<{ name: string; status: string; fix?: string }>;
			report: { subStrategies: unknown[] };
		};
		expect(check.report.subStrategies).toHaveLength(2);
		for (const line of check.lines.filter(entry => entry.status !== 'ok')) {
			expect(line.fix, `the ${line.status} line "${line.name}" has no fix`).toBeDefined();
		}
	});
});

describe('a migrating project used as a normal project', () => {
	it('task new and task list work, the tasks are in the files of "current", the API saw no write', async () => {
		configure(GITHUB_BLOCK());

		const created = await run('new', 'first task');
		const listed = await run('list');

		expect(created.exitCode).toBe(0);
		expect(listed.exitCode).toBe(0);
		expect(listed.output).toContain('first task');
		expect(fake.writes()).toEqual([]);
	});

	it('an operation the intersection holds back says which side to change and exits 1', async () => {
		configure(GITHUB_BLOCK());
		const created = JSON.parse((await run('new', 'meta task', '--json')).output) as { id: string };

		const result = await run('set-meta', created.id, 'k', 'v');

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('"new"');
		expect(result.output).toContain('could not be moved there later');
	});
});
