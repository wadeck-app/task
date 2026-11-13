// The GraphQL work item calls of the gitlab strategy against a scripted client: what is sent, what is read from the answers recorded on
// gitlab.com Free (fixtures/live-conformance.json) and how a refusal inside an answer becomes a typed error with its hint.
import { BackendDataError, BackendLimitError, BackendRejectedError } from '@wadeck-app/task-core';

import {
	GQL_CONVERT,
	GQL_READ,
	GQL_SET_PARENT,
	GraphqlUnavailableError,
	WORK_ITEM_TYPE_IDS,
	WorkItems,
	isPermissionFailure,
	workItemGid,
} from './gitlabWorkItems.js';
import type { GraphqlClient } from './gitlabWorkItems.js';

interface Sent {
	body: { query: string; variables?: Record<string, unknown> };
	write: boolean | undefined;
}

function scripted(...answers: unknown[]): { client: GraphqlClient; sent: Sent[] } {
	const sent: Sent[] = [];
	const queue = [...answers];
	const client: GraphqlClient = {
		graphql: (body, options) => {
			sent.push({ body, write: options?.write });
			const next = queue.shift();
			if (next === undefined) throw new Error('no answer scripted');
			return Promise.resolve({
				status: 200,
				body: next,
				fromCache: false,
				stale: false,
				cachedAt: '2026-11-09T12:00:00.000Z',
			} as never);
		},
	};
	return { client, sent };
}

const ISSUE = { id: 1000, iid: 5 };

