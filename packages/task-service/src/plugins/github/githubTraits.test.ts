import { describe, expect, it } from 'vitest';

import { githubTraits } from './githubTraits.js';
import { parseGitHubOptions } from './githubOptions.js';
import { githubPlugin } from './githubPlugin.js';
import { TEST_STATUS_MAP, TEST_STATUSES } from './githubBackend.testkit.js';

function settingsWith(extra: Record<string, unknown> = {}) {
	const parsed = parseGitHubOptions({
		repo: 'acme/shop',
		tokenEnv: 'GITHUB_TOKEN',
		statusMap: TEST_STATUS_MAP,
		...extra,
	});
	if ('problem' in parsed) throw new Error(parsed.problem);
	return parsed.settings;
}

describe('githubTraits (what task migrate needs to know about GitHub as a target)', () => {
	it('GitHub assigns the creation instant and the author, and has limits', () => {
		const traits = githubTraits(settingsWith(), {});

		expect(traits).toMatchObject({
			keepsCreatedAt: false,
			authoredComments: false,
			hierarchyDepth: 8,
			childrenPerParent: 100,
			commentTextMax: 65536,
		});
		// Room is left for the managed block the strategy may add to the body.
		expect(traits.descriptionMax).toBeLessThan(65536);
		expect(traits.descriptionMax).toBeGreaterThan(60000);
	});

	it('a separate write costs 4 requests and the write spacing plus three seconds (an assumption), a read 2 requests, a fields-only read 1, within 5000 requests an hour', () => {
		expect(githubTraits(settingsWith(), {}).cost).toMatchObject({
			requests: 4,
			seconds: 4,
			quotaPerHour: 5000,
			read: { requests: 2, seconds: 0.7 },
			resolve: { requests: 1 },
		});
		expect(githubTraits(settingsWith({ writeSpacingSeconds: 4 }), {}).cost).toMatchObject({
			requests: 4,
			seconds: 7,
		});
	});

	it('knows GitHub caps the requests that change it at 80 a minute and 500 an hour, and says where that is documented', () => {
		const cap = githubTraits(settingsWith(), {}).cost!.contentCap!;

		expect(cap).toMatchObject({ perHour: 500, perMinute: 80 });
		expect(cap.source).toMatch(/docs.github.com/);
	});

	it('writes the fields of a migrated task in the create call, and counts a run with a model', () => {
		const traits = githubTraits(settingsWith(), {});

		expect(traits.foldsCreate).toBe(true);
		expect(traits.cost!.model).toBeTypeOf('function');
	});

	it('refuses the labels GitHub would refuse, and the ones task reserves', () => {
		const { labelProblem } = githubTraits(settingsWith(), {});

		expect(labelProblem?.('billing')).toBeUndefined();
		expect(labelProblem?.('x'.repeat(51))).toMatch(/51 characters; GitHub label names are at most 50/);
		expect(labelProblem?.('a,b')).toMatch(/comma/);
		expect(labelProblem?.(' padded')).toMatch(/space/);
		expect(labelProblem?.('status:in-progress')).toMatch(/reserved.*status/);
		expect(labelProblem?.('STATUS:IN-PROGRESS')).toMatch(/reserved/);
		expect(labelProblem?.('type:bug')).toMatch(/reserved.*type/);
		expect(labelProblem?.('task:deleted')).toMatch(/reserved/);
	});

	it('the priority prefix is reserved unless the priority is the native field', () => {
		expect(githubTraits(settingsWith(), {}).labelProblem?.('priority:high')).toMatch(/reserved.*priority/);
		expect(
			githubTraits(settingsWith({ priorityStorage: 'field', priorityFieldId: 5 }), {}).labelProblem?.(
				'priority:high'
			)
		).toBeUndefined();
	});

	it('the meta prefix is reserved only when metadata is stored in labels', () => {
		const metaLabels = { meta: { use: 'labels', fidelity: 'strict' as const } };

		expect(githubTraits(settingsWith(), {}).labelProblem?.('meta:owner=ann')).toBeUndefined();
		expect(githubTraits(settingsWith(), metaLabels).labelProblem?.('meta:owner=ann')).toMatch(/reserved/);
	});

	it('the plugin hands them out for the options of a project', () => {
		const traits = githubPlugin.traitsFor?.(
			{
				repo: 'acme/shop',
				tokenEnv: 'GITHUB_TOKEN',
				statusMap: TEST_STATUS_MAP,
				writeSpacingSeconds: 0,
			},
			{},
			{ statuses: TEST_STATUSES, types: [] }
		);

		expect(traits?.cost).toMatchObject({
			requests: 4,
			seconds: 3,
			quotaPerHour: 5000,
			read: { requests: 2, seconds: 0.7 },
		});
		expect(traits?.foldsCreate).toBe(true);
	});
});
