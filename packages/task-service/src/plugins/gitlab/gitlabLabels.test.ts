import { parseGitLabOptions } from './gitlabOptions.js';
import type { GitLabSettings } from './gitlabOptions.js';
import { priorityLabelsWanted, wantedLabels } from './gitlabLabels.js';
import { createPriorityContext } from './gitlabPriority.js';

const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
const contextOf = (s: GitLabSettings, priorities: string[] | null = PRIORITIES) =>
	createPriorityContext(s, priorities ?? undefined);

function settings(extra: Record<string, unknown> = {}): GitLabSettings {
	const parsed = parseGitLabOptions({
		project: 'group/project',
		tokenEnv: 'GITLAB_TOKEN',
		statusMap: {
			backlog: { state: 'open' },
			'in-progress': { state: 'open', label: 'status:in-progress' },
			done: { state: 'closed' },
			cancelled: { state: 'closed', label: 'status:cancelled' },
		},
		...extra,
	});
	if ('problem' in parsed) throw new Error(parsed.problem);
	return parsed.settings;
}

describe('wantedLabels', () => {
	it('lists the status labels, then the type labels, then the tombstone, in config order', () => {
		const s = settings();
		const wanted = wantedLabels(
			s,
			['bug', 'feature'],
			{ delete: { use: 'tombstone', fidelity: 'degrade' } },
			contextOf(s, [])
		);

		expect(wanted).toEqual([
			{ name: 'status:in-progress', kind: 'status', why: 'status "in-progress"' },
			{ name: 'status:cancelled', kind: 'status', why: 'status "cancelled"' },
			{ name: 'type:bug', kind: 'type', why: 'type "bug"' },
			{ name: 'type:feature', kind: 'type', why: 'type "feature"' },
			{ name: 'task:deleted', kind: 'deleted', why: 'deleted tasks (fills.delete: tombstone)' },
		]);
	});

	it('gives a type mapped to a native issue type no label, and uses the label of a mapped one', () => {
		const s = settings({ typeMap: { incident: { issueType: 'incident' }, bug: { label: 'kind:bug' } } });
		const wanted = wantedLabels(s, ['incident', 'bug', 'feature'], {}, contextOf(s));

		expect(wanted.filter(label => label.kind === 'type').map(label => label.name)).toEqual([
			'kind:bug',
			'type:feature',
		]);
	});

	it('names no tombstone label without the fill, and a label once (names are case sensitive: another case is another label)', () => {
		const s = settings({ typeMap: { bug: { label: 'STATUS:IN-PROGRESS' } } });
		const wanted = wantedLabels(s, ['bug'], {}, contextOf(s, []));

		expect(wanted.map(label => label.name)).toEqual([
			'status:in-progress',
			'status:cancelled',
			'STATUS:IN-PROGRESS',
		]);
	});

	it('lists the priority labels after the types and before the tombstone, in the order of the project priorities', () => {
		const s = settings();
		const wanted = wantedLabels(s, ['bug'], { delete: { use: 'tombstone', fidelity: 'degrade' } }, contextOf(s));

		expect(wanted.map(label => [label.kind, label.name])).toEqual([
			['status', 'status:in-progress'],
			['status', 'status:cancelled'],
			['type', 'type:bug'],
			['priority', 'priority:urgent'],
			['priority', 'priority:high'],
			['priority', 'priority:medium'],
			['priority', 'priority:low'],
			['deleted', 'task:deleted'],
		]);
	});

	it('uses the scoped prefix and the whole name of a mapped priority', () => {
		const s = settings({ priorityPrefix: 'priority::', priorityMap: { urgent: 'P0' } });

		expect(priorityLabelsWanted(contextOf(s)).map(label => label.name)).toEqual([
			'P0',
			'priority::high',
			'priority::medium',
			'priority::low',
		]);
	});

	it('names no priority label when the priorities of the project are not known', () => {
		const s = settings();

		expect(priorityLabelsWanted(contextOf(s, null))).toEqual([]);
	});
});
