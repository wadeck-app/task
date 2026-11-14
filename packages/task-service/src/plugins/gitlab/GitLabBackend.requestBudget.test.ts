// What a dispatch read costs on GitLab: the priority (a label) and the assignee and lease (the managed block of the description) are
// in the answer of the issue list, so listing N issues is ONE list request per 100 issues and no request per issue.
import { FakeGitLab } from './fakeGitLab.testkit.js';
import { WRITE_STATUSES, makeGitLabBackend, writeStatusMap } from './gitlabBackend.testkit.js';
import type { TestBackend } from './gitlabBackend.testkit.js';

let fake: FakeGitLab;
let t: TestBackend;

const P = '/projects/42';
const END = '2026-11-14T10:30:00.000Z';
const claimBlock = (name: string): string =>
	`<!-- task:begin v1 -->{"claim":{"assignee":"${name}","claimedAt":"2026-11-14T10:00:00.000Z","leaseUntil":"${END}"}}<!-- task:end -->`;

beforeEach(async () => {
	fake = await FakeGitLab.start();
	t = makeGitLabBackend(fake, {
		statuses: WRITE_STATUSES,
		options: { statusMap: writeStatusMap() },
	});
});

afterEach(async () => {
	await fake.stop();
});

const reads = (): string[] =>
	fake.requests.filter(request => request.method === 'GET').map(request => request.path.replace(P, ''));

describe('listing carries the priority, the assignee and the lease', () => {
	it('150 issues cost 2 list requests (100 per page) and no request per issue; every row has its fields', async () => {
		for (let index = 1; index <= 150; index++) {
			fake.seedIssue({
				title: `Task ${index}`,
				labels: index % 3 === 0 ? ['priority:high'] : index % 3 === 1 ? ['priority:low', 'frontend'] : [],
				...(index % 2 === 0 ? { description: `Text ${index}\n\n${claimBlock(`worker-${index}`)}` } : {}),
			});
		}
		fake.requests.length = 0;

		const list = await t.backend.list();

		expect(list).toHaveLength(150);
		expect(reads()).toEqual(['/issues', '/issues']);
		expect(reads().some(path => /^\/issues\/\d+/.test(path))).toBe(false);
		const row = (index: number) => list.find(task => task.id === String(index))!;
		expect(row(3)).toMatchObject({ priority: 'high' });
		expect(row(3).assignee).toBeUndefined();
		expect(row(2)).toMatchObject({ assignee: 'worker-2', leaseUntil: END });
		expect(row(2).priority).toBeUndefined();
		expect(row(6)).toMatchObject({ priority: 'high', assignee: 'worker-6', leaseUntil: END });
		expect(row(7)).toMatchObject({ priority: 'low' });
		expect(list.filter(task => task.assignee !== undefined)).toHaveLength(75);
		expect(list.filter(task => task.priority === 'high')).toHaveLength(50);
	});

	it('a page of listPage with a limit reads one list request and carries the same fields', async () => {
		for (let index = 1; index <= 30; index++) {
			fake.seedIssue({ title: `Task ${index}`, labels: ['priority:medium'], description: claimBlock('w') });
		}
		fake.requests.length = 0;

		const page = await t.backend.listPage({ limit: 10 });

		expect(page.items).toHaveLength(10);
		expect(page.items.every(task => task.priority === 'medium' && task.assignee === 'w')).toBe(true);
		expect(reads()).toEqual(['/issues']);
	});

	it('a priority or a claim written through the backend is visible in the next list without a read per issue', async () => {
		const first = fake.seedIssue({ title: 'a' });
		const second = fake.seedIssue({ title: 'b' });
		await t.backend.setPriority!(String(first), 'urgent');
		await t.backend.claim!(String(second), { assignee: 'w1', leaseUntil: END, now: '2026-11-14T10:00:00.000Z' });
		fake.requests.length = 0;

		const list = await t.backend.list();

		expect(list.find(task => task.id === '1')).toMatchObject({ priority: 'urgent' });
		expect(list.find(task => task.id === '2')).toMatchObject({ assignee: 'w1', leaseUntil: END });
		expect(reads()).toEqual(['/issues']);
	});
});
