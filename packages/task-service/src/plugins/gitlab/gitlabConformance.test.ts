// The guard that keeps the GitLab mock honest: the recorded LIVE exchanges (fixtures/live-conformance.json, recorded by
// `node scripts/live-gitlab-probe.mjs scenario --record ...` against gitlab.com Free) are replayed against the mock and every
// step must give the same status, the same key headers and the same sanitized body. When this fails, fix the MOCK (or record again
// if GitLab changed); never edit the fixture by hand.
//
// The second half enforces the HYPOTHESIS LEDGER (fakeGitLabLedger.testkit.ts): every behaviour the mock implements has a line, every
// LIVE-VERIFIED line names fixture steps that exist (a line without a recorded step fails), every step a line names exists in the
// scenario that records the fixture, and no line may stay ASSUMED once the live probes are recorded.
import * as fs from 'node:fs';

import { FakeGitLab } from './fakeGitLab.testkit.js';
import { MOCK_LEDGER } from './fakeGitLabLedger.testkit.js';
import type { LedgerEntry } from './fakeGitLabLedger.testkit.js';
import { replayFixture } from './gitlabConformance.testkit.js';
import type { ConformanceFixture } from './gitlabConformance.testkit.js';

const FIXTURE = new URL('./fixtures/live-conformance.json', import.meta.url);
const SCENARIO = new URL('../../../../../scripts/gitlab-conformance-scenario.mjs', import.meta.url);
const PROJECT = 'wadeck-app/test-task-gl';

let fake: FakeGitLab;

beforeAll(async () => {
	fake = await FakeGitLab.start({ project: PROJECT });
});

afterAll(async () => {
	await fake.stop();
});

const readFixture = (): ConformanceFixture => JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as ConformanceFixture;

describe('the mock agrees with the recorded live GitLab', () => {
	it('has a fixture that was recorded live and holds a useful number of steps', () => {
		const fixture = readFixture();
		expect(fixture.format).toBe(1);
		expect(fixture.source).toContain('gitlab.com');
		expect(fixture.steps.length).toBeGreaterThanOrEqual(150);
	});

	it('answers every recorded request like GitLab did', async () => {
		const fixture = readFixture();
		const outcomes = await replayFixture(fixture, {
			apiBase: fake.baseUrl,
			token: fake.token,
			projectPath: PROJECT,
			run: 'abc123',
		});
		const report = outcomes
			.filter(outcome => outcome.problems.length > 0)
			.map(outcome => `${outcome.name}\n    ${outcome.problems.join('\n    ')}`);
		expect(
			report,
			`${report.length} of ${outcomes.length} steps differ from the live recording:\n${report.join('\n')}`
		).toEqual([]);
	});
});

async function scenarioStepNames(): Promise<string[]> {
	const module = (await import(SCENARIO.href)) as { steps: () => Array<{ name: string }> };
	return module.steps().map(step => step.name);
}

describe('the hypothesis ledger of the mock', () => {
	it('has unique ids, a behaviour per line and the fields its status requires, in plain ASCII', () => {
		const problems: string[] = [];
		const seen = new Set<string>();
		for (const entry of MOCK_LEDGER) {
			const where = `${entry.id} [${entry.area}]`;
			if (!/^L\d{3}$/.test(entry.id)) problems.push(`${where}: the id must look like L001`);
			if (seen.has(entry.id)) problems.push(`${where}: duplicate id`);
			seen.add(entry.id);
			if (entry.behaviour.trim() === '') problems.push(`${where}: empty behaviour`);
			// eslint-disable-next-line no-control-regex
			if (/[^\x00-\x7F]/.test(JSON.stringify(entry))) problems.push(`${where}: not ASCII`);
			if (entry.status === 'LIVE-VERIFIED' && (entry.date === undefined || entry.evidence.length === 0))
				problems.push(`${where}: LIVE-VERIFIED needs a date and at least one evidence step`);
			if (
				entry.status === 'ASSUMED' &&
				(entry.probe === undefined || entry.probe.trim() === '' || entry.evidence.length === 0)
			)
				problems.push(`${where}: ASSUMED needs a probe and the scenario step(s) that run it`);
			if (entry.status === 'DOCUMENTED-NOT-LIVE' && (entry.docs === undefined || entry.reason === undefined))
				problems.push(`${where}: DOCUMENTED-NOT-LIVE needs docs and the reason it cannot be probed`);
			if (entry.status === 'UNVERIFIABLE' && (entry.reason === undefined || entry.reason.trim() === ''))
				problems.push(`${where}: UNVERIFIABLE needs the reason`);
		}
		expect(problems, problems.join('\n')).toEqual([]);
	});

	it('names only steps that exist in the scenario that records the fixture, and the scenario names are unique', async () => {
		const names = await scenarioStepNames();
		const known = new Set(names);
		const problems: string[] = [];
		if (known.size !== names.length) {
			const repeated = names.filter((name, index) => names.indexOf(name) !== index);
			problems.push(`scenario step names must be unique, repeated: ${[...new Set(repeated)].join(' | ')}`);
		}
		for (const entry of MOCK_LEDGER) {
			for (const step of entry.evidence)
				if (!known.has(step))
					problems.push(
						`${entry.id}: evidence "${step}" is not a step of scripts/gitlab-conformance-scenario.mjs`
					);
		}
		expect(problems, problems.join('\n')).toEqual([]);
	});

	it('covers every LIVE-VERIFIED line with fixture steps (a line without a recorded step fails)', () => {
		const recorded = new Set(readFixture().steps.map(step => step.name));
		const problems: string[] = [];
		for (const entry of MOCK_LEDGER) {
			if (entry.status !== 'LIVE-VERIFIED') continue;
			const missing = entry.evidence.filter(step => !recorded.has(step));
			if (missing.length > 0)
				problems.push(
					`${entry.id} [${entry.area}] ${entry.behaviour}\n    not in the fixture: ${missing.join(' | ')}`
				);
		}
		expect(
			problems,
			`${problems.length} LIVE-VERIFIED ledger lines name steps the fixture does not hold (record the scenario again, or fix the name):\n${problems.join('\n')}`
		).toEqual([]);
	});

	it('no ledger entry is ASSUMED', () => {
		const pending = MOCK_LEDGER.filter(entry => entry.status === 'ASSUMED');
		const report = pending.map(
			entry =>
				`${entry.id} [${entry.area}] ${entry.behaviour}\n    probe: ${entry.probe}\n    steps: ${entry.evidence.join(' | ')}`
		);
		expect(
			pending,
			`${pending.length} behaviours of the mock are still ASSUMED; record the scenario live, then make each LIVE-VERIFIED or change the mock:\n${report.join('\n')}`
		).toEqual([]);
	});
});
