import type { MigrationTaskFacts } from '@wadeck-app/task-core';

import { githubCostModel } from './githubCostModel.js';
import { parseGitHubOptions } from './githubOptions.js';
import { TEST_STATUS_MAP } from './githubBackend.testkit.js';
import type { DeclaredFills } from '../kinds.js';

// The cost model of a migration into GitHub: the writes (requests that change GitHub) and the requests the plan implies, counted from what
// the code does (see GitHubBackend.requestBudget.test.ts and migrateGithubCost.test.ts, which pin the same numbers on the fake server).
function model(extra: Record<string, unknown> = {}, fills: DeclaredFills = BLOCK) {
	const parsed = parseGitHubOptions({
		repo: 'acme/shop',
		tokenEnv: 'GITHUB_TOKEN',
		statusMap: TEST_STATUS_MAP,
		priorityStorage: 'label',
		...extra,
	});
	if ('problem' in parsed) throw new Error(parsed.problem);
	return githubCostModel(parsed.settings, fills);
}

const BLOCK: DeclaredFills = { meta: { use: 'body-block', fidelity: 'degrade' } };

function task(facts: Partial<MigrationTaskFacts> = {}): MigrationTaskFacts {
	return {
		state: 'new',
		status: 'backlog',
		hasParent: false,
		labels: [],
		meta: {},
		marker: true,
		links: [],
		comments: 0,
		...facts,
	};
}

describe('githubCostModel', () => {
	it('a plain open task is one write (the create carries the marker), its read-back and one check read', () => {
		expect(model()([task()])).toMatchObject({ writes: 1, requests: 3 + 1, verifyRequests: 1 });
	});

	it('a closed task adds the close; a task with a parent adds the attach and the parent read', () => {
		expect(model()([task({ status: 'done' })])).toMatchObject({ writes: 2, requests: 3 + 1 + 1 });
		expect(model()([task({ hasParent: true })])).toMatchObject({ writes: 2, requests: 3 + 2 + 1 });
	});

	it('type, labels, a priority label and the metadata ride in the create: their only cost is creating the labels that do not exist yet', () => {
		const full = task({ type: 'bug', labels: ['planning'], priority: 'high', meta: { owner: 'ann' } });

		const one = model()([full]);
		const two = model()([full, full]);

		// Three labels to create (type, plain, priority), counted as new: one write and a probe + a create request each.
		expect(one.writes).toBe(1 + 3);
		expect(one.requests).toBe(3 + 3 * 2 + 1);
		// The same labels are created once for every task that uses them.
		expect(two.writes).toBe(2 + 3);
	});

	it('the status label of an open status is a label to create too', () => {
		expect(model()([task({ status: 'in-progress' })]).writes).toBe(1 + 1);
	});

	it('what cannot ride in the create is a write of its own, with the re-read before and the read after (4 requests): a native issue type, a priority in the issue field, an assignee', () => {
		const typed = model({ typeMap: { bug: { issueType: 'Bug' } } })([task({ type: 'bug' })]);
		const field = model({ priorityStorage: 'field', priorityFieldId: 7 })([task({ priority: 'high' })]);
		const assigned = model()([task({ assignee: 'ann' })]);

		expect(typed).toMatchObject({ writes: 2, requests: 3 + 4 + 1 });
		expect(field).toMatchObject({ writes: 2, requests: 3 + 4 + 1 });
		expect(assigned).toMatchObject({ writes: 2, requests: 3 + 4 + 1 });
	});

	it('a priority with priorityStorage: auto is counted as a write of its own, and the note says it may ride in the create', () => {
		const result = model({ priorityStorage: 'auto' })([task({ priority: 'high' })]);

		expect(result.writes).toBe(2);
		expect(result.notes.join(' ')).toMatch(/priorityStorage: auto/);
	});

	it('metadata kept as labels costs a label per task (the marker is unique), body-block costs nothing', () => {
		const labels = model({}, { meta: { use: 'labels', fidelity: 'strict' } })([task(), task(), task()]);

		expect(labels.writes).toBe(3 + 3);
		expect(model()([task(), task(), task()]).writes).toBe(3);
	});

	it('a task with no metadata on the target (no marker, no fill) has nothing to write beyond the create', () => {
		expect(model({}, {})([task({ marker: false })])).toMatchObject({ writes: 1 });
	});

	it('a link is one write (7 requests), a comment one write (5 requests): both are read whole by the check', () => {
		const linked = model()([task({ links: ['blockedBy'] })]);
		const commented = model()([task({ comments: 2 })]);

		expect(linked).toMatchObject({ writes: 2, requests: 3 + 7 + (2 + 1) });
		expect(commented).toMatchObject({ writes: 3, requests: 3 + 2 * 5 + (2 + 1) });
		expect(linked.verifyRequests).toBe(3);
	});

	it('a task an earlier run created is not created again: what it lacks is written field by field (an upper bound)', () => {
		const resumed = model()([task({ state: 'resume', phase: 'created', type: 'bug', labels: ['planning'] })]);

		// The marker, the type and the label: three writes of their own.
		expect(resumed.writes).toBe(3);
		expect(resumed.requests).toBe(3 * 4 + 1);
	});

	it('a resumed task costs what its journal phase has left: created = fields, links and comments; fielded = links and comments; linked = comments', () => {
		const rest = { type: 'bug', labels: ['planning'], links: ['blockedBy'], comments: 1 };
		const created = model()([task({ state: 'resume', phase: 'created', ...rest })]);
		const fielded = model()([task({ state: 'resume', phase: 'fielded', ...rest })]);
		const linked = model()([task({ state: 'resume', phase: 'linked', ...rest })]);

		// created: marker + type + label (3 separate writes of 4 requests), the link (7), the comment (5), the whole check (2 + 1 + 1).
		expect(created).toMatchObject({ writes: 3 + 1 + 1, requests: 3 * 4 + 7 + 5 + 4 });
		// fielded: no field write; linked: no link write either.
		expect(fielded).toMatchObject({ writes: 1 + 1, requests: 7 + 5 + 4 });
		expect(linked).toMatchObject({ writes: 1, requests: 5 + 4 });
	});

	it('a resumed task without a phase is an error, not a guess', () => {
		expect(() => model()([task({ state: 'resume' })])).toThrow(/phase/);
	});

	it('a status the statusMap does not know is an error naming it', () => {
		expect(() => model()([task({ status: 'nonsense' })])).toThrow(/status "nonsense".*statusMap/);
	});

	it('metadata (or the marker) with no meta fill is an error, not a free write', () => {
		expect(() => model({}, {})([task({ marker: true })])).toThrow(/metadata/);
		expect(() => model({}, {})([task({ marker: false, meta: { a: 'b' } })])).toThrow(/metadata/);
	});

	it('says in its notes that labels are counted as new', () => {
		expect(model()([task({ type: 'bug' })]).notes.join(' ')).toMatch(/label\(s\) are counted as to be created/);
	});
});
