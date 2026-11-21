// `statusSince` of a summary on GitHub (decision D23): the instant the issue was CLOSED, from `closed_at`; an open issue has none (GitHub
// does not tell when a label status was set, and `updated_at` moves with every edit, so it is not used).
import { FakeGitHub } from './fakeGitHub.testkit.js';
import { WRITE_STATUS_MAP, WRITE_STATUSES, makeGitHubBackend } from './githubBackend.testkit.js';
import type { TestBackend } from './githubBackend.testkit.js';

let fake: FakeGitHub;
let t: TestBackend;

beforeEach(async () => {
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
	t = makeGitHubBackend(fake, { statuses: WRITE_STATUSES, options: { statusMap: WRITE_STATUS_MAP } });
});
afterEach(async () => {
	await fake.stop();
});

describe('statusSince on GitHub', () => {
	it('a closed issue carries its closing instant, an open one carries none', async () => {
		const open = fake.addIssue({ title: 'still open' });
		const closed = fake.addIssue({ title: 'finished' });
		await t.backend.updateStatus(String(closed), 'done');

		const listed = await t.backend.list();

		const byId = new Map(listed.map(summary => [summary.id, summary]));
		expect(byId.get(String(open))).not.toHaveProperty('statusSince');
		const closedAt = fake.issues.get(closed)!.closedAt;
		expect(closedAt).not.toBeNull();
		expect(byId.get(String(closed))!.statusSince).toBe(new Date(closedAt!).toISOString());
	});
});
