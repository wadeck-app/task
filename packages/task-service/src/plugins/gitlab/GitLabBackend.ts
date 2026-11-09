// The gitlab strategy's backend: the TaskBackend port over the GitLab REST API v4. Every read goes through the one GitLabClient
// (token, cache, pagination, rate limits); the mapping lives in gitlabMapping.ts; every write is in gitlabWrites.ts. What GitLab
// cannot do is an UnsupportedByBackendError naming the tier or the fill that would give it, never a silent fallback.
//
// NOT VERIFIED AGAINST A REAL GITLAB: built from docs.gitlab.com and a fake server modelled on it (see the "GitLab verification log"
// of the storage plan).
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
	linksOf,
	metaOf,
	replayHistory,
	splitBody,
	statusOfIssue,
	toSummary,
	typeOf,
	userLabels,
} from './gitlabMapping.js';
import type { MapContext } from './gitlabMapping.js';
import type { GitLabSettings, GitLabTier } from './gitlabOptions.js';
import { revisionOf } from './gitlabRevision.js';
import type { ApiIssue, ApiLabelEvent, ApiLinkedIssue, ApiNote, ApiStateEvent } from './gitlabTypes.js';
import { GitLabWriter } from './gitlabWrites.js';

/**
 * What this backend can do with NO fill declared and on the FREE tier. Static: it is the floor. The tier and the fills add to it (see
 * {@link gitlabCapabilities}); `task strategy show` prints those as `emulated via <technique>`.
 */
export const GITLAB_CAPABILITIES: BackendCapabilities = Object.freeze({
	// The REST API has no parent of an issue (docs.gitlab.com/api/issues: no field, no endpoint; the work item hierarchy is GraphQL
	// and its issue-to-issue rules per tier are not documented): UNVERIFIED, so refused, never emulated with a task list.
	hierarchy: 'none',
	// `blocks` / `is_blocked_by` links are Premium and Ultimate (docs.gitlab.com/user/project/issues/related_issues).
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
	// With fills.meta: labels the labels `meta:key=value` / `meta::key::value` are read as meta; the plugin reports it as emulated.
	meta: false,
	comments: true,
	writes: 'full',
	// The list carries neither the parent nor the links of an issue.
	indexedGraph: false,
	events: 'client',
});

