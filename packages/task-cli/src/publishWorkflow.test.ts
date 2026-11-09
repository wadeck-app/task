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

interface Step {
	name?: string;
	run?: string;
	uses?: string;
}
interface Job {
	needs?: string | string[];
	'runs-on'?: string;
	strategy?: { matrix?: { os?: string[] } };
	steps?: Step[];
}
const workflow = load(readFileSync(path.join(REPO, '.github', 'workflows', 'publish.yml'), 'utf8')) as {
	jobs: Record<string, Job>;
};

const runs = (job: Job): string[] => (job.steps ?? []).flatMap(s => (s.run === undefined ? [] : [s.run]));

describe('publish workflow', () => {
	it('has the macos-smoke job on an arm64 and an x64 macOS runner', () => {
		const smoke = workflow.jobs['macos-smoke'];
		expect(smoke, 'job macos-smoke').toBeDefined();
		const os = smoke.strategy?.matrix?.os ?? [];
		expect(os).toContain('macos-14');
		expect(os.some(label => label.startsWith('macos-') && label !== 'macos-14')).toBe(true);
		expect(smoke['runs-on']).toContain('matrix.os');
	});

	it('publish waits for the smoke job (a package silent on macOS must not be released)', () => {
		expect([workflow.jobs.publish.needs].flat()).toEqual(expect.arrayContaining(['build-and-test', 'macos-smoke']));
	});

	it.each(['macos-smoke', 'publish'])('%s restores the exec bits after downloading the artifact', jobName => {
		const steps = workflow.jobs[jobName].steps ?? [];
		const download = steps.findIndex(s => s.uses?.startsWith('actions/download-artifact'));
		const restore = steps.findIndex(s => s.run?.includes('restore-exec-bits.sh'));
		expect(download, 'download step').toBeGreaterThanOrEqual(0);
		expect(restore, 'restore step').toBeGreaterThan(download);
	});

	it('runs the smoke script on the packed artifact and every script it references exists', () => {
		const smokeRuns = runs(workflow.jobs['macos-smoke']).join('\n');
		expect(smokeRuns).toContain('smoke-packed.sh');
		for (const script of ['smoke-packed.sh', 'restore-exec-bits.sh']) {
			expect(existsSync(path.join(REPO, 'packages', 'task-cli', 'ci', 'scripts', script)), script).toBe(true);
		}
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
