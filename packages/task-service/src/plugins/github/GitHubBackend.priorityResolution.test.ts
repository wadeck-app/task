// Where the priority lives is decided without making a read depend on a network call it does not need: explicit settings first, then
// what an earlier command remembered (any age), and only a priority label as a sign that the question is worth a request. The API
// version of the issue fields goes only on the requests that need it. See githubPriorityStorage.ts.
import { FakeGitHub } from './fakeGitHub.testkit.js';
import { WRITE_STATUS_MAP, WRITE_STATUSES, makeGitHubBackend } from './githubBackend.testkit.js';
import type { TestBackend } from './githubBackend.testkit.js';
import { priorityOf } from './issueMapping.js';
import type { ApiIssue, MapContext } from './issueMapping.js';
import { FIELDS_API_VERSION } from './githubPriorityStorage.js';
import { createPriorityContext } from './githubPriority.js';
import { parseGitHubOptions } from './githubOptions.js';
import { MemoryResponseCache } from './responseCache.js';

let fake: FakeGitHub;

const FIELDS = [{ id: 501, name: 'Priority', options: ['Urgent', 'High', 'Medium', 'Low'] }];
const DEFAULT_VERSION = '2022-11-28';
// With only the id of the field its options are not known: the map says how the options are spelled.
const MAP = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };

function make(extra: Parameters<typeof makeGitHubBackend>[1] = {}): TestBackend {
	return makeGitHubBackend(fake, {
		statuses: WRITE_STATUSES,
		projectTypes: ['bug'],
		...extra,
		options: { statusMap: WRITE_STATUS_MAP, ...extra.options },
	});
}

afterEach(async () => {
	await fake.stop();
});

const paths = (): string[] =>
	fake.requests.map(request => `${request.method} ${request.path.replace('/repos/acme/shop', '')}`);
const orgRequests = (): number => fake.requests.filter(request => request.path.startsWith('/orgs/')).length;

describe('the API version goes only on the requests that need it (field storage)', () => {
	beforeEach(async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS, issueFieldDefinitions: 'readable' });
	});

	it('the issue, the list and the issue-field-values carry 2026-03-10; the timeline, comments, sub-issues, dependencies and labels keep 2022-11-28', async () => {
		const t = make({ options: { priorityStorage: 'field', priorityFieldId: 501, priorityMap: MAP } });
		const parent = fake.addIssue({ title: 'parent' });
		const child = fake.addIssue({ title: 'child' });
		fake.setParent(child, parent);
		fake.addBlockedBy(child, parent);
		fake.addComment(child, 'a comment');
		fake.requests.splice(0);

		await t.backend.list();
		await t.backend.get(String(child));
		await t.backend.getChildren!(String(parent));
		await t.backend.setPriority!(String(child), 'high');
		await t.backend.addLabel(String(child), 'billing');

		const version = (prefix: RegExp, method = 'GET'): Array<string | undefined> =>
			fake.requests
				.filter(request => request.method === method && prefix.test(request.path))
				.map(request => request.apiVersion);
		expect(version(/\/issues$/)).toEqual([FIELDS_API_VERSION]);
		expect(new Set(version(/\/issues\/\d+$/))).toEqual(new Set([FIELDS_API_VERSION]));
		expect(version(/\/issue-field-values$/, 'POST')).toEqual([FIELDS_API_VERSION]);
		for (const kind of [/\/timeline/, /\/comments/, /\/sub_issues/, /\/dependencies\//, /\/labels/]) {
			const seen = version(kind);
			expect(seen.length, String(kind)).toBeGreaterThan(0);
			expect(new Set(seen), String(kind)).toEqual(new Set([DEFAULT_VERSION]));
		}
		expect(new Set(version(/\/labels/, 'POST'))).toEqual(new Set([DEFAULT_VERSION]));
	});

	it('label storage never sends the fields version', async () => {
		const t = make({ options: { priorityStorage: 'label' } });
		const a = fake.addIssue({ title: 'a' });

		await t.backend.setPriority!(String(a), 'high');
		await t.backend.list();

		expect(new Set(fake.requests.map(request => request.apiVersion))).toEqual(new Set([DEFAULT_VERSION]));
	});
});

