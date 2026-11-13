// The work item side of the gitlab strategy: the hierarchy (parent, children) and the native issue type, which GitLab exposes through
// GraphQL only (VERIFIED-LIVE on gitlab.com Free, 2026-11-09: the REST API has no parent of an issue and refuses `issue_type: task`
// on an update). Everything here talks to `POST <api>/graphql` through GitLabClient.graphql; nothing else does.
//
// What is VERIFIED-LIVE (fixtures/live-conformance.json, steps "read A hierarchy" ... "graphql syntax error"):
//   - the work item id is `gid://gitlab/WorkItem/<REST issue id>`; the HIERARCHY widget carries `parent{id iid}` and `children{nodes}`;
//   - a parent must be an Issue or an Incident, a child must be a native Task: a Task under a Task, an Issue under an Issue and an item
//     under itself answer `errors: ["#N cannot be added: it's not allowed to add this type of parent item"]` (inside the payload);
//   - a parent is replaced by setting another one, removed with `parentId: null` (idempotent);
//   - a missing work item is a top-level error "404 Not Found"; converting to Test Case is "You are not allowed to change the Work
//     Item type to Test Case."; GraphQL aliases batch several reads in one request.
// `project(fullPath)` is NEVER used: a token without `Project: Read` gets null from it.
import { BackendAuthError, BackendDataError, BackendLimitError, BackendRejectedError } from '@wadeck-app/task-core';

import type { ClientResponse, GitLabClient } from './gitlabClient.js';
import type { ApiIssue } from './gitlabTypes.js';

// The documents below are the ones the conformance scenario recorded (scripts/gitlab-conformance-scenario.mjs): the strategy sends
// exactly these texts, a test compares them.
export const GQL_READ =
	'query($id: WorkItemID!) { workItem(id: $id) { id iid workItemType { name } widgets { ... on WorkItemWidgetHierarchy { type parent { id iid } children(first: 100) { nodes { id iid } } } } } }';
export const GQL_SET_PARENT =
	'mutation($input: WorkItemUpdateInput!) { workItemUpdate(input: $input) { errors workItem { id iid } } }';
export const GQL_CONVERT =
	'mutation($input: WorkItemConvertInput!) { workItemConvert(input: $input) { errors workItem { id iid workItemType { name } } } }';

/** The native types a task can have on GitLab Free, with the id of their work item type (3, Test Case, is refused by GitLab). */
export const WORK_ITEM_TYPE_IDS = Object.freeze({ issue: 1, incident: 2, task: 5 } as const);
export type WorkItemTypeName = keyof typeof WORK_ITEM_TYPE_IDS;

/** Two levels: a parent (Issue or Incident) and its native Tasks. */
export const HIERARCHY_DEPTH = 2;
/** The most children one read returns (`children(first: 100)`): a parent with that many may have more, which is refused, not cut. */
export const CHILDREN_READ_MAX = 100;
/** Reads batched in one aliased request. */
const BATCH_SIZE = 50;

export const workItemGid = (id: number): string => `gid://gitlab/WorkItem/${id}`;

const numeric = (value: unknown): number | undefined => {
	const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
	return Number.isInteger(parsed) ? parsed : undefined;
};

export interface Hierarchy {
	/** The iid of the parent; absent for a root. */
	parentIid?: number;
	/** The iids of the children, oldest first. */
	childIids: number[];
	/** The native work item type as GraphQL names it (`Issue`, `Incident`, `Task`). */
	typeName: string;
}

interface GraphqlError {
	message?: string;
	path?: unknown[];
}

interface GraphqlBody<T> {
	data?: T | null;
	errors?: GraphqlError[];
}

export type GraphqlClient = Pick<GitLabClient, 'graphql'>;

/** GitLab answered GraphQL but returned no work item data: in practice the token lacks the work item read permission. */
export class GraphqlUnavailableError extends BackendDataError {}

