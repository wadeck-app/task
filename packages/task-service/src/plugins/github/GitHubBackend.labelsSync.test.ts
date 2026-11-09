// `task labels sync` on the backend: creates the labels the configuration needs, never deletes one.
import { FakeGitHub } from './fakeGitHub.testkit.js';
import { WRITE_STATUS_MAP, WRITE_STATUSES, makeGitHubBackend } from './githubBackend.testkit.js';
import type { TestBackend } from './githubBackend.testkit.js';

let fake: FakeGitHub;

beforeEach(async () => {
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
});

afterEach(async () => {
	await fake.stop();
});

function make(extra: Parameters<typeof makeGitHubBackend>[1] = {}): TestBackend {
	return makeGitHubBackend(fake, {
		statuses: WRITE_STATUSES,
		projectTypes: ['bug', 'feature'],
		...extra,
		options: { statusMap: WRITE_STATUS_MAP, ...extra.options },
	});
}

const created = (): string[] => fake.writes().map(request => (request.body as { name: string }).name);

describe('syncLabels', () => {
	it('creates the status labels and the type labels the configuration uses, with a colour and a description', async () => {
		const report = await make().backend.syncLabels({});

		expect(report.created).toEqual(['status:in-progress', 'status:review', 'type:bug', 'type:feature']);
		expect(report.existing).toEqual([]);
		expect(report.dryRun).toBe(false);
		expect(created()).toEqual(['status:in-progress', 'status:review', 'type:bug', 'type:feature']);
		for (const request of fake.writes()) {
			expect(request.body).toMatchObject({
				color: expect.stringMatching(/^[0-9a-f]{6}$/),
				description: expect.any(String),
			});
		}
		expect([...fake.repoLabels.keys()]).toEqual([
			'status:in-progress',
			'status:review',
			'type:bug',
			'type:feature',
		]);
	});

	it('a second run creates nothing and lists what exists, whatever the case of the label on GitHub', async () => {
		const t = make();
		await t.backend.syncLabels({});
		fake.repoLabels.delete('type:bug');
		fake.addRepoLabel('Type:Bug');
		fake.requests.length = 0;

		const report = await t.backend.syncLabels({});

		expect(report.created).toEqual([]);
		expect(report.existing).toEqual(['status:in-progress', 'status:review', 'type:bug', 'type:feature']);
		expect(fake.writes()).toEqual([]);
	});

	it('creates only the missing ones and never deletes or touches a label it does not know', async () => {
		fake.addRepoLabel('status:review', 'ff0000');
		fake.addRepoLabel('bug', '000000');

		const report = await make().backend.syncLabels({});

		expect(report.created).toEqual(['status:in-progress', 'type:bug', 'type:feature']);
		expect(report.existing).toEqual(['status:review']);
		expect(fake.writes().every(request => request.method === 'POST')).toBe(true);
		expect(fake.repoLabels.get('bug')).toBe('000000');
		expect(fake.repoLabels.get('status:review')).toBe('ff0000');
	});

	it('--dry-run lists what it would create and sends nothing', async () => {
		const report = await make().backend.syncLabels({ dryRun: true });

		expect(report.dryRun).toBe(true);
		expect(report.created).toEqual(['status:in-progress', 'status:review', 'type:bug', 'type:feature']);
		expect(fake.writes()).toEqual([]);
		expect(fake.repoLabels.size).toBe(0);
	});

	it('follows typeMap: a type mapped to a native issue type needs no label, one mapped to a label uses it', async () => {
		const report = await make({
			options: { typeMap: { bug: { issueType: 'Bug' }, feature: { label: 'kind/feature' } } },
		}).backend.syncLabels({});

		expect(report.created).toEqual(['status:in-progress', 'status:review', 'kind/feature']);
	});

	it('adds task:deleted when the project deletes by tombstone, and says why each label is wanted', async () => {
		const report = await make({
			fills: { delete: { use: 'tombstone', fidelity: 'degrade' } },
			fidelity: 'degrade',
		}).backend.syncLabels({ dryRun: true });

		expect(report.created).toContain('task:deleted');
		expect(report.wanted.find(label => label.name === 'task:deleted')).toMatchObject({ kind: 'deleted' });
		expect(report.wanted.find(label => label.name === 'status:review')).toMatchObject({
			kind: 'status',
			why: 'status "review"',
		});
		expect(report.wanted.find(label => label.name === 'type:bug')).toMatchObject({
			kind: 'type',
			why: 'type "bug"',
		});
	});

	it('explains that meta labels are created when a value is set, since their names depend on the data', async () => {
		const report = await make({ fills: { meta: { use: 'labels', fidelity: 'strict' } } }).backend.syncLabels({
			dryRun: true,
		});

		expect(report.notes.join(' ')).toContain('meta:');
	});

	it('a repository with more labels than one page is read to the end', async () => {
		for (let i = 0; i < 130; i++) fake.addRepoLabel(`other-${i}`);

		const report = await make().backend.syncLabels({ dryRun: true });

		expect(report.created).toEqual(['status:in-progress', 'status:review', 'type:bug', 'type:feature']);
	});
});
