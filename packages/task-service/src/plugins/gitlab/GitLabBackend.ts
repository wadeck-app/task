// The gitlab strategy's backend: the TaskBackend port over the GitLab REST API v4. Every read goes through the one GitLabClient
// (token, cache, pagination, rate limits); the mapping lives in gitlabMapping.ts; every write is in gitlabWrites.ts. What GitLab
// cannot do is an UnsupportedByBackendError naming the fill that would give it (blockedBy: the paid tier), never a silent fallback.
//
// Checked against gitlab.com Free on 2026-11-09 (fixtures/live-conformance.json). The hierarchy (a native Task under an Issue or an
// Incident, two levels) and the native Task type go through GraphQL work items (gitlabWorkItems.ts).
import { BackendDataError, BackendLimitError, TaskNotFoundError } from '@wadeck-app/task-core';
import type {
	BackendCapabilities,
	BackendCommentChange,
	BackendCommentEdit,
	CreateTaskInput,
	LabelCount,
	LabelSyncReport,
	LinkType,
	ListQuery,
	Page,
	TaskBackend,
	TaskLink,
	TaskLinks,
	TaskRecord,
	TaskStatus,
	TaskSummary,
	TaskTreeNode,
	VersionedRecord,
	WriteOptions,
} from '@wadeck-app/task-core';

import type { DeclaredFills } from '../kinds.js';
import type { ClientResponse, GitLabClient } from './gitlabClient.js';
import {
	activityOf,
	commentsOf,
	isTombstone,
	iso,
	metaOf,
	replayHistory,
	splitBody,
	statusOfIssue,
	toSummary,
	typeOf,
	userLabels,
} from './gitlabMapping.js';
import type { MapContext } from './gitlabMapping.js';
import type { GitLabSettings } from './gitlabOptions.js';
import { revisionOf } from './gitlabRevision.js';
import type { ApiIssue, ApiLabelEvent, ApiLinkedIssue, ApiNote, ApiStateEvent } from './gitlabTypes.js';
import { GitLabWriter } from './gitlabWrites.js';
import { HIERARCHY_DEPTH, WorkItems, isPermissionFailure } from './gitlabWorkItems.js';

/**
 * What this backend can do with NO fill declared (GitLab Free tier only). Static: it is the floor. The fills add to it (see
 * {@link gitlabCapabilities}); `task strategy show` prints those as `emulated via <technique>`.
 */
export const GITLAB_CAPABILITIES: BackendCapabilities = Object.freeze({
	// VERIFIED-LIVE: GraphQL work items give an Issue or Incident parent and native Task children, two levels (hierarchyDepth trait).
	// The REST API has no such field; a task list in the body is never used.
	hierarchy: 'limited',
	// `blocks` / `is_blocked_by` links are a paid-tier feature (docs.gitlab.com/user/project/issues/related_issues): never offered.
	linkTypes: Object.freeze([] as const),
	status: 'mapped',
	// Rebuilt from resource_label_events and resource_state_events (which do not record the initial state).
	history: 'derived',
	activity: 'native',
	delete: 'no',
	search: 'native',
	concurrency: 'check-then-write',
	ids: 'assigned',
	labels: true,
	// With fills.meta: labels the labels `meta:key=value` are read as meta; the plugin reports it as emulated.
	meta: false,
	comments: true,
	writes: 'full',
	// The list carries the parent (one batched GraphQL read per page) but not the links of an issue.
	indexedGraph: false,
	events: 'client',
});

/** The capabilities of a backend whose project declared these fills (the base ones plus what each adds). */
export function gitlabCapabilities(fills: DeclaredFills): BackendCapabilities {
	const deleteUse = fills['delete']?.use;
	return Object.freeze({
		...GITLAB_CAPABILITIES,
		meta: fills['meta'] !== undefined,
		delete: deleteUse === 'hard' ? 'yes' : deleteUse === 'tombstone' ? 'close-only' : GITLAB_CAPABILITIES.delete,
		linkTypes: Object.freeze([
			...(fills['linkTypes.duplicateOf']?.use === 'relate-block' ? (['duplicateOf'] as const) : []),
			...(fills['linkTypes.causedBy']?.use === 'relate-block' ? (['causedBy'] as const) : []),
		]),
	});
}