describe('a read does not wait for the question of where the priority lives', () => {
	beforeEach(async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS });
	});

	it('auto, nothing remembered, no sign of a priority in the issues: no request about it and no priority', async () => {
		const t = make({ options: { priorityStorage: 'auto' } });
		fake.addIssue({ title: 'plain' });
		fake.requests.splice(0);

		const tasks = await t.backend.list();

		expect(tasks.map(task => task.priority)).toEqual([undefined]);
		expect(orgRequests()).toBe(0);
		expect(paths()).toEqual(['GET /issues']);
	});

	it('auto, a priority label is the sign: it is asked once; a refusal (403) reads as label storage', async () => {
		const t = make({ options: { priorityStorage: 'auto' } });
		fake.addIssue({ title: 'labelled', labels: ['priority:high'] });

		const tasks = await t.backend.list();
		await t.backend.list();

		expect(tasks.map(task => task.priority)).toEqual(['high']);
		expect(orgRequests()).toBe(1);
	});

	it('the question failing (unreachable) does not fail the read: label storage for this read and a notice with the reason', async () => {
		const t = make({ options: { priorityStorage: 'auto' } });
		fake.addIssue({ title: 'labelled', labels: ['priority:high'] });
		fake.failNext({ status: 502, pathPrefix: '/orgs/' });

		const tasks = await t.backend.list();

		expect(tasks.map(task => task.priority)).toEqual(['high']);
		const notice = t.notices.find(entry => entry.text.includes('priority storage could not be resolved'));
		expect(notice?.text).toMatch(/502|unreachable|reach/i);
		// One attempt per process: the next read does not ask again.
		await t.backend.list();
		expect(orgRequests()).toBe(1);
	});

	it('what was remembered is used at any age, with no request', async () => {
		await fake.stop();
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS, issueFieldDefinitions: 'readable' });
		const cache = new MemoryResponseCache();
		const first = make({ options: { priorityStorage: 'auto' }, cache });
		const a = fake.addIssue({ title: 'a' });
		fake.setIssueField(a, 'Priority', 'High');
		await first.resolver.resolve({ fresh: true });
		// An hour later: the write path would ask again, a read does not.
		const entry = [...cacheEntries(cache)][0]!;
		cache.put({ ...entry, cachedAt: new Date(Date.now() - 3_600_000).toISOString() });
		const second = make({ options: { priorityStorage: 'auto' }, cache });
		fake.requests.splice(0);

		const tasks = await second.backend.list();

		expect(tasks.map(task => task.priority)).toEqual(['high']);
		expect(orgRequests()).toBe(0);
		expect(fake.requests[0]!.apiVersion).toBe(FIELDS_API_VERSION);
	});

	it('explicit settings never ask: label, and a field id', async () => {
		const label = make({ options: { priorityStorage: 'label' } });
		const field = make({ options: { priorityStorage: 'field', priorityFieldId: 501, priorityMap: MAP } });
		const a = fake.addIssue({ title: 'a' });
		fake.setIssueField(a, 'Priority', 'Low');
		fake.requests.splice(0);

		await label.backend.list();
		const tasks = await field.backend.list();

		expect(orgRequests()).toBe(0);
		expect(tasks.map(task => task.priority)).toEqual(['low']);
	});

	it('a write that needs the answer still fails loudly when it cannot get it', async () => {
		const t = make({ options: { priorityStorage: 'auto' } });
		const a = fake.addIssue({ title: 'a' });
		fake.failNext({ status: 502, pathPrefix: '/orgs/' });

		await expect(t.backend.setPriority!(String(a), 'high')).rejects.toThrow();
		expect(fake.writes()).toEqual([]);
	});
});

/** The entries of a memory cache (test helper: the cache has no listing). */
function* cacheEntries(cache: MemoryResponseCache): Iterable<ReturnType<MemoryResponseCache['get']> & object> {
	const entry = cache.get(`task:priority-resolution:${fake.baseUrl}:acme:auto:-:Priority`);
	if (entry !== undefined) yield entry;
}

