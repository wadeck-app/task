// `task labels sync` on the gitlab backend: the labels the configuration needs are created in the project with a colour and a
// description; nothing is deleted or changed. The fake is modelled on docs.gitlab.com (a project label needs a name AND a colour).
import { FakeGitLab } from './fakeGitLab.testkit.js';
import { WRITE_STATUSES, makeGitLabBackend, writeStatusMap } from './gitlabBackend.testkit.js';
import type { TestBackend } from './gitlabBackend.testkit.js';
import type { GitLabTier } from './gitlabOptions.js';

let fake: FakeGitLab;
let t: TestBackend;

async function start(tier: GitLabTier, fills = {}) {
	fake = await FakeGitLab.start({ tier });
	t = makeGitLabBackend(fake, {
		tier,
		statuses: WRITE_STATUSES,
		projectTypes: ['bug', 'feature'],
		options: { statusMap: writeStatusMap(tier) },
		fills,
	});
}

afterEach(async () => {
	await fake.stop();
});

describe('syncLabels', () => {
	it('a dry run reports and sends no write', async () => {
		await start('free');

		const report = await t.backend.syncLabels({ dryRun: true });

		expect(report.dryRun).toBe(true);
		expect(report.created).toEqual([
			'status:in-progress',
			'status:review',
			'status:cancelled',
			'status:duplicate',
			'type:bug',
			'type:feature',
		]);
		expect(report.existing).toEqual([]);
		expect(fake.writes()).toEqual([]);
		expect(fake.projectLabels()).toEqual([]);
	});

	it('creates the missing labels with a colour and a description, in config order, and leaves the existing ones alone', async () => {
		await start('free');
		fake.seedLabel('status:review', '#123456', 'mine');

		const report = await t.backend.syncLabels({});

		expect(report.existing).toEqual(['status:review']);
		expect(report.created).toEqual([
			'status:in-progress',
			'status:cancelled',
			'status:duplicate',
			'type:bug',
			'type:feature',
		]);
		const labels = fake.projectLabels();
		expect(labels.find(label => label.name === 'status:review')).toMatchObject({
			color: '#123456',
			description: 'mine',
		});
		expect(labels.find(label => label.name === 'type:bug')).toMatchObject({
			color: '#a2eeef',
			description: 'Task type (set by the task tool)',
		});
		expect(fake.writes().map(request => request.method)).toEqual(['POST', 'POST', 'POST', 'POST', 'POST']);
		// running it again creates nothing
		const again = await t.backend.syncLabels({});
		expect(again.created).toEqual([]);
		expect(again.existing).toHaveLength(6);
	});

	it('creates the scoped labels on premium and the tombstone label with its fill, and says meta labels come on demand', async () => {
		await start('premium', {
			delete: { use: 'tombstone', fidelity: 'degrade' },
			meta: { use: 'labels', fidelity: 'strict' },
		});

		const report = await t.backend.syncLabels({});

		expect(report.created).toContain('status::in-progress');
		expect(report.created).toContain('task:deleted');
		expect(report.notes.join(' ')).toContain('meta::<key>::<value>');
		expect(fake.projectLabels().map(label => label.name)).toContain('task:deleted');
	});

	it('counts a label that exists case-insensitively as existing instead of creating a duplicate', async () => {
		await start('free');
		fake.seedLabel('STATUS:IN-PROGRESS');

		const report = await t.backend.syncLabels({});

		expect(report.existing).toEqual(['status:in-progress']);
		expect(fake.projectLabels().filter(label => label.name.toLowerCase() === 'status:in-progress')).toHaveLength(1);
	});
});
