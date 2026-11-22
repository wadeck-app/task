// `updatedAt` of a summary on GitHub: the `updated_at` of the issue (any edit, label, state or comment moves it; measured: a relation
// such as a sub-issue or a dependency does NOT, so a link change leaves it as it was, see the fake server).
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

describe('updatedAt on GitHub', () => {
	it('a summary carries the updated_at of its issue as an ISO instant', async () => {
		const number = fake.addIssue({ title: 'an issue' });

		const [summary] = await t.backend.list();

		expect(summary!.updatedAt).toBe(new Date(fake.issues.get(number)!.updatedAt).toISOString());
		expect(summary!.updatedAt! >= summary!.createdAt).toBe(true);
	});
});