describe('a fallback to labels is loud on a write and quiet on a read', () => {
	beforeEach(async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS });
	});

	it('every priority write resolved through the fallback warns once, with the reason and the fix; a read says nothing more', async () => {
		const t = make({ options: { priorityStorage: 'auto' } });
		const a = fake.addIssue({ title: 'a' });

		await t.backend.setPriority!(String(a), 'high');
		const afterSet = t.notices.filter(entry =>
			entry.text.includes('priority stored as label priority:high')
		).length;
		await t.backend.clearPriority!(String(a));
		await t.backend.list();

		expect(afterSet).toBe(1);
		const text = t.notices.find(entry => entry.text.includes('priority stored as label priority:high'))!.text;
		expect(text).toContain('because the native issue field is not usable');
		expect(text).toContain('Fix:');
		expect(text).toContain('Issue fields: Read');
		expect(t.notices.filter(entry => entry.text.includes('priority stored as label')).length).toBe(2);
		expect(t.notices.find(entry => entry.text.includes('priority stored as label'))!.kind).toBe('emulated');
	});

	it('an explicit label storage warns about nothing', async () => {
		const t = make({ options: { priorityStorage: 'label' } });
		const a = fake.addIssue({ title: 'a' });

		await t.backend.setPriority!(String(a), 'high');

		expect(t.notices).toEqual([]);
	});
});

describe('the memory of the resolution follows the configuration', () => {
	beforeEach(async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS });
	});

	it('fall back, then add priorityFieldId: the next command uses the field at once', async () => {
		const cache = new MemoryResponseCache();
		const before = make({ options: { priorityStorage: 'auto' }, cache });
		const a = fake.addIssue({ title: 'a' });
		await before.backend.setPriority!(String(a), 'high');
		expect(fake.issues.get(a)!.labels).toEqual(['priority:high']);

		const after = make({ options: { priorityStorage: 'auto', priorityFieldId: 501, priorityMap: MAP }, cache });
		await after.backend.setPriority!(String(a), 'low');

		expect(fake.fieldValuesOf(a)).toEqual({ Priority: 'Low' });
	});

	it('another field name, another owner address, another storage are other memories', async () => {
		const cache = new MemoryResponseCache();
		const one = make({ options: { priorityStorage: 'auto' }, cache });
		await one.resolver.resolve({ fresh: true });
		const orgBefore = orgRequests();

		const other = make({ options: { priorityStorage: 'auto', priorityFieldName: 'Urgency' }, cache });
		await other.resolver.resolve();

		expect(orgRequests()).toBe(orgBefore + 1);
	});
});

describe('which labels are reserved follows the resolved storage', () => {
	beforeEach(async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS, issueFieldDefinitions: 'readable' });
	});

	it('field storage: High and "priority: low" are ordinary labels', async () => {
		const t = make({ options: { priorityStorage: 'field', priorityFieldId: 501, priorityMap: MAP } });
		const a = fake.addIssue({ title: 'a', labels: ['High', 'priority: low', 'priority:medium'] });

		const record = await t.backend.get(String(a));

		expect(record.labels).toEqual(['High', 'priority: low', 'priority:medium']);
	});

	it('label storage and an unresolved auto keep the reservation', async () => {
		const label = make({ options: { priorityStorage: 'label' } });
		const auto = make({ options: { priorityStorage: 'auto' } });
		const a = fake.addIssue({ title: 'a', labels: ['priority:high', 'billing'] });
		// The question fails: the read goes on with labels, which stay reserved.
		fake.failNext({ status: 502, pathPrefix: '/orgs/' });

		expect((await label.backend.get(String(a))).labels).toEqual(['billing']);
		expect((await auto.backend.get(String(a))).labels).toEqual(['billing']);
	});
});

describe('the notices of an unreadable value are not repeated', () => {
	it('one notice per distinct text, whatever the number of reads', () => {
		const parsed = parseGitHubOptions({
			repo: 'acme/shop',
			tokenEnv: 'GITHUB_TOKEN',
			statusMap: { backlog: { state: 'open' } },
			priorityStorage: 'label',
		});
		if ('problem' in parsed) throw new Error(parsed.problem);
		const notices: string[] = [];
		const ctx = {
			settings: parsed.settings,
			priority: createPriorityContext(parsed.settings.priority, ['high', 'low']),
			notice: (entry: { text: string }) => notices.push(entry.text),
			issueUrl: (number: number) => `https://github.com/acme/shop/issues/${number}`,
		} as unknown as MapContext;
		const issue = { number: 3, labels: [{ name: 'priority:bogus' }] } as unknown as ApiIssue;

		priorityOf(issue, ctx);
		priorityOf(issue, ctx);
		priorityOf({ ...issue, number: 4 } as ApiIssue, ctx);

		expect(notices).toHaveLength(2);
	});
});
