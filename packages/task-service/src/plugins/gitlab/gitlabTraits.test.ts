import { describe, expect, it } from 'vitest';

import { gitlabPlugin } from './gitlabPlugin.js';
import { parseGitLabOptions } from './gitlabOptions.js';
import { gitlabTraits } from './gitlabTraits.js';

const STATUS_MAP = {
	backlog: { state: 'open' },
	'in-progress': { state: 'open', label: 'status:in-progress' },
	done: { state: 'closed' },
};

function settingsWith(extra: Record<string, unknown> = {}) {
	const parsed = parseGitLabOptions({
		project: 'acme/shop',
		tokenEnv: 'GITLAB_TOKEN',
		tier: 'free',
		statusMap: STATUS_MAP,
		...extra,
	});
	if ('problem' in parsed) throw new Error(parsed.problem);
	return parsed.settings;
}

describe('gitlabTraits (what task migrate needs to know about GitLab as a target)', () => {
	it('GitLab assigns the creation instant and the author; the limits are the documented ones', () => {
		const traits = gitlabTraits(settingsWith(), {});

		expect(traits).toMatchObject({
			keepsCreatedAt: false,
			authoredComments: false,
			commentTextMax: 1_000_000,
		});
		// Room is left for the managed block the strategy may add to the description.
		expect(traits.descriptionMax).toBeLessThan(1_048_576);
		expect(traits.descriptionMax).toBeGreaterThan(1_040_000);
		// No hierarchy at all: no depth or children limit is declared (the capability itself is none).
		expect(traits.hierarchyDepth).toBeUndefined();
		expect(traits.childrenPerParent).toBeUndefined();
	});

	it('costs about seven requests and the write spacing plus three seconds per write; no hourly quota is claimed', () => {
		expect(gitlabTraits(settingsWith(), {}).cost).toEqual({
			requests: 7,
			seconds: 4,
			read: { requests: 5, seconds: 1.5 },
		});
		expect(gitlabTraits(settingsWith({ writeSpacingSeconds: 4 }), {}).cost).toMatchObject({ seconds: 7 });
		expect(gitlabTraits(settingsWith(), {}).cost?.quotaPerHour).toBeUndefined();
	});

	it('refuses the labels GitLab cannot take, and the ones task reserves', () => {
		const { labelProblem } = gitlabTraits(settingsWith(), {});

		expect(labelProblem?.('billing')).toBeUndefined();
		expect(labelProblem?.('a,b')).toMatch(/comma/);
		expect(labelProblem?.(' padded')).toMatch(/space/);
		expect(labelProblem?.('status:in-progress')).toMatch(/reserved.*status/);
		expect(labelProblem?.('STATUS:IN-PROGRESS')).toMatch(/reserved/);
		expect(labelProblem?.('type:bug')).toMatch(/reserved.*type/);
		expect(labelProblem?.('task:deleted')).toMatch(/reserved/);
	});

	it('a scoped label is refused on the free tier, allowed on premium', () => {
		expect(gitlabTraits(settingsWith(), {}).labelProblem?.('team::red')).toMatch(/Premium and Ultimate only/);
		const premium = settingsWith({ tier: 'premium' });

		expect(gitlabTraits(premium, {}).labelProblem?.('team::red')).toBeUndefined();
		expect(gitlabTraits(premium, {}).labelProblem?.('type::bug')).toMatch(/reserved.*type/);
	});

	it('the meta prefix is reserved only when metadata is stored in labels', () => {
		const metaLabels = { meta: { use: 'labels', fidelity: 'strict' as const } };

		expect(gitlabTraits(settingsWith(), {}).labelProblem?.('meta:owner=ann')).toBeUndefined();
		expect(gitlabTraits(settingsWith(), metaLabels).labelProblem?.('meta:owner=ann')).toMatch(/reserved/);
		expect(gitlabTraits(settingsWith({ tier: 'ultimate' }), metaLabels).labelProblem?.('meta::owner::ann')).toMatch(
			/reserved/
		);
	});

	it('the plugin hands them out for the options of a project', () => {
		const traits = gitlabPlugin.traitsFor?.(
			{
				project: 'acme/shop',
				tokenEnv: 'GITLAB_TOKEN',
				tier: 'free',
				statusMap: STATUS_MAP,
				writeSpacingSeconds: 0,
			},
			{},
			{ statuses: [], types: [] }
		);

		expect(traits?.cost).toEqual({ requests: 7, seconds: 3, read: { requests: 5, seconds: 1.5 } });
	});
});
