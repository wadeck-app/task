import { BackendRejectedError } from '@wadeck-app/task-core';

import { FakeGitHub } from './fakeGitHub.testkit.js';
import { GitHubClient } from './githubClient.js';
import type { PrioritySettings } from './githubOptions.js';
import { createPriorityContext } from './githubPriority.js';
import type { PriorityContext } from './githubPriority.js';
import {
	FIELDS_API_VERSION,
	PriorityResolver,
	RESOLUTION_MEMORY_MS,
	parseDefinitions,
} from './githubPriorityStorage.js';
import { MemoryResponseCache } from './responseCache.js';

let fake: FakeGitHub;

afterEach(async () => {
	await fake.stop();
});

const FIELDS = [
	{ id: 501, name: 'Priority', options: ['Urgent', 'High', 'Medium', 'Low'] },
	{ id: 502, name: 'Area', options: ['Backend'] },
];

function settings(extra: Partial<PrioritySettings> = {}): PrioritySettings {
	return { storage: 'auto', fieldName: 'Priority', prefix: 'priority:', map: {}, ...extra };
}

function resolver(
	prioritySettings: PrioritySettings,
	owner = 'acme'
): { resolver: PriorityResolver; client: GitHubClient; context: PriorityContext } {
	const client = new GitHubClient({
		baseUrl: fake.baseUrl,
		token: fake.token,
		repo: 'acme/shop',
		tokenHint: 'the variable GITHUB_TOKEN',
		timeoutMs: 2000,
		cacheTtlMs: 0,
		cache: new MemoryResponseCache(),
	});
	const context = createPriorityContext(prioritySettings, undefined);
	return {
		resolver: new PriorityResolver({ client, settings: prioritySettings, owner, baseUrl: fake.baseUrl, context }),
		client,
		context,
	};
}

const definitionRequests = (): number => fake.requests.filter(request => request.path.endsWith('/issue-fields')).length;

describe('PriorityResolver', () => {
	it('priorityStorage: label never asks anything', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS, issueFieldDefinitions: 'readable' });
		const { resolver: r } = resolver(settings({ storage: 'label' }));

		const resolution = await r.resolve();

		expect(resolution).toMatchObject({ storage: 'label', definitions: { kind: 'not-read' } });
		expect(fake.requests).toEqual([]);
	});

	it('priorityFieldId set is the field with no request, and the context reads the field from then on', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS });
		const { resolver: r, context } = resolver(settings({ fieldId: 501 }));

		const resolution = await r.resolve();

		expect(resolution).toMatchObject({ storage: 'field', field: { id: 501, name: 'Priority' } });
		expect(resolution.field?.options).toBeUndefined();
		expect(context.storage).toBe('field');
		expect(fake.requests).toEqual([]);
		expect(definitionRequests()).toBe(0);
	});

	it('auto with readable definitions finds the field by name, case-insensitively, with its id and options; one request, once', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS, issueFieldDefinitions: 'readable' });
		const { resolver: r } = resolver(settings({ fieldName: 'priority' }));

		const first = await r.resolve();
		const second = await r.resolve();

		expect(first).toBe(second);
		expect(first).toMatchObject({
			storage: 'field',
			field: { id: 501, name: 'Priority', options: ['Urgent', 'High', 'Medium', 'Low'] },
			definitions: { kind: 'read', fields: 2 },
		});
		expect(first.reason).toContain('id 501');
		expect(definitionRequests()).toBe(1);
		expect(fake.requests[0]!.apiVersion).toBe(FIELDS_API_VERSION);
		expect(r.current()).toBe(first);
	});

	it('auto with definitions the token may not read falls back to labels and says why, with the fix', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS });
		const { resolver: r, client } = resolver(settings());

		const resolution = await r.resolve();

		expect(resolution.storage).toBe('label');
		expect(resolution.definitions).toEqual({ kind: 'forbidden', accepted: 'issue_fields=read' });
		expect(resolution.reason).toContain('the token lacks the organization permission "Issue fields: Read"');
		expect(resolution.reason).toContain('issue_fields=read');
		expect(resolution.fix).toContain('priorityFieldId');
		expect(resolution.fix).toContain('UNVERIFIED');
		// Labels: the client keeps the default API version.
		await client.get('/repos/acme/shop/issues');
		expect(fake.requests.at(-1)!.apiVersion).toBe('2022-11-28');
	});

	it('auto with an owner that has no such route (not an organization) falls back to labels', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS, issueFieldDefinitions: 'readable' });
		const { resolver: r } = resolver(settings(), 'some-user');

		const resolution = await r.resolve();

		expect(resolution).toMatchObject({ storage: 'label', definitions: { kind: 'not-found' } });
		expect(resolution.reason).toContain('some-user is not an organization');
	});

	it('auto with readable definitions but no field of that name falls back to labels and lists the fields it saw', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS, issueFieldDefinitions: 'readable' });
		const { resolver: r } = resolver(settings({ fieldName: 'Urgency' }));

		const resolution = await r.resolve();

		expect(resolution.storage).toBe('label');
		expect(resolution.reason).toContain('no single-select issue field named "Urgency" (it has: Priority, Area)');
		expect(resolution.fix).toContain('priorityFieldName');
	});

	it('priorityStorage: field with definitions it cannot read fails loudly with the fix, and asks again next time', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS });
		const { resolver: r } = resolver(settings({ storage: 'field' }));

		const error = await r.resolve().catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect((error as BackendRejectedError).message).toContain(
			'priorityStorage: field needs the issue field "Priority"'
		);
		expect((error as BackendRejectedError).hint).toContain('priorityFieldId');
		await r.resolve().catch(() => undefined);
		expect(definitionRequests()).toBe(2);
		expect(r.current()).toBeUndefined();
	});
});

