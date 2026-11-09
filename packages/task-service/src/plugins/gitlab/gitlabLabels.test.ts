import { parseGitLabOptions } from './gitlabOptions.js';
import type { GitLabSettings } from './gitlabOptions.js';
import { wantedLabels } from './gitlabLabels.js';

function settings(tier: 'free' | 'premium', extra: Record<string, unknown> = {}): GitLabSettings {
	const sep = tier === 'free' ? ':' : '::';
	const parsed = parseGitLabOptions({
		project: 'group/project',
		tokenEnv: 'GITLAB_TOKEN',
		tier,
		statusMap: {
			backlog: { state: 'open' },
			'in-progress': { state: 'open', label: `status${sep}in-progress` },
			done: { state: 'closed' },
			cancelled: { state: 'closed', label: `status${sep}cancelled` },
		},
		...extra,
	});
	if ('problem' in parsed) throw new Error(parsed.problem);
	return parsed.settings;
}

describe('wantedLabels', () => {
	it('lists the status labels, then the type labels, then the tombstone, in config order', () => {
		const wanted = wantedLabels(settings('free'), ['bug', 'feature'], {
			delete: { use: 'tombstone', fidelity: 'degrade' },
		});

		expect(wanted).toEqual([
			{ name: 'status:in-progress', kind: 'status', why: 'status "in-progress"' },
			{ name: 'status:cancelled', kind: 'status', why: 'status "cancelled"' },
			{ name: 'type:bug', kind: 'type', why: 'type "bug"' },
			{ name: 'type:feature', kind: 'type', why: 'type "feature"' },
			{ name: 'task:deleted', kind: 'deleted', why: 'deleted tasks (fills.delete: tombstone)' },
		]);
	});

	it('uses the scoped prefixes on premium', () => {
		const wanted = wantedLabels(settings('premium'), ['bug'], {});

		expect(wanted.map(label => label.name)).toEqual(['status::in-progress', 'status::cancelled', 'type::bug']);
	});

	it('gives a type mapped to a native issue type no label, and uses the label of a mapped one', () => {
		const wanted = wantedLabels(
			settings('free', { typeMap: { incident: { issueType: 'incident' }, bug: { label: 'kind:bug' } } }),
			['incident', 'bug', 'feature'],
			{}
		);

		expect(wanted.filter(label => label.kind === 'type').map(label => label.name)).toEqual([
			'kind:bug',
			'type:feature',
		]);
	});

	it('names no tombstone label without the fill, and a label once whatever its case', () => {
		const wanted = wantedLabels(
			settings('free', { typeMap: { bug: { label: 'STATUS:IN-PROGRESS' } } }),
			['bug'],
			{}
		);

		expect(wanted.map(label => label.name)).toEqual(['status:in-progress', 'status:cancelled']);
	});
});