export interface GitLabBackendInit {
	settings: GitLabSettings;
	client: GitLabClient;
	map: MapContext;
	/** Page of an issue on GitLab, for the hint of a refused write. */
	issueUrl: (iid: number) => string;
	newIssueUrl: string;
	/** The fills the project declared (`strategy.options.fills`). */
	fills: DeclaredFills;
}

interface Cursor {
	/** The URL of the page being read. */
	u: string;
	/** Items of that page already consumed. */
	s: number;
}

function encodeCursor(cursor: Cursor): string {
	return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(text: string): Cursor {
	try {
		const parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Partial<Cursor>;
		if (typeof parsed.u === 'string' && Number.isInteger(parsed.s) && parsed.s! >= 0) return parsed as Cursor;
	} catch {
		// falls through to the error below
	}
	throw new Error(
		`Invalid page request: cursor "${text}" was not issued by this backend; use the nextCursor of a previous page`
	);
}

export class GitLabBackend implements TaskBackend {
	readonly kind = 'gitlab' as const;
	readonly capabilities: BackendCapabilities;
	private readonly settings: GitLabSettings;
	private readonly fills: DeclaredFills;
	private readonly writer: GitLabWriter;
	private readonly client: GitLabClient;
	private readonly workItems: WorkItems;
	private readonly map: MapContext;
	private readonly issueUrl: (iid: number) => string;
	private readonly projectPath: string;

	constructor(init: GitLabBackendInit) {
		this.settings = init.settings;
		this.client = init.client;
		this.workItems = new WorkItems(init.client);
		this.map = init.map;
		this.issueUrl = init.issueUrl;
		this.projectPath = `/projects/${init.settings.project.apiId}`;
		this.fills = init.fills;
		this.capabilities = gitlabCapabilities(init.fills);
		this.writer = new GitLabWriter({
			settings: init.settings,
			client: init.client,
			workItems: this.workItems,
			map: init.map,
			fills: init.fills,
			projectPath: this.projectPath,
			issueUrl: init.issueUrl,
			newIssueUrl: init.newIssueUrl,
			loadIssue: (id, options) => this.issue(id, options),
			readRecord: id => this.get(id),
			linked: issue => this.linked(issue),
			issuesAll: () => this.issuesAll(),
		});
	}

	// ---------------------------------------------------------------- ids

	private iidOf(id: string): number | undefined {
		const match = /^#?(\d+)$/.exec(id.trim());
		return match === null ? undefined : Number(match[1]);
	}

	// ---------------------------------------------------------------- raw reads

	/**
	 * The issue as GitLab holds it; a missing number is TaskNotFoundError under the id the caller used (a tombstone is still an issue:
	 * it is hidden from the lists, not from a read by number). `revalidate`: ask GitLab even inside the cache TTL.
	 */
	private async issue(
		id: string,
		options: { revalidate?: boolean } = {}
	): Promise<{ issue: ApiIssue; response: ClientResponse<ApiIssue> }> {
		const iid = this.iidOf(id);
		if (iid === undefined) throw new TaskNotFoundError(id);
		const response = await this.client.get<ApiIssue>(`${this.projectPath}/issues/${iid}`, {
			allowNotFound: true,
			...(options.revalidate === true ? { revalidate: true } : {}),
		});
		if (response.status === 404) throw new TaskNotFoundError(id);
		return { issue: response.body, response };
	}

	private async issuesAll(): Promise<{ issues: ApiIssue[]; stale: boolean }> {
		const all = await this.client.getAll<ApiIssue>(`${this.projectPath}/issues`, {
			query: { order_by: 'created_at', sort: 'asc', per_page: this.settings.pageSize },
		});
		return { issues: all.items.filter(issue => !isTombstone(issue)), stale: all.stale };
	}

	/** The issues on the other end of the issue links of an issue, this project's only (tombstones and other projects left out). */
	private async linked(issue: Pick<ApiIssue, 'iid' | 'project_id'>): Promise<ApiLinkedIssue[]> {
		const all = await this.client.getAll<ApiLinkedIssue>(`${this.projectPath}/issues/${issue.iid}/links`, {
			query: { per_page: this.settings.pageSize },
		});
		const own: ApiLinkedIssue[] = [];
		for (const item of all.items) {
			if (isTombstone(item)) continue;
			if (item.project_id !== issue.project_id) {
				this.map.notice({
					kind: 'ignored',
					text: `a linked issue #${item.iid} of another project (${item.web_url ?? `project ${item.project_id}`}) is not a task of this project`,
				});
				continue;
			}
			own.push(item);
		}
		return own;
	}

	// ---------------------------------------------------------------- reads: records

	/**
	 * The parent of each issue that can have one (a native Task), ONE batched GraphQL read per 50 issues. When the token cannot read
	 * work items the list degrades -- every task shows as a root -- with a warning (never silently, and the list does not fail).
	 */
	private async parentMap(issues: readonly ApiIssue[]): Promise<Map<number, number | undefined>> {
		// Only a native Task has a parent (GitLab refuses an Issue under an Issue and the like).
		const candidates = issues.filter(issue => issue.issue_type === undefined || issue.issue_type === 'task');
		if (candidates.length === 0) return new Map();
		try {
			const { parents, unreadable } = await this.workItems.parentsOf(candidates);
			if (unreadable.length > 0) {
				this.map.notice({
					kind: 'ignored',
					text: `GitLab did not return the work item of ${unreadable.map(iid => `#${iid}`).join(', ')}: their parent is not shown (they appear as roots)`,
				});
			}
			return parents;
		} catch (error) {
			if (!isPermissionFailure(error)) throw error;
			this.map.notice({
				kind: 'ignored',
				text: 'the parent of a task is not shown: GitLab refused the work item read (GraphQL), so every task appears as a root. The token needs the permission "Work Item: Read" (fine-grained) or the scope read_api / api (classic); task strategy check tells which one is missing',
			});
			return new Map();
		}
	}

	async list(): Promise<TaskSummary[]> {
		const { issues } = await this.issuesAll();
		const parents = await this.parentMap(issues);
		return issues.map(issue => toSummary(issue, this.map, parents.get(issue.iid)));
	}

	/** The issues with these numbers (tombstones left out), oldest first. */
	private async issuesByIid(iids: readonly number[]): Promise<ApiIssue[]> {
		const found: ApiIssue[] = [];
		for (let start = 0; start < iids.length; start += 100) {
			const chunk = iids.slice(start, start + 100);
			const all = await this.client.getAll<ApiIssue>(
				`${this.projectPath}/issues?${chunk.map(iid => `iids[]=${iid}`).join('&')}`,
				{ query: { per_page: 100 } }
			);
			found.push(...all.items.filter(issue => !isTombstone(issue)));
		}
		return found.sort((a, b) => a.iid - b.iid);
	}

	/** The children of an issue as summaries (their parent is that issue). */
	private async childrenOf(issue: Pick<ApiIssue, 'id' | 'iid'>): Promise<TaskSummary[]> {
		const hierarchy = await this.workItems.read(issue);
		return (await this.issuesByIid(hierarchy.childIids)).map(child => toSummary(child, this.map, issue.iid));
	}

	async listPage(query: ListQuery = {}): Promise<Page<TaskSummary>> {
		const { parentId, statusIn, text, limit, cursor } = query;
		if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
			throw new Error(`Invalid page request: limit must be a positive integer (got ${String(limit)})`);
		}
		const start = cursor === undefined ? undefined : decodeCursor(cursor);
		if (typeof parentId === 'string') return this.childrenPage(parentId, query, start);
		let url: string | undefined = start?.u ?? this.listUrl(text);
		let skip = start?.s ?? 0;
		const items: TaskSummary[] = [];
		const needle = text?.toLowerCase();
		// `parentId: null` asks for the roots; a task id is answered by childrenPage above.
		const matches = (summary: TaskSummary): boolean =>
			(statusIn === undefined || statusIn.includes(summary.status)) &&
			(parentId === undefined || summary.parentId === undefined) &&
			// The server searches title AND description by a rule the docs do not give: only the title counts, as the port says.
			(needle === undefined || summary.title.toLowerCase().includes(needle));

		for (let pages = 0; url !== undefined; pages++) {
			if (pages >= this.settings.maxPages) {
				throw new BackendLimitError(
					'gitlab',
					'pages per read',
					this.settings.maxPages,
					'Raise strategy.options.maxPages in the project config, or ask for a narrower page.'
				);
			}
			const page: ClientResponse<ApiIssue[]> = await this.client.getUrl(url);
			const issues = page.body.filter(issue => !isTombstone(issue));
			// One GraphQL read for the parents of the page (a cursor can start inside it: the whole page is read anyway).
			const parents = await this.parentMap(issues);
			for (let index = skip; index < issues.length; index++) {
				const summary = toSummary(issues[index]!, this.map, parents.get(issues[index]!.iid));
				if (!matches(summary)) continue;
				if (limit !== undefined && items.length === limit) {
					// One more match exists: the next page starts at it.
					return { items, nextCursor: encodeCursor({ u: url, s: index }) };
				}
				items.push(summary);
			}
			skip = 0;
			url = page.next;
		}
		return { items };
	}

	/** The page of the children of one task: the hierarchy gives their numbers, then they are read in one list. */
	private async childrenPage(
		parentId: string,
		query: ListQuery,
		start: Cursor | undefined
	): Promise<Page<TaskSummary>> {
		const { statusIn, text, limit } = query;
		const { issue } = await this.issue(parentId);
		const needle = text?.toLowerCase();
		const matching = (await this.childrenOf(issue)).filter(
			summary =>
				(statusIn === undefined || statusIn.includes(summary.status)) &&
				(needle === undefined || summary.title.toLowerCase().includes(needle))
		);
		const from = start?.s ?? 0;
		const items = limit === undefined ? matching.slice(from) : matching.slice(from, from + limit);
		const end = from + items.length;
		return end < matching.length
			? { items, nextCursor: encodeCursor({ u: `children:${issue.iid}`, s: end }) }
			: { items };
	}

	private listUrl(text: string | undefined): string {
		const url = new URL(`${this.settings.baseUrl}${this.projectPath}/issues`);
		url.searchParams.set('order_by', 'created_at');
		url.searchParams.set('sort', 'asc');
		url.searchParams.set('per_page', String(this.settings.pageSize));
		if (text !== undefined) url.searchParams.set('search', text);
		return url.toString();
	}

	async get(id: string): Promise<VersionedRecord> {
		const { issue, response } = await this.issue(id);
		return this.recordOf(issue, response);
	}

	async getMany(ids: readonly string[]): Promise<VersionedRecord[]> {
		const records: VersionedRecord[] = [];
		// One after the other: the first missing id decides the error, and the client limits what is in flight anyway.
		for (const id of ids) records.push(await this.get(id));
		return records;
	}

	async findByPrefix(prefix: string): Promise<VersionedRecord> {
		return this.get(prefix);
	}

	async listLabels(): Promise<LabelCount[]> {
		const { issues } = await this.issuesAll();
		const counts = new Map<string, { label: string; count: number }>();
		for (const issue of issues) {
			for (const label of userLabels(issue, this.map)) {
				// Label names are case sensitive on GitLab: `bug` and `Bug` are two labels.
				const entry = counts.get(label) ?? { label, count: 0 };
				entry.count += 1;
				counts.set(label, entry);
			}
		}
		return [...counts.values()].sort(
			(a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
		);
	}

	/** The whole record of an issue: the issue, its notes, its label and state events and its blockers, fetched together. */
	private async recordOf(issue: ApiIssue, response: ClientResponse<ApiIssue>): Promise<VersionedRecord> {
		const base = `${this.projectPath}/issues/${issue.iid}`;
		const query = { per_page: this.settings.pageSize };
		// ONE request for the notes: the comments are the user notes, the activity (title, description, type, hierarchy) the system ones.
		// The token has 100 requests per minute, so the two are not asked for separately.
		const [notes, labelEvents, stateEvents, parents] = await Promise.all([
			this.client.getAll<ApiNote>(`${base}/notes`, {
				query: { ...query, activity_filter: 'all_notes', order_by: 'created_at', sort: 'asc' },
			}),
			this.client.getAll<ApiLabelEvent>(`${base}/resource_label_events`, { query }),
			this.client.getAll<ApiStateEvent>(`${base}/resource_state_events`, { query }),
			this.parentMap([issue]),
		]);
		const parentIid = parents.get(issue.iid);
		const { description, blockLinks } = splitBody(issue, this.map);
		const status = statusOfIssue(issue, this.map);
		const type = typeOf(issue, this.map);
		const labels = userLabels(issue, this.map);
		const meta = metaOf(issue, this.map);
		// blockedBy needs a paid tier: only duplicateOf / causedBy from the managed block are links of a record.
		const links = blockLinks.map((link): TaskLink => ({ type: link.type, target: link.target }));
		const activity = activityOf(labelEvents.items, this.map, issue.iid, notes.items);
		const comments = commentsOf(notes.items);
		const stales = [response, notes, labelEvents, stateEvents].filter(part => part.stale === true);
		const oldest = stales
			.map(part => (part as { cachedAt?: string }).cachedAt)
			.filter((at): at is string => at !== undefined)
			.sort()[0];
		const record: TaskRecord = {
			id: String(issue.iid),
			title: issue.title,
			...(description === undefined ? {} : { description }),
			status,
			...(parentIid === undefined ? {} : { parentId: String(parentIid) }),
			...(links.length === 0 ? {} : { links }),
			...(type === undefined ? {} : { type }),
			...(labels.length === 0 ? {} : { labels }),
			...(meta === undefined ? {} : { meta }),
			createdAt: iso(issue.created_at),
			updatedAt: iso(issue.updated_at),
			history: replayHistory(issue, labelEvents.items, stateEvents.items, this.map, status),
			...(activity.length === 0 ? {} : { activity }),
			...(comments.length === 0 ? {} : { comments }),
		};
		return {
			...record,
			revision: revisionOf(issue, this.map),
			...(stales.length === 0
				? {}
				: { stale: true as const, ...(oldest === undefined ? {} : { cachedAt: oldest }) }),
		};
	}

	// ---------------------------------------------------------------- reads: graph

	async getLinks(id: string): Promise<TaskLinks> {
		const { links, dangling } = await this.getLinksLenient(id);
		const first = dangling[0];
		if (first !== undefined) {
			throw new BackendDataError(
				'gitlab',
				`issue #${id}`,
				`issue #${id} names #${first.target} as the task it is ${first.type === 'causedBy' ? 'caused by' : 'a duplicate of'}, but that issue does not exist`,
				`Fix or remove the task block of ${this.issueUrl(Number(id.replace('#', '')))}`
			);
		}
		return links;
	}

	async getLinksLenient(id: string): Promise<{ links: TaskLinks; dangling: TaskLink[] }> {
		const { issue } = await this.issue(id);
		const links: TaskLinks = {
			blockedBy: [],
			blocks: [],
			duplicateOf: [],
			duplicates: [],
			causedBy: [],
			causes: [],
		};
		const dangling: TaskLink[] = [];
		const { blockLinks } = splitBody(issue, this.map);
		for (const link of blockLinks) {
			if (link.type !== 'duplicateOf' && link.type !== 'causedBy') continue;
			try {
				links[link.type].push(toSummary((await this.issue(link.target)).issue, this.map));
			} catch (error) {
				if (!(error instanceof TaskNotFoundError)) throw error;
				dangling.push(link);
			}
		}
		// GitLab keeps no readable type for a relates_to link: the inverse of a block link is read from the blocks of the other issues,
		// only when the project declared the fill (it costs one read of the list).
		const inverse = await this.inverseBlockLinks(issue);
		links.duplicates = inverse.duplicates;
		links.causes = inverse.causes;
		return { links, dangling };
	}

	/** The issues whose managed block says they duplicate / are caused by this one (only with the matching fill). */
	private async inverseBlockLinks(issue: ApiIssue): Promise<{ duplicates: TaskSummary[]; causes: TaskSummary[] }> {
		const wantDuplicates = this.fills['linkTypes.duplicateOf']?.use === 'relate-block';
		const wantCauses = this.fills['linkTypes.causedBy']?.use === 'relate-block';
		const result = { duplicates: [] as TaskSummary[], causes: [] as TaskSummary[] };
		if (!wantDuplicates && !wantCauses) return result;
		const { issues } = await this.issuesAll();
		for (const other of issues) {
			if (other.iid === issue.iid || !(other.description ?? '').includes('task:begin')) continue;
			try {
				for (const link of splitBody(other, this.map).blockLinks) {
					if (link.target !== String(issue.iid)) continue;
					if (link.type === 'duplicateOf' && wantDuplicates)
						result.duplicates.push(toSummary(other, this.map));
					if (link.type === 'causedBy' && wantCauses) result.causes.push(toSummary(other, this.map));
				}
			} catch (error) {
				// A block that cannot be read is reported when that issue itself is read; it must not hide the others here.
				if (!(error instanceof BackendDataError)) throw error;
				this.map.notice({
					kind: 'ignored',
					text: `${error.message}; it was skipped while looking for the links to #${issue.iid}`,
				});
			}
		}
		return result;
	}

	async getOpenBlockers(id: string, isTerminal: (status: TaskStatus) => boolean): Promise<TaskSummary[]> {
		return (await this.getLinksLenient(id)).links.blockedBy.filter(task => !isTerminal(task.status));
	}

	async getUnblockedBy(blockerId: string): Promise<TaskSummary[]> {
		// Nothing is blocked by an issue: blockedBy needs a paid tier. A missing issue is still TaskNotFoundError.
		await this.issue(blockerId);
		return [];
	}

	// The hierarchy: GraphQL work items (two levels on Free: an Issue or Incident and its native Tasks). A native Task has no children,
	// so the tree of a task is read without asking GitLab.

	async getChildren(id: string): Promise<TaskSummary[]> {
		const { issue } = await this.issue(id);
		return this.childrenOf(issue);
	}

	private async treeOf(issue: ApiIssue, depth: number, seen: Set<number>): Promise<TaskTreeNode> {
		if (depth > HIERARCHY_DEPTH || seen.has(issue.iid)) {
			throw new BackendLimitError(
				'gitlab',
				'hierarchy depth',
				HIERARCHY_DEPTH,
				`The child items below #${issue.iid} go deeper than ${HIERARCHY_DEPTH} levels, or loop; check ${this.issueUrl(issue.iid)}`
			);
		}
		seen.add(issue.iid);
		const hierarchy = issue.issue_type === 'task' ? undefined : await this.workItems.read(issue);
		const children = hierarchy === undefined ? [] : await this.issuesByIid(hierarchy.childIids);
		const node: TaskTreeNode = { ...toSummary(issue, this.map), children: [] };
		for (const child of children) {
			const below = await this.treeOf(child, depth + 1, seen);
			node.children.push({ ...below, parentId: String(issue.iid) });
		}
		return node;
	}

	async getTree(id: string): Promise<TaskTreeNode> {
		const { issue } = await this.issue(id);
		const parents = await this.parentMap([issue]);
		const root = await this.treeOf(issue, 1, new Set());
		const parent = parents.get(issue.iid);
		return parent === undefined ? root : { ...root, parentId: String(parent) };
	}

	async getForest(
		options: { parentId?: string; predicate?: (task: TaskSummary) => boolean } = {}
	): Promise<TaskTreeNode[]> {
		const { parentId, predicate } = options;
		const tasks = await this.list();
		if (parentId !== undefined && !tasks.some(task => task.id === parentId)) throw new TaskNotFoundError(parentId);
		const childrenByParent = new Map<string | undefined, TaskSummary[]>();
		for (const task of tasks) {
			const siblings = childrenByParent.get(task.parentId) ?? [];
			siblings.push(task);
			childrenByParent.set(task.parentId, siblings);
		}
		const roots: TaskTreeNode[] = (childrenByParent.get(parentId) ?? []).map(task => ({ ...task, children: [] }));
		const preorder: TaskTreeNode[] = [];
		const visited = new Set<string>();
		const pending = [...roots].reverse();
		while (pending.length > 0) {
			const node = pending.pop()!;
			if (visited.has(node.id)) {
				throw new BackendDataError(
					'gitlab',
					`issue #${node.id}`,
					`issue #${node.id} is its own ancestor in the hierarchy`,
					`Remove the child item link that closes the loop on ${this.issueUrl(Number(node.id))}`
				);
			}
			visited.add(node.id);
			preorder.push(node);
			node.children = (childrenByParent.get(node.id) ?? []).map(task => ({ ...task, children: [] }));
			pending.push(...[...node.children].reverse());
		}
		if (predicate === undefined) return roots;
		const keep = new Set<string>();
		for (const node of [...preorder].reverse()) {
			node.children = node.children.filter(child => keep.has(child.id));
			if (node.children.length > 0 || predicate(node)) keep.add(node.id);
		}
		return roots.filter(root => keep.has(root.id));
	}

	async getDescendants(id: string): Promise<TaskSummary[]> {
		const tree = await this.getTree(id);
		const descendants: TaskSummary[] = [];
		const pending: TaskTreeNode[] = [...tree.children].reverse();
		while (pending.length > 0) {
			const { children, ...summary } = pending.pop()!;
			descendants.push(summary);
			pending.push(...[...children].reverse());
		}
		return descendants;
	}

	async getAncestors(id: string): Promise<TaskSummary[]> {
		const ancestors: TaskSummary[] = [];
		const seen = new Set<number>();
		let { issue } = await this.issue(id);
		seen.add(issue.iid);
		for (;;) {
			const parent = issue.issue_type === 'task' ? (await this.parentMap([issue])).get(issue.iid) : undefined;
			if (parent === undefined) return ancestors;
			if (seen.has(parent) || ancestors.length >= HIERARCHY_DEPTH) {
				throw new BackendLimitError(
					'gitlab',
					'hierarchy depth',
					HIERARCHY_DEPTH,
					`The parents of #${id} loop or go deeper than ${HIERARCHY_DEPTH} levels; check ${this.issueUrl(parent)}`
				);
			}
			seen.add(parent);
			({ issue } = await this.issue(String(parent)));
			ancestors.push(toSummary(issue, this.map));
		}
	}

	async getFullTree(id: string): Promise<TaskTreeNode> {
		const ancestors = await this.getAncestors(id);
		const rootId = ancestors.at(-1)?.id ?? String((await this.issue(id)).issue.iid);
		const tree = await this.getTree(rootId);
		const pending: TaskTreeNode[] = [tree];
		const target = String(this.iidOf(id));
		while (pending.length > 0) {
			const node = pending.pop()!;
			if (node.id === target) {
				node.selected = true;
				break;
			}
			pending.push(...node.children);
		}
		return tree;
	}

	// ---------------------------------------------------------------- writes (gitlabWrites.ts)

	create(input: CreateTaskInput): Promise<VersionedRecord> {
		return this.writer.create(input);
	}

	updateStatus(id: string, status: TaskStatus, options?: WriteOptions): Promise<VersionedRecord> {
		return this.writer.updateStatus(id, status, options);
	}

	setTitle(id: string, title: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.writer.setTitle(id, title, options);
	}

	setDescription(id: string, description: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.writer.setDescription(id, description, options);
	}

	setType(id: string, type: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.writer.setType(id, type, options);
	}

	clearType(id: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.writer.clearType(id, options);
	}

	addLabel(id: string, label: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.writer.addLabel(id, label, options);
	}

	removeLabel(id: string, label: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.writer.removeLabel(id, label, options);
	}

	setMeta(id: string, key: string, value: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.writer.setMeta(id, key, value, options);
	}

	removeMeta(id: string, key: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.writer.removeMeta(id, key, options);
	}

	setParent(id: string, parentId: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.writer.setParent(id, parentId, options);
	}

	removeParent(id: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.writer.removeParent(id, options);
	}

	addLink(id: string, type: LinkType, targetId: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.writer.addLink(id, type, targetId, options);
	}

	removeLink(id: string, type: LinkType, targetId: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.writer.removeLink(id, type, targetId, options);
	}

	addComment(id: string, text: string, options?: WriteOptions & { author?: string }): Promise<BackendCommentChange> {
		return this.writer.addComment(id, text, options);
	}

	editComment(id: string, commentId: string, text: string, options?: WriteOptions): Promise<BackendCommentEdit> {
		return this.writer.editComment(id, commentId, text, options);
	}

	removeComment(id: string, commentId: string, options?: WriteOptions): Promise<BackendCommentChange> {
		return this.writer.removeComment(id, commentId, options);
	}

	deleteTask(id: string, options?: WriteOptions): Promise<boolean> {
		return this.writer.deleteTask(id, options);
	}

	syncLabels(options: { dryRun?: boolean }): Promise<LabelSyncReport> {
		return this.writer.syncLabels(options);
	}
}