describe('parseDefinitions', () => {
	it('keeps the single-select fields with their ids and options and skips the others', () => {
		expect(
			parseDefinitions([
				{
					id: 'IFSS_1',
					full_database_id: 1,
					name: 'Priority',
					data_type: 'SINGLE_SELECT',
					options: [{ name: 'A' }],
				},
				{ id: 'IFN_2', full_database_id: 2, name: 'Effort', data_type: 'NUMBER' },
			])
		).toEqual([{ id: 1, name: 'Priority', options: ['A'] }]);
	});

	it.each([
		[{}, 'not a list'],
		[[null], 'an entry is not an object'],
		[[{ data_type: 'SINGLE_SELECT' }], 'an entry has no name'],
		[[{ name: 'P' }], 'the field "P" has no data_type'],
		[[{ name: 'P', data_type: 'SINGLE_SELECT', id: 'IFSS_1' }], 'the field "P" has no numeric full_database_id'],
		[[{ name: 'P', data_type: 'SINGLE_SELECT', full_database_id: 1 }], 'the field "P" has no options list'],
		[
			[{ name: 'P', data_type: 'SINGLE_SELECT', full_database_id: 1, options: [{}] }],
			'an option of the field "P" has no name',
		],
	])('says what is wrong with a shape it does not understand: %j', (body, text) => {
		expect(parseDefinitions(body)).toBe(text);
	});
});

describe('PriorityResolver: the memory shared by the processes', () => {
	function withMemory(
		prioritySettings: PrioritySettings,
		cache: MemoryResponseCache,
		clock: { ms: number }
	): PriorityResolver {
		const { client } = resolver(prioritySettings);
		return new PriorityResolver({
			client,
			settings: prioritySettings,
			owner: 'acme',
			baseUrl: fake.baseUrl,
			context: createPriorityContext(prioritySettings, undefined),
			cache,
			now: () => clock.ms,
		});
	}

	it('a second process inside the memory time asks nothing and still switches to the field API version; strategy check asks again', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS, issueFieldDefinitions: 'readable' });
		const cache = new MemoryResponseCache();
		const clock = { ms: Date.parse('2026-11-14T10:00:00Z') };

		const first = await withMemory(settings(), cache, clock).resolve();
		clock.ms += RESOLUTION_MEMORY_MS - 1000;
		const second = withMemory(settings(), cache, clock);
		const remembered = await second.resolve();

		expect(remembered).toEqual(first);
		expect(definitionRequests()).toBe(1);
		const third = await withMemory(settings(), cache, clock).resolve({ fresh: true });
		expect(third).toEqual(first);
		expect(definitionRequests()).toBe(2);
	});

	it('is asked again once the memory time has passed, and a fallback to labels is remembered too', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS });
		const cache = new MemoryResponseCache();
		const clock = { ms: Date.parse('2026-11-14T10:00:00Z') };

		await withMemory(settings(), cache, clock).resolve();
		expect((await withMemory(settings(), cache, clock).resolve()).storage).toBe('label');
		expect(definitionRequests()).toBe(1);
		clock.ms += RESOLUTION_MEMORY_MS;
		await withMemory(settings(), cache, clock).resolve();
		expect(definitionRequests()).toBe(2);
	});

	it('a resolution that needed no request is not remembered', async () => {
		fake = await FakeGitHub.start({ repo: 'acme/shop', issueFields: FIELDS });
		const cache = new MemoryResponseCache();

		await withMemory(settings({ fieldId: 501 }), cache, { ms: 0 }).resolve();
		await withMemory(settings({ storage: 'label' }), cache, { ms: 0 }).resolve();

		expect(cache.get('task:priority-resolution:acme:auto:Priority')).toBeUndefined();
	});
});