/** The capabilities of a backend of this tier whose project declared these fills (the base ones plus what each adds). */
export function gitlabCapabilities(tier: GitLabTier, fills: DeclaredFills): BackendCapabilities {
	const deleteUse = fills['delete']?.use;
	return Object.freeze({
		...GITLAB_CAPABILITIES,
		meta: fills['meta'] !== undefined,
		delete: deleteUse === 'hard' ? 'yes' : deleteUse === 'tombstone' ? 'close-only' : GITLAB_CAPABILITIES.delete,
		linkTypes: Object.freeze([
			...(tier === 'free' ? [] : (['blockedBy'] as const)),
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
	private readonly map: MapContext;
	private readonly issueUrl: (iid: number) => string;
	private readonly projectPath: string;

	constructor(init: GitLabBackendInit) {
		this.settings = init.settings;
		this.client = init.client;
		this.map = init.map;
		this.issueUrl = init.issueUrl;
		this.projectPath = `/projects/${init.settings.project.apiId}`;
		this.fills = init.fills;
		this.capabilities = gitlabCapabilities(init.settings.tier, init.fills);
		this.writer = new GitLabWriter({
			settings: init.settings,
			client: init.client,
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

	async list(): Promise<TaskSummary[]> {
		const { issues } = await this.issuesAll();
		return issues.map(issue => toSummary(issue, this.map));
	}

	async listPage(query: ListQuery = {}): Promise<Page<TaskSummary>> {
		const { parentId, statusIn, text, limit, cursor } = query;
		if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
			throw new Error(`Invalid page request: limit must be a positive integer (got ${String(limit)})`);
		}
		const start = cursor === undefined ? undefined : decodeCursor(cursor);
		let url: string | undefined = start?.u ?? this.listUrl(text);
		let skip = start?.s ?? 0;
		const items: TaskSummary[] = [];
		const needle = text?.toLowerCase();
		// No issue has a parent here (capability hierarchy: none): every task is a root.
		const matches = (summary: TaskSummary): boolean =>
			(statusIn === undefined || statusIn.includes(summary.status)) &&
			(parentId === undefined || parentId === null) &&
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
			for (let index = skip; index < issues.length; index++) {
				const summary = toSummary(issues[index]!, this.map);
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
				const entry = counts.get(label.toLowerCase()) ?? { label, count: 0 };
				entry.count += 1;
				counts.set(label.toLowerCase(), entry);
			}
		}
		return [...counts.values()].sort(
			(a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
		);
	}

	/** True when the tier has the issue links that give `blockedBy` / `blocks` (Premium, Ultimate). */
	private get hasBlockLinks(): boolean {
		return this.settings.tier !== 'free';
	}

	/** The whole record of an issue: the issue, its notes, its label and state events and its blockers, fetched together. */
	private async recordOf(issue: ApiIssue, response: ClientResponse<ApiIssue>): Promise<VersionedRecord> {
		const base = `${this.projectPath}/issues/${issue.iid}`;
		const query = { per_page: this.settings.pageSize };
		const [notes, labelEvents, stateEvents, linked] = await Promise.all([
			this.client.getAll<ApiNote>(`${base}/notes`, {
				query: { ...query, activity_filter: 'only_comments', order_by: 'created_at', sort: 'asc' },
			}),
			this.client.getAll<ApiLabelEvent>(`${base}/resource_label_events`, { query }),
			this.client.getAll<ApiStateEvent>(`${base}/resource_state_events`, { query }),
			this.hasBlockLinks ? this.linked(issue) : Promise.resolve([] as ApiLinkedIssue[]),
		]);
		const { description, blockLinks } = splitBody(issue, this.map);
		const status = statusOfIssue(issue, this.map);
		const type = typeOf(issue, this.map);
		const labels = userLabels(issue, this.map);
		const meta = metaOf(issue, this.map);
		const links = linksOf(
			linked.filter(item => item.link_type === 'is_blocked_by').map(item => item.iid),
			blockLinks
		);
		const activity = activityOf(labelEvents.items, this.map, issue.iid);
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
		const linked = this.hasBlockLinks ? await this.linked(issue) : [];
		const links: TaskLinks = {
			blockedBy: linked.filter(item => item.link_type === 'is_blocked_by').map(item => toSummary(item, this.map)),
			blocks: linked.filter(item => item.link_type === 'blocks').map(item => toSummary(item, this.map)),
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

	async getUnblockedBy(blockerId: string, isTerminal: (status: TaskStatus) => boolean): Promise<TaskSummary[]> {
		const { issue } = await this.issue(blockerId);
		if (!isTerminal(statusOfIssue(issue, this.map))) return [];
		if (!this.hasBlockLinks) return [];
		const blocked = (await this.linked(issue)).filter(item => item.link_type === 'blocks');
		const unblocked: TaskSummary[] = [];
		for (const candidate of blocked) {
			const summary = toSummary(candidate, this.map);
			if (isTerminal(summary.status)) continue;
			const blockers = (await this.linked(candidate)).filter(item => item.link_type === 'is_blocked_by');
			if (blockers.every(other => isTerminal(statusOfIssue(other, this.map)))) unblocked.push(summary);
		}
		return unblocked;
	}

	// No parent, no children: the hierarchy is refused by the writes (capability hierarchy: none); the reads answer "none" after
	// checking that the issue exists, so a caller sees the same shapes as for a project whose tasks happen to have no parent.

	async getChildren(id: string): Promise<TaskSummary[]> {
		await this.issue(id);
		return [];
	}

	async getTree(id: string): Promise<TaskTreeNode> {
		const { issue } = await this.issue(id);
		return { ...toSummary(issue, this.map), children: [] };
	}

	async getForest(
		options: { parentId?: string; predicate?: (task: TaskSummary) => boolean } = {}
	): Promise<TaskTreeNode[]> {
		const { parentId, predicate } = options;
		const tasks = await this.list();
		if (parentId !== undefined) {
			if (!tasks.some(task => task.id === parentId)) throw new TaskNotFoundError(parentId);
			return [];
		}
		const roots = tasks.map((task): TaskTreeNode => ({ ...task, children: [] }));
		return predicate === undefined ? roots : roots.filter(root => predicate(root));
	}

	async getDescendants(id: string): Promise<TaskSummary[]> {
		await this.issue(id);
		return [];
	}

	async getAncestors(id: string): Promise<TaskSummary[]> {
		await this.issue(id);
		return [];
	}

	async getFullTree(id: string): Promise<TaskTreeNode> {
		const { issue } = await this.issue(id);
		return { ...toSummary(issue, this.map), children: [], selected: true };
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