/** A text GitLab gave back inside a GraphQL answer, as an actionable error. `subject` is the task id, for the message. */
function refusal(operation: string, subject: string, texts: readonly string[]): Error {
	const text = texts.join('; ');
	const lower = text.toLowerCase();
	if (/\b(maximum|too many|limit|too deep|depth)\b/.test(lower)) {
		return new BackendLimitError(
			'gitlab',
			'hierarchy',
			HIERARCHY_DEPTH,
			`GitLab refused ${operation} on ${subject}: ${text}. On the Free tier a hierarchy has two levels: an issue (or incident) and its tasks.`
		);
	}
	if (/\b404\b|not found/.test(lower)) {
		return new BackendRejectedError(
			'gitlab',
			operation,
			`GitLab answered "${text}" for the work item of ${subject}`,
			'The item was deleted meanwhile, or the token lacks the permission "Work Item: Update" (GraphQL needs the same fine-grained permissions as the REST issue routes).'
		);
	}
	const typeProblem = /not allowed to add this type of parent item/.test(lower);
	return new BackendRejectedError(
		'gitlab',
		operation,
		`GitLab refused ${operation} on ${subject}: ${text}`,
		typeProblem
			? 'GitLab Free only lets a native Task be the child of an Issue or an Incident (no task under a task, no issue under an issue).'
			: 'Nothing was changed by this call. Check the item on GitLab.'
	);
}

export class WorkItems {
	constructor(private readonly client: GraphqlClient) {}

	private async send<T>(
		operation: string,
		subject: string,
		query: string,
		variables: Record<string, unknown> | undefined,
		write: boolean
	): Promise<GraphqlBody<T>> {
		const answer: ClientResponse<GraphqlBody<T>> = await this.client.graphql<GraphqlBody<T>>(
			{ query, ...(variables === undefined ? {} : { variables }) },
			{ write }
		);
		const body = answer.body;
		if (typeof body !== 'object' || body === null) {
			throw new BackendDataError(
				'gitlab',
				'GraphQL',
				`GitLab answered ${operation} on ${subject} with something that is not a GraphQL answer`,
				'Retry; if it persists, check strategy.options.baseUrl (GraphQL is served next to the REST address, at /api/graphql)'
			);
		}
		return body;
	}

	/** The top-level errors of an answer (syntax, permission, 404), as texts. */
	private topLevel(body: GraphqlBody<unknown>): string[] {
		return (body.errors ?? []).map(error => error.message ?? 'unknown error');
	}

	/** The hierarchy of one work item (parent iid, children iids, native type). */
	async read(issue: Pick<ApiIssue, 'id' | 'iid'>): Promise<Hierarchy> {
		const subject = `#${issue.iid}`;
		const body = await this.send<{ workItem: unknown }>(
			'read the hierarchy',
			subject,
			GQL_READ,
			{ id: workItemGid(issue.id) },
			false
		);
		const texts = this.topLevel(body);
		const item = body.data?.workItem as
			| {
					workItemType?: { name?: string };
					widgets?: Array<{
						type?: string;
						parent?: { iid?: unknown } | null;
						children?: { nodes?: Array<{ iid?: unknown }> };
					}>;
			  }
			| null
			| undefined;
		if (item === null || item === undefined) {
			throw new GraphqlUnavailableError(
				'gitlab',
				`issue ${subject}`,
				`GitLab did not return the work item of issue ${subject}${texts.length > 0 ? ` (${texts.join('; ')})` : ''}`,
				'The hierarchy is read with GraphQL: the token needs the permission "Work Item: Read" (fine-grained token) or the scope api / read_api (classic token).'
			);
		}
		const widget = (item.widgets ?? []).find(candidate => candidate.type === 'HIERARCHY');
		const nodes = widget?.children?.nodes ?? [];
		if (nodes.length >= CHILDREN_READ_MAX) {
			throw new BackendLimitError(
				'gitlab',
				'child items per read',
				CHILDREN_READ_MAX,
				`Issue ${subject} has ${nodes.length} child items or more; task reads at most ${CHILDREN_READ_MAX} of them and refuses to show a cut list.`
			);
		}
		const parentIid = numeric(widget?.parent?.iid);
		return {
			...(parentIid === undefined ? {} : { parentIid }),
			childIids: nodes
				.map(node => numeric(node.iid))
				.filter((iid): iid is number => iid !== undefined)
				.sort((a, b) => a - b),
			typeName: item.workItemType?.name ?? 'Issue',
		};
	}