const failure = async (call: () => Promise<unknown>): Promise<Error> => {
	try {
		await call();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a failure');
};

describe('the recorded documents', () => {
	it('are the ones the conformance scenario sends', async () => {
		const scenario = (await import('../../../../../scripts/gitlab-conformance-scenario.mjs')) as {
			GQL_READ: string;
			GQL_SET_PARENT: string;
			GQL_CONVERT: string;
		};
		expect(GQL_READ).toBe(scenario.GQL_READ);
		expect(GQL_SET_PARENT).toBe(scenario.GQL_SET_PARENT);
		expect(GQL_CONVERT).toBe(scenario.GQL_CONVERT);
	});

	it('the global id of a work item is the REST id, the type ids are the recorded ones', () => {
		expect(workItemGid(42)).toBe('gid://gitlab/WorkItem/42');
		expect(WORK_ITEM_TYPE_IDS).toEqual({ issue: 1, incident: 2, task: 5 });
	});
});

describe('read', () => {
	it('finds the HIERARCHY widget among the others and sorts the children', async () => {
		const { client, sent } = scripted({
			data: {
				workItem: {
					id: 'gid://gitlab/WorkItem/1000',
					iid: '5',
					workItemType: { name: 'Issue' },
					widgets: [
						{},
						{
							type: 'HIERARCHY',
							parent: null,
							children: {
								nodes: [
									{ id: 'g/1', iid: '9' },
									{ id: 'g/2', iid: '7' },
								],
							},
						},
						{},
					],
				},
			},
		});

		const hierarchy = await new WorkItems(client).read(ISSUE);

		expect(hierarchy).toEqual({ childIids: [7, 9], typeName: 'Issue' });
		expect(sent).toEqual([
			{ body: { query: GQL_READ, variables: { id: 'gid://gitlab/WorkItem/1000' } }, write: false },
		]);
	});

	it('reads the parent of a Task', async () => {
		const { client } = scripted({
			data: {
				workItem: {
					workItemType: { name: 'Task' },
					widgets: [{ type: 'HIERARCHY', parent: { id: 'g/1', iid: '3' }, children: { nodes: [] } }],
				},
			},
		});

		expect(await new WorkItems(client).read(ISSUE)).toEqual({ parentIid: 3, childIids: [], typeName: 'Task' });
	});

	it('a null work item is an error that names the permission to give (the token cannot read work items)', async () => {
		const { client } = scripted({ data: { workItem: null } });

		const error = await failure(() => new WorkItems(client).read(ISSUE));

		expect(error).toBeInstanceOf(GraphqlUnavailableError);
		expect(isPermissionFailure(error)).toBe(true);
		expect((error as BackendDataError).hint).toContain('Work Item: Read');
	});

	it('refuses a list of 100 children: it may be cut, and task never shows a cut list', async () => {
		const nodes = Array.from({ length: 100 }, (_, index) => ({ id: `g/${index}`, iid: String(index + 10) }));
		const { client } = scripted({
			data: {
				workItem: {
					workItemType: { name: 'Issue' },
					widgets: [{ type: 'HIERARCHY', parent: null, children: { nodes } }],
				},
			},
		});

		const error = await failure(() => new WorkItems(client).read(ISSUE));

		expect(error).toBeInstanceOf(BackendLimitError);
		expect(error.message).toContain('100');
	});
});

describe('parentsOf', () => {
	it('asks for 50 items per request with aliases and returns the parent of each, `unreadable` for a null one', async () => {
		const issues = Array.from({ length: 51 }, (_, index) => ({ id: 1000 + index, iid: index + 1 }));
		const widget = (parent: number | null): unknown => ({
			widgets: [{ type: 'HIERARCHY', parent: parent === null ? null : { id: 'g', iid: String(parent) } }],
		});
		const first: Record<string, unknown> = {};
		for (let index = 0; index < 50; index++)
			first[`w${index}`] = index === 3 ? null : widget(index === 1 ? 40 : null);
		const { client, sent } = scripted({ data: first }, { data: { w0: widget(2) } });

		const { parents, unreadable } = await new WorkItems(client).parentsOf(issues);

		expect(sent).toHaveLength(2);
		expect(sent[0]!.body.query).toContain('w49: workItem(id: "gid://gitlab/WorkItem/1049")');
		expect(sent[1]!.body.query).toContain('w0: workItem(id: "gid://gitlab/WorkItem/1050")');
		expect(sent.every(request => request.write === false)).toBe(true);
		expect(parents.get(2)).toBe(40);
		expect(parents.has(1)).toBe(true);
		expect(parents.get(1)).toBeUndefined();
		expect(parents.get(51)).toBe(2);
		expect(unreadable).toEqual([4]);
	});

	it('answers without data (a refusal of the whole request) as an error naming the permission', async () => {
		const { client } = scripted({
			errors: [{ message: 'The resource that you are attempting to access does not exist' }],
		});

		const error = await failure(() => new WorkItems(client).parentsOf([ISSUE]));

		expect(error).toBeInstanceOf(GraphqlUnavailableError);
		expect(error.message).toContain('does not exist');
	});
});

describe('the refusals GitLab puts in an answer', () => {
	const update = (errors: string[]): unknown => ({ data: { workItemUpdate: { errors, workItem: null } } });

	it('a type that cannot be a parent is a BackendRejectedError with GitLab text and the Free rule', async () => {
		const { client, sent } = scripted(
			update(["#7 cannot be added: it's not allowed to add this type of parent item"])
		);

		const error = await failure(() => new WorkItems(client).setParent(ISSUE, { id: 2000, iid: 6 }, 'setParent'));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(error.message).toContain("it's not allowed to add this type of parent item");
		expect((error as BackendRejectedError).hint).toContain('native Task');
		expect(sent[0]).toEqual({
			body: {
				query: GQL_SET_PARENT,
				variables: {
					input: {
						id: 'gid://gitlab/WorkItem/1000',
						hierarchyWidget: { parentId: 'gid://gitlab/WorkItem/2000' },
					},
				},
			},
			write: true,
		});
	});

	it('the item pointing to itself keeps both reasons in the message', async () => {
		const { client } = scripted(
			update([
				"#5 cannot be added: it's not allowed to add this type of parent item and is not allowed to point to itself",
			])
		);

		const error = await failure(() => new WorkItems(client).setParent(ISSUE, ISSUE, 'setParent'));

		expect(error.message).toContain('point to itself');
	});

	it('a top-level 404 (deleted meanwhile, or no Work Item: Update permission) names both causes', async () => {
		const { client } = scripted({
			errors: [{ message: '404 Not Found', path: ['workItemUpdate'] }],
			data: { workItemUpdate: null },
		});

		const error = await failure(() => new WorkItems(client).setParent(ISSUE, null, 'removeParent'));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect((error as BackendRejectedError).hint).toContain('Work Item: Update');
	});

	it('a limit in the text is a BackendLimitError carrying the text', async () => {
		const { client } = scripted(update(['#5 cannot be added: maximum number of child items reached']));

		const error = await failure(() => new WorkItems(client).setParent(ISSUE, { id: 2000, iid: 6 }, 'setParent'));

		expect(error).toBeInstanceOf(BackendLimitError);
		expect((error as BackendLimitError).hint).toContain('maximum number of child items reached');
	});

	it('removing the parent sends null; converting to Test Case is the refusal GitLab words', async () => {
		const removal = scripted({ data: { workItemUpdate: { errors: [], workItem: { id: 'g', iid: '5' } } } });
		await new WorkItems(removal.client).setParent(ISSUE, null, 'removeParent');
		expect(removal.sent[0]!.body.variables).toEqual({
			input: { id: 'gid://gitlab/WorkItem/1000', hierarchyWidget: { parentId: null } },
		});

		const conversion = scripted({
			errors: [
				{
					message: 'You are not allowed to change the Work Item type to Test Case.',
					path: ['workItemConvert'],
				},
			],
			data: { workItemConvert: null },
		});
		const error = await failure(() => new WorkItems(conversion.client).convert(ISSUE, 'task', 'setType'));
		expect(error.message).toContain('You are not allowed to change the Work Item type to Test Case.');
		expect(conversion.sent[0]!.body).toEqual({
			query: GQL_CONVERT,
			variables: {
				input: { id: 'gid://gitlab/WorkItem/1000', workItemTypeId: 'gid://gitlab/WorkItems::Type/5' },
			},
		});
	});

	it('an answer that is not a GraphQL answer is a BackendDataError saying where GraphQL lives', async () => {
		const { client } = scripted('<html>');

		const error = await failure(() => new WorkItems(client).read(ISSUE));

		expect(error).toBeInstanceOf(BackendDataError);
		expect((error as BackendDataError).hint).toContain('/api/graphql');
	});
});
