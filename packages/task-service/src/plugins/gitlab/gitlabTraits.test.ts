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
		// Two levels (an issue or incident and its native tasks, VERIFIED-LIVE): `task migrate` drops a deeper parent with a loss row.
		// A parent holds 99 children: the read returns 100 at most and a longer list is refused, never cut.
		expect(traits.hierarchyDepth).toBe(2);
		expect(traits.childrenPerParent).toBe(99);
	});

	it('costs about seven requests and the write spacing plus three seconds per write; no hourly quota is claimed', () => {
		expect(gitlabTraits(settingsWith(), {}).cost).toEqual({
			requests: 7,
			seconds: 4,
			read: { requests: 6, seconds: 1.8 },
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
		// Names are case sensitive on GitLab: another case is another label, so it is not reserved.
		expect(labelProblem?.('STATUS:IN-PROGRESS')).toBeUndefined();
		expect(labelProblem?.('type:bug')).toMatch(/reserved.*type/);
		expect(labelProblem?.('task:deleted')).toMatch(/reserved/);
	});

	it('a label written with the scoped syntax is a plain label on Free: not refused', () => {
		expect(gitlabTraits(settingsWith(), {}).labelProblem?.('team::red')).toBeUndefined();
	});

	it('the meta prefix is reserved only when metadata is stored in labels', () => {
		const metaLabels = { meta: { use: 'labels', fidelity: 'strict' as const } };

		expect(gitlabTraits(settingsWith(), {}).labelProblem?.('meta:owner=ann')).toBeUndefined();
		expect(gitlabTraits(settingsWith(), metaLabels).labelProblem?.('meta:owner=ann')).toMatch(/reserved/);
	});

	it('the plugin hands them out for the options of a project', () => {
		const traits = gitlabPlugin.traitsFor?.(
			{
				project: 'acme/shop',
				tokenEnv: 'GITLAB_TOKEN',
				statusMap: STATUS_MAP,
				writeSpacingSeconds: 0,
			},
			{},
			{ statuses: [], types: [] }
		);

		expect(traits?.cost).toEqual({ requests: 7, seconds: 3, read: { requests: 6, seconds: 1.8 } });
	});
});