	/**
	 * The parent iid (undefined = root) of every given issue, with ONE aliased request per BATCH_SIZE issues. A failure of the whole
	 * request (permission, syntax) is thrown; an item GitLab could not return is listed in `unreadable` (its parent is unknown, which
	 * is not "no parent").
	 */
	async parentsOf(
		issues: ReadonlyArray<Pick<ApiIssue, 'id' | 'iid'>>
	): Promise<{ parents: Map<number, number | undefined>; unreadable: number[] }> {
		const parents = new Map<number, number | undefined>();
		const unreadable: number[] = [];
		for (let start = 0; start < issues.length; start += BATCH_SIZE) {
			const batch = issues.slice(start, start + BATCH_SIZE);
			const fields = batch
				.map(
					(issue, index) =>
						`w${index}: workItem(id: "${workItemGid(issue.id)}") { widgets { ... on WorkItemWidgetHierarchy { type parent { id iid } } } }`
				)
				.join(' ');
			const body = await this.send<Record<string, unknown>>(
				'read the parents',
				`${batch.length} issues`,
				`query { ${fields} }`,
				undefined,
				false
			);
			const data = body.data;
			if (data === null || data === undefined) {
				throw new GraphqlUnavailableError(
					'gitlab',
					'GraphQL',
					`GitLab answered the read of the parents with errors: ${this.topLevel(body).join('; ') || 'no data'}`,
					'The hierarchy is read with GraphQL: the token needs the permission "Work Item: Read" (fine-grained token) or the scope api / read_api (classic token).'
				);
			}
			batch.forEach((issue, index) => {
				const item = data[`w${index}`] as
					{ widgets?: Array<{ type?: string; parent?: { iid?: unknown } | null }> } | null | undefined;
				if (item === null || item === undefined) {
					unreadable.push(issue.iid);
					return;
				}
				const widget = (item.widgets ?? []).find(candidate => candidate.type === 'HIERARCHY');
				parents.set(issue.iid, numeric(widget?.parent?.iid));
			});
		}
		return { parents, unreadable };
	}

	/** Sets the parent of a work item (replacing the old one), or removes it with `null`. Idempotent for null. */
	async setParent(
		child: Pick<ApiIssue, 'id' | 'iid'>,
		parent: Pick<ApiIssue, 'id' | 'iid'> | null,
		operation: string
	): Promise<void> {
		const subject = `#${child.iid}`;
		const body = await this.send<{ workItemUpdate: { errors?: string[] } | null }>(
			operation,
			subject,
			GQL_SET_PARENT,
			{
				input: {
					id: workItemGid(child.id),
					hierarchyWidget: { parentId: parent === null ? null : workItemGid(parent.id) },
				},
			},
			true
		);
		this.requireDone(operation, subject, body, body.data?.workItemUpdate);
	}

	/** Converts a work item to a native type (the REST update refuses `task`). */
	async convert(issue: Pick<ApiIssue, 'id' | 'iid'>, type: WorkItemTypeName, operation: string): Promise<void> {
		const subject = `#${issue.iid}`;
		const body = await this.send<{ workItemConvert: { errors?: string[] } | null }>(
			operation,
			subject,
			GQL_CONVERT,
			{
				input: {
					id: workItemGid(issue.id),
					workItemTypeId: `gid://gitlab/WorkItems::Type/${WORK_ITEM_TYPE_IDS[type]}`,
				},
			},
			true
		);
		this.requireDone(operation, subject, body, body.data?.workItemConvert);
	}

	private requireDone(
		operation: string,
		subject: string,
		body: GraphqlBody<unknown>,
		payload: { errors?: string[] } | null | undefined
	): void {
		const texts = [...this.topLevel(body), ...(payload?.errors ?? [])];
		if (texts.length > 0) throw refusal(operation, subject, texts);
		if (payload === null || payload === undefined) {
			throw new BackendDataError(
				'gitlab',
				'GraphQL',
				`GitLab gave no answer to ${operation} on ${subject}`,
				'Check the item on GitLab and retry.'
			);
		}
	}
}

/** True when the error means the token may not use GraphQL for work items (the list then degrades instead of failing). */
export function isPermissionFailure(error: unknown): boolean {
	return error instanceof BackendAuthError || error instanceof GraphqlUnavailableError;
}
