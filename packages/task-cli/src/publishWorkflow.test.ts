// Structure of .github/workflows/publish.yml that protects the macOS release path (see binShim.unit.test.ts for the
// incident): the packed CLI is smoke-tested on macOS runners before publish, and the exec bit lost by the artifact
// transfer is restored before both the smoke test and the publish.
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..', '..');
// The platforms task supports (owner decision: win32-x64, darwin-arm64 and linux-x64; no Intel Mac).
const PLATFORMS = 'win32-x64,darwin-arm64,linux-x64';

interface Step {
	name?: string;
	run?: string;
	uses?: string;
	env?: Record<string, string>;
}
interface Job {
	needs?: string | string[];
	if?: string;
	'continue-on-error'?: boolean;
	'runs-on'?: string;
	strategy?: { matrix?: { os?: string[] } };
	steps?: Step[];
}
const workflow = load(readFileSync(path.join(REPO, '.github', 'workflows', 'publish.yml'), 'utf8')) as {
	jobs: Record<string, Job>;
};

const runs = (job: Job): string[] => (job.steps ?? []).flatMap(s => (s.run === undefined ? [] : [s.run]));

describe('publish workflow', () => {
	it('has the packed-smoke job on an Apple silicon (arm64) macOS runner and a Linux x64 runner only', () => {
		const smoke = workflow.jobs['packed-smoke'];
		expect(smoke, 'job packed-smoke').toBeDefined();
		const os = smoke.strategy?.matrix?.os ?? [];
		expect(os).toContain('macos-latest');
		expect(os).toEqual(['macos-latest', 'ubuntu-latest']);
		expect(smoke['runs-on']).toContain('matrix.os');
	});

	// A smoke job that never got a runner ends `cancelled` after 15 minutes (macos-14 twice, macos-latest once in run
	// 43511865443) and blocked the publish; only a real `failure` of the packed CLI must stop it.
	it('publish waits for packed-smoke and is stopped only by its failure, not by a smoke job that got no runner', () => {
		const publish = workflow.jobs.publish;
		expect([publish.needs].flat()).toEqual(['build-and-test', 'packed-smoke']);
		expect(publish.if).toContain('!cancelled()');
		expect(publish.if).toContain("needs.build-and-test.result == 'success'");
		expect(publish.if).toContain("needs.packed-smoke.result != 'failure'");
		expect(publish.if).toContain("github.event_name == 'push'");
	});

	it('packed-smoke blocks (no continue-on-error), needs only build-and-test, runs on the packed artifact', () => {
		const smoke = workflow.jobs['packed-smoke'];
		expect(smoke['continue-on-error']).toBeUndefined();
		expect([smoke.needs].flat()).toEqual(['build-and-test']);
		const steps = smoke.steps ?? [];
		expect(steps.some(st => st.uses?.startsWith('actions/download-artifact'))).toBe(true);
		expect(runs(smoke).join('\n')).toContain('smoke-packed.sh');
	});

	it.each(['packed-smoke', 'publish'])('%s restores the exec bits after downloading the artifact', jobName => {
		const steps = workflow.jobs[jobName].steps ?? [];
		const download = steps.findIndex(s => s.uses?.startsWith('actions/download-artifact'));
		const restore = steps.findIndex(s => s.run?.includes('restore-exec-bits.sh'));
		expect(download, 'download step').toBeGreaterThanOrEqual(0);
		expect(restore, 'restore step').toBeGreaterThan(download);
	});

	it('runs the smoke script on the packed artifact and every script it references exists', () => {
		const smokeRuns = runs(workflow.jobs['packed-smoke']).join('\n');
		expect(smokeRuns).toContain('smoke-packed.sh');
		for (const script of ['smoke-packed.sh', 'restore-exec-bits.sh']) {
			expect(existsSync(path.join(REPO, 'packages', 'task-cli', 'ci', 'scripts', script)), script).toBe(true);
		}
	});

	// Owner decision: Intel Macs are not supported, so nothing builds, packs, tests or publishes for them.
	it('has no trace of Intel macOS (darwin-x64 package, x64 mac runner)', () => {
		const raw = readFileSync(path.join(REPO, '.github', 'workflows', 'publish.yml'), 'utf8');
		expect(raw).not.toMatch(/darwin-x64|darwin_amd64|macos-13|macos-15-intel|macos-\w+-large/);
		const published = runs(workflow.jobs.publish).join('\n');
		expect(published).toContain('task-cli-win32-x64 task-cli-darwin-arm64 task-cli-linux-x64');
	});

	// The scripts are synchronized copies of ci-templates (commit 0099d00) and know darwin-x64; task never asks for it:
	// every call site passes the explicit list below, in the canonical argument conventions.
	it('copy-binaries.sh has no darwin-x64 / amd64 mac reference', () => {
		const raw = readFileSync(path.join(REPO, 'packages', 'task-cli', 'ci', 'scripts', 'copy-binaries.sh'), 'utf8');
		expect(raw).not.toMatch(/darwin-x64|darwin_amd64|x86_64/);
	});

	it('generate-platform-packages.sh gets PLATFORMS=win32-x64,darwin-arm64 explicitly', () => {
		const build = workflow.jobs['build-and-test'];
		const step = (build.steps ?? []).find(s => s.run?.includes('generate-platform-packages.sh'));
		expect(step, 'generate step').toBeDefined();
		expect(step?.env?.PLATFORMS).toBe(PLATFORMS);
		expect(step?.run).toContain('generate-platform-packages.sh task:app-module/');
	});

	it.each(['packed-smoke', 'publish'])('%s calls restore-exec-bits.sh <packages dir> task <platforms>', jobName => {
		const step = (workflow.jobs[jobName].steps ?? []).find(s => s.run?.includes('restore-exec-bits.sh'));
		expect(step?.run).toContain(`restore-exec-bits.sh packages task ${PLATFORMS}`);
	});

	it('packed-smoke calls smoke-packed.sh <packages dir> task <version> <platforms>', () => {
		const step = (workflow.jobs['packed-smoke'].steps ?? []).find(s => s.run?.includes('smoke-packed.sh'));
		expect(step?.run).toContain(
			`smoke-packed.sh packages task "\${{ needs.build-and-test.outputs.version }}" ${PLATFORMS}`
		);
	});

	it('only uses actions the workflow already used before (checkout, setup-node, upload/download-artifact, compute-version)', () => {
		const used = Object.values(workflow.jobs).flatMap(j => (j.steps ?? []).flatMap(s => (s.uses ? [s.uses] : [])));
		for (const u of used) {
			expect(u, u).toMatch(
				/^(actions\/(checkout|setup-node)@v5|actions\/(upload|download)-artifact@v4|wadeck-app\/ci-templates\/\.github\/actions\/compute-version@main)$/
			);
		}
	});
});
