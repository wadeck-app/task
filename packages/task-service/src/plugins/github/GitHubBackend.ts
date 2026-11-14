// The github strategy's backend: the TaskBackend port over the GitHub REST API. Every read goes through the one GitHubClient (token,
// cache, pagination, rate limits); the mapping lives in issueMapping.ts; every write is in githubWrites.ts (stage 2 of the storage
// design). What GitHub cannot do is an UnsupportedByBackendError naming the fill that would emulate it, never a silent fallback.
import { BackendDataError, BackendLimitError, TaskNotFoundError } from '@wadeck-app/task-core';
import type {
	BackendCapabilities,
	BackendCommentChange,
	BackendCommentEdit,
	CreateTaskInput,
	LabelCount,
	LabelSyncReport,
	ListQuery,
	Page,
	ResolvedTask,
	TaskBackend,
	TaskLink,
	TaskLinks,
	TaskRecord,
	LinkType,
	TaskStatus,
	TaskSummary,
	TaskTreeNode,
	VersionedRecord,
	WriteOptions,
} from '@wadeck-app/task-core';

import { GitHubHttpError } from './githubClient.js';
import type { ClientResponse, GitHubClient } from './githubClient.js';
import type { DeclaredFills } from '../kinds.js';
import type { GitHubSettings } from './githubOptions.js';
import { revisionOf } from './githubRevision.js';
import { CREATION_MEMORY_MS } from './responseCache.js';
import { GitHubWriter } from './githubWrites.js';
import {
	activityOf,
	commentsOf,
	isPullRequest,
	isTombstone,
	iso,
	linksOf,
	metaOf,
	parentNumber,
	replayHistory,
	splitBody,
	statusOfIssue,
	toSummary,
	typeOf,
	userLabels,
} from './issueMapping.js';
import type { ApiComment, ApiEvent, ApiIssue, MapContext } from './issueMapping.js';

/**
 * What this backend can do with NO fill declared. Static: the plugin declares it before anything is created. A fill adds to it
 * (see {@link githubCapabilities}); `task strategy show` prints those as `emulated via <technique>`.
 */
export const GITHUB_CAPABILITIES: BackendCapabilities = Object.freeze({
	// GitHub caps sub-issues at 8 levels and 100 per parent.
	hierarchy: 'limited',
	// duplicateOf is read from the managed block when it is present (GitHub does not return the target of a duplicate close).
	linkTypes: Object.freeze(['blockedBy'] as const),
	status: 'mapped',
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
	// The list carries the parent of each issue, not its links.
	indexedGraph: false,
	events: 'client',
});

/** The capabilities of a backend whose project declared these fills (the base ones plus what each fill enables). */
export function githubCapabilities(fills: DeclaredFills): BackendCapabilities {
	const deleteUse = fills['delete']?.use;
	return Object.freeze({
		...GITHUB_CAPABILITIES,
		meta: fills['meta'] !== undefined,
		delete: deleteUse === 'hard' ? 'yes' : deleteUse === 'tombstone' ? 'close-only' : GITHUB_CAPABILITIES.delete,
		linkTypes: Object.freeze([
			...GITHUB_CAPABILITIES.linkTypes,
			...(fills['linkTypes.duplicateOf']?.use === 'duplicate-marker' ? (['duplicateOf'] as const) : []),
		]),
	});
}

/**
 * The dependency counts and the sub-issue counts of an issue lag a change by 1 to 2 s (measured): for this long the lists are read
 * whatever the counts say.
 */
const COUNT_MEMORY_MS = 10_000;

/** GitHub allows 8 levels of sub-issues. */
export const MAX_DEPTH = 8;
/** GitHub allows 100 sub-issues per parent. */
export const MAX_CHILDREN = 100;

/** The `u` of a cursor that is past the end of the list: only the recent creations remain. */
const OVERLAY = 'recent-creations';

interface Cursor {
	/** The URL of the page being read, or {@link OVERLAY}. */
	u: string;
	/** Items of that page already consumed (overlay: recent creations already returned). */
	s: number;
	/** The highest issue number met so far: a recent creation above it is one the list does not show yet. */
	m?: number;
}

function encodeCursor(cursor: Cursor): string {
	return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(text: string): Cursor {
	try {
		const parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Partial<Cursor>;
		if (
			typeof parsed.u === 'string' &&
			Number.isInteger(parsed.s) &&
			parsed.s! >= 0 &&
			(parsed.m === undefined || Number.isInteger(parsed.m))
		) {
			return parsed as Cursor;
		}
	} catch {
		// falls through to the error below
	}
	throw new Error(
		`Invalid page request: cursor "${text}" was not issued by this backend; use the nextCursor of a previous page`
	);
}

export interface GitHubBackendInit {
	settings: GitHubSettings;
	client: GitHubClient;
	map: MapContext;
	/** Page of an issue on GitHub, for the hint of a refused write. */
	issueUrl: (number: number) => string;
	newIssueUrl: string;
	/** The fills the project declared (`strategy.options.fills`): they decide what meta, delete and duplicateOf do. */
	fills: DeclaredFills;
}

export class GitHubBackend implements TaskBackend {
	readonly kind = 'github' as const;
	readonly capabilities: BackendCapabilities;
	private readonly settings: GitHubSettings;
	private readonly fills: DeclaredFills;
	private readonly writer: GitHubWriter;
	private readonly client: GitHubClient;
	private readonly map: MapContext;
	private readonly issueUrl: (number: number) => string;
	private readonly newIssueUrl: string;
	private readonly repoPath: string;

	constructor(init: GitHubBackendInit) {
		this.settings = init.settings;
		this.client = init.client;
		this.map = init.map;
		this.issueUrl = init.issueUrl;
		this.newIssueUrl = init.newIssueUrl;
		this.repoPath = `/repos/${init.settings.repo.full}`;
		this.fills = init.fills;
		this.capabilities = githubCapabilities(init.fills);
		this.writer = new GitHubWriter({
			settings: init.settings,
			client: init.client,
			map: init.map,
			fills: init.fills,
			repoPath: this.repoPath,
			issueUrl: init.issueUrl,
			loadIssue: (id, options) => this.issue(id, options),
			readRecord: id => this.get(id),
			related: path => this.related(path),
			mayHaveChildren: issue => this.mayHaveChildren(issue),
		});
	}

	// ---------------------------------------------------------------- ids

	private numberOf(id: string): number | undefined {
		const match = /^#?(\d+)$/.exec(id.trim());
		return match === null ? undefined : Number(match[1]);
	}

	// ---------------------------------------------------------------- raw reads

	/**
	 * The issue as GitHub holds it; a missing, deleted or pull-request number is TaskNotFoundError under the id the caller used (a
	 * tombstone is still an issue: it is hidden from the lists, not from a read by number). `revalidate`: ask GitHub even inside the cache TTL (a write re-reads before it writes).
	 */
	private async issue(
		id: string,
		options: { revalidate?: boolean } = {}
	): Promise<{ issue: ApiIssue; response: ClientResponse<ApiIssue> }> {
		const number = this.numberOf(id);
		if (number === undefined) throw new TaskNotFoundError(id);
		let response: ClientResponse<ApiIssue>;
		try {
			response = await this.client.get<ApiIssue>(`${this.repoPath}/issues/${number}`, {
				allowNotFound: true,
				...(options.revalidate === true ? { revalidate: true } : {}),
			});
		} catch (error) {
			if (error instanceof GitHubHttpError && error.status === 410) throw new TaskNotFoundError(id);
			throw error;
		}
		if (response.status === 404 || isPullRequest(response.body)) throw new TaskNotFoundError(id);
		return { issue: response.body, response };
	}

	private async issuesAll(): Promise<{ issues: ApiIssue[]; stale: boolean }> {
		const all = await this.client.getAll<ApiIssue>(`${this.repoPath}/issues`, {
			query: { state: 'all', per_page: this.settings.pageSize, sort: 'created', direction: 'asc' },
		});
		const issues = all.items.filter(issue => !isPullRequest(issue) && !isTombstone(issue));
		issues.push(...(await this.missingRecent(new Set(issues.map(issue => issue.number)), 0)));
		return { issues, stale: all.stale };
	}

	/**
	 * The issues task created lately that a list does not show yet (the list lags a creation by seconds: measured), read by number.
	 * One request each, only while the list lacks them; a deleted or hidden one is skipped.
	 */
	private async missingRecent(seen: ReadonlySet<number>, above: number): Promise<ApiIssue[]> {
		const found: ApiIssue[] = [];
		for (const number of this.client.recently('created', CREATION_MEMORY_MS)) {
			if (seen.has(number) || number <= above) continue;
			try {
				const { issue } = await this.issue(String(number));
				if (!isTombstone(issue)) found.push(issue);
			} catch (error) {
				if (!(error instanceof TaskNotFoundError)) throw error;
			}
		}
		return found;
	}

	/** The issues on the other end of a relation list (`dependencies/...`, `sub_issues`), this repository's only. */
	private async related(path: string): Promise<ApiIssue[]> {
		const all = await this.client.getAll<ApiIssue>(path, { query: { per_page: this.settings.pageSize } });
		const own: ApiIssue[] = [];
		for (const issue of all.items) {
			if (isPullRequest(issue) || isTombstone(issue)) continue;
			const repoUrl = (issue as { repository_url?: string }).repository_url;
			if (repoUrl !== undefined && !this.sameRepository(repoUrl)) {
				this.map.notice({
					kind: 'ignored',
					text: `a related issue #${issue.number} of ${repoUrl} is in another repository and is not a task of this project`,
				});
				continue;
			}
			own.push(issue);
		}
		return own;
	}

	private sameRepository(repositoryUrl: string): boolean {
		return repositoryUrl.toLowerCase().endsWith(`/repos/${this.settings.repo.full.toLowerCase()}`);
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
		const filtered = parentId !== undefined || statusIn !== undefined || text !== undefined;
		const perPage =
			limit !== undefined && !filtered ? Math.min(limit, this.settings.pageSize) : this.settings.pageSize;
		const start = cursor === undefined ? undefined : decodeCursor(cursor);
		const searching = text !== undefined;
		let url = start?.u;
		if (url === undefined) {
			url = searching ? this.searchUrl(text, perPage, 1) : this.listUrl(perPage);
		}
		let skip = start?.s ?? 0;
		let maxSeen = start?.m ?? 0;
		const items: TaskSummary[] = [];
		const matches = (summary: TaskSummary): boolean =>
			(statusIn === undefined || statusIn.includes(summary.status)) &&
			(parentId === undefined ||
				(parentId === null ? summary.parentId === undefined : summary.parentId === parentId));

		for (let pages = 0; url !== undefined && url !== OVERLAY; pages++) {
			if (pages >= this.settings.maxPages) {
				throw new BackendLimitError(
					'github',
					'pages per read',
					this.settings.maxPages,
					'Raise strategy.options.maxPages in the project config, or ask for a narrower page.'
				);
			}
			const page: ClientResponse<ApiIssue[] | { items: ApiIssue[] }> = await this.client.getUrl(url, {
				cache: !searching,
			});
			const issues = (Array.isArray(page.body) ? page.body : page.body.items).filter(
				issue => !isPullRequest(issue) && !isTombstone(issue)
			);
			for (let index = skip; index < issues.length; index++) {
				const summary = toSummary(issues[index]!, this.map);
				if (!matches(summary)) {
					maxSeen = Math.max(maxSeen, issues[index]!.number);
					continue;
				}
				if (limit !== undefined && items.length === limit) {
					// One more match exists: the next page starts at it.
					return { items, nextCursor: encodeCursor({ u: url, s: index, m: maxSeen }) };
				}
				maxSeen = Math.max(maxSeen, issues[index]!.number);
				items.push(summary);
			}
			skip = 0;
			url = searching ? this.nextSearchUrl(url, issues.length, perPage, page.body) : page.next;
		}
		if (searching) return { items };
		// The list is read to its end. The issues task created lately and the list does not show yet come last (their numbers are the
		// highest), by number; a page limit may stop in the middle of them.
		const skipRecent = url === OVERLAY ? skip : 0;
		const recent = (await this.missingRecent(new Set(), maxSeen)).slice(skipRecent);
		for (const [index, issue] of recent.entries()) {
			const summary = toSummary(issue, this.map);
			if (!matches(summary)) continue;
			if (limit !== undefined && items.length === limit) {
				return { items, nextCursor: encodeCursor({ u: OVERLAY, s: skipRecent + index, m: maxSeen }) };
			}
			items.push(summary);
		}
		return { items };
	}

	private listUrl(perPage: number): string {
		const url = new URL(`${this.settings.baseUrl}${this.repoPath}/issues`);
		for (const [key, value] of [
			['direction', 'asc'],
			['per_page', String(perPage)],
			['sort', 'created'],
			['state', 'all'],
		] as const) {
			url.searchParams.set(key, value);
		}
		return url.toString();
	}

	private searchUrl(text: string, perPage: number, page: number): string {
		const url = new URL(`${this.settings.baseUrl}/search/issues`);
		// The text is one quoted phrase: a word like `label:x` is text here, never a qualifier.
		const phrase = text.replace(/["\\]/g, ' ').trim();
		url.searchParams.set('q', `repo:${this.settings.repo.full} is:issue in:title "${phrase}"`);
		url.searchParams.set('sort', 'created');
		url.searchParams.set('order', 'asc');
		url.searchParams.set('per_page', String(perPage));
		url.searchParams.set('page', String(page));
		return url.toString();
	}

	private nextSearchUrl(
		current: string,
		count: number,
		perPage: number,
		body: ApiIssue[] | { items: ApiIssue[]; total_count?: number }
	): string | undefined {
		const total = !Array.isArray(body) && typeof body.total_count === 'number' ? body.total_count : 0;
		const page = Number(new URL(current).searchParams.get('page') ?? 1);
		// The Search API stops at 1000 results.
		if (count === 0 || page * perPage >= Math.min(total, 1000)) return undefined;
		const next = new URL(current);
		next.searchParams.set('page', String(page + 1));
		return next.toString();
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

	/**
	 * The fields of the task from the issue alone: ONE read (conditional, free inside the cache TTL), where `findByPrefix` is the
	 * issue, its timeline, its comments and its blockers. GitHub ids are assigned numbers, so there is nothing to resolve but the
	 * number: a text that is not one is "not found" exactly as for `get`. The same mapping as `recordOf` (a test compares them).
	 */
	async resolve(prefix: string): Promise<ResolvedTask> {
		const { issue, response } = await this.issue(prefix);
		const { description } = splitBody(issue, this.map);
		const parent = parentNumber(issue, this.map);
		const type = typeOf(issue, this.map);
		const labels = userLabels(issue, this.map);
		const meta = metaOf(issue, this.map);
		return {
			id: String(issue.number),
			title: issue.title,
			...(description === undefined ? {} : { description }),
			status: statusOfIssue(issue, this.map),
			...(parent === undefined ? {} : { parentId: String(parent) }),
			...(type === undefined ? {} : { type }),
			...(labels.length === 0 ? {} : { labels }),
			...(meta === undefined ? {} : { meta }),
			createdAt: iso(issue.created_at),
			updatedAt: iso(issue.updated_at),
			revision: revisionOf(issue, response.etag, this.map),
		};
	}

	async listLabels(): Promise<LabelCount[]> {
		const { issues } = await this.issuesAll();
		const counts = new Map<string, { label: string; count: number }>();
		for (const issue of issues) {
			for (const label of userLabels(issue, this.map)) {
				// GitHub label names are unique whatever their case.
				const entry = counts.get(label.toLowerCase()) ?? { label, count: 0 };
				entry.count += 1;
				counts.set(label.toLowerCase(), entry);
			}
		}
		return [...counts.values()].sort(
			(a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
		);
	}

	/** The whole record of an issue: the issue, its comments, its timeline and its blockers, fetched together. */
	private async recordOf(issue: ApiIssue, response: ClientResponse<ApiIssue>): Promise<VersionedRecord> {
		const number = issue.number;
		const base = `${this.repoPath}/issues/${number}`;
		const query = { per_page: this.settings.pageSize };
		const [comments, timeline, blockers] = await Promise.all([
			issue.comments > 0 ? this.client.getAll<ApiComment>(`${base}/comments`, { query }) : undefined,
			this.client.getAll<ApiEvent>(`${base}/timeline`, { query }),
			this.mayHaveBlockers(issue) ? this.related(`${base}/dependencies/blocked_by`) : [],
		]);
		const { description, duplicateOf } = splitBody(issue, this.map);
		const status = statusOfIssue(issue, this.map);
		const parent = parentNumber(issue, this.map);
		const type = typeOf(issue, this.map);
		const labels = userLabels(issue, this.map);
		const meta = metaOf(issue, this.map);
		const links = linksOf(
			blockers.map(blocker => blocker.number),
			duplicateOf
		);
		const activity = activityOf(timeline.items, this.map);
		const stales = [response, comments, timeline].filter(part => part !== undefined && part.stale === true);
		const oldest = stales
			.map(part => (part as { cachedAt?: string }).cachedAt)
			.filter((at): at is string => at !== undefined)
			.sort()[0];
		const record: TaskRecord = {
			id: String(number),
			title: issue.title,
			...(description === undefined ? {} : { description }),
			status,
			...(links.length === 0 ? {} : { links }),
			...(parent === undefined ? {} : { parentId: String(parent) }),
			...(type === undefined ? {} : { type }),
			...(labels.length === 0 ? {} : { labels }),
			...(meta === undefined ? {} : { meta }),
			createdAt: iso(issue.created_at),
			updatedAt: iso(issue.updated_at),
			history: replayHistory(issue, timeline.items, this.map, status),
			...(activity.length === 0 ? {} : { activity }),
			...(comments === undefined || comments.items.length === 0 ? {} : { comments: commentsOf(comments.items) }),
		};
		return {
			...record,
			revision: revisionOf(issue, response.etag, this.map),
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
				'github',
				`issue #${id}`,
				`issue #${id} names #${first.target} as the task it duplicates, but that issue does not exist`,
				`Fix or remove the task block of ${this.issueUrl(Number(id.replace('#', '')))}`
			);
		}
		return links;
	}

	async getLinksLenient(id: string): Promise<{ links: TaskLinks; dangling: TaskLink[] }> {
		const { issue } = await this.issue(id);
		const base = `${this.repoPath}/issues/${issue.number}/dependencies`;
		const [blockedBy, blocks] = await Promise.all([
			this.mayHaveBlockers(issue) ? this.related(`${base}/blocked_by`) : [],
			this.mayBlockOthers(issue) ? this.related(`${base}/blocking`) : [],
		]);
		const links: TaskLinks = {
			blockedBy: blockedBy.map(item => toSummary(item, this.map)),
			blocks: blocks.map(item => toSummary(item, this.map)),
			duplicateOf: [],
			// GitHub keeps no readable target for a duplicate (design 2.2.1): the inverse is read from the managed blocks of the other
			// issues, only when the project declared the duplicate-marker fill (it costs one read of the list).
			duplicates: await this.duplicatesOf(issue),
			causedBy: [],
			causes: [],
		};
		const dangling: TaskLink[] = [];
		const { duplicateOf } = splitBody(issue, this.map);
		if (duplicateOf !== undefined) {
			try {
				links.duplicateOf.push(toSummary((await this.issue(duplicateOf)).issue, this.map));
			} catch (error) {
				if (!(error instanceof TaskNotFoundError)) throw error;
				dangling.push({ type: 'duplicateOf', target: duplicateOf });
			}
		}
		return { links, dangling };
	}

	async getOpenBlockers(id: string, isTerminal: (status: TaskStatus) => boolean): Promise<TaskSummary[]> {
		return (await this.getLinksLenient(id)).links.blockedBy.filter(task => !isTerminal(task.status));
	}

	async getUnblockedBy(blockerId: string, isTerminal: (status: TaskStatus) => boolean): Promise<TaskSummary[]> {
		const { issue } = await this.issue(blockerId);
		if (!isTerminal(statusOfIssue(issue, this.map))) return [];
		if (!this.mayBlockOthers(issue)) return [];
		const blocked = await this.related(`${this.repoPath}/issues/${issue.number}/dependencies/blocking`);
		const unblocked: TaskSummary[] = [];
		for (const candidate of blocked) {
			const summary = toSummary(candidate, this.map);
			if (isTerminal(summary.status)) continue;
			const blockers = await this.related(`${this.repoPath}/issues/${candidate.number}/dependencies/blocked_by`);
			if (blockers.every(other => isTerminal(statusOfIssue(other, this.map)))) unblocked.push(summary);
		}
		return unblocked;
	}

	async getChildren(id: string): Promise<TaskSummary[]> {
		const { issue } = await this.issue(id);
		return (await this.childrenOf(issue)).map(child => toSummary(child, this.map));
	}

	private async childrenOf(issue: ApiIssue): Promise<ApiIssue[]> {
		if (!this.mayHaveChildren(issue)) return [];
		const children = await this.related(`${this.repoPath}/issues/${issue.number}/sub_issues`);
		if (children.length > MAX_CHILDREN) {
			throw new BackendLimitError(
				'github',
				'sub-issues per parent',
				MAX_CHILDREN,
				`#${issue.number} lists ${children.length} sub-issues; GitHub allows ${MAX_CHILDREN}. Check ${this.issueUrl(issue.number)}`
			);
		}
		return children;
	}

	async getTree(id: string): Promise<TaskTreeNode> {
		const { issue } = await this.issue(id);
		return this.treeOf(issue, 1, new Set());
	}

	private async treeOf(issue: ApiIssue, depth: number, seen: Set<number>): Promise<TaskTreeNode> {
		if (depth > MAX_DEPTH) {
			throw new BackendLimitError(
				'github',
				'sub-issue depth',
				MAX_DEPTH,
				`The sub-issues below #${issue.number} go deeper than ${MAX_DEPTH} levels, which GitHub does not allow; check ${this.issueUrl(issue.number)}`
			);
		}
		if (seen.has(issue.number)) {
			throw new BackendDataError(
				'github',
				`issue #${issue.number}`,
				`issue #${issue.number} is its own ancestor in the sub-issue tree`,
				`Remove the sub-issue link that closes the loop on ${this.issueUrl(issue.number)}`
			);
		}
		seen.add(issue.number);
		const node: TaskTreeNode = { ...toSummary(issue, this.map), children: [] };
		for (const child of await this.childrenOf(issue)) {
			node.children.push(await this.treeOf(child, depth + 1, seen));
		}
		return node;
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
					'github',
					`issue #${node.id}`,
					`issue #${node.id} is its own ancestor in the sub-issue tree`,
					`Remove the sub-issue link that closes the loop on ${this.issueUrl(Number(node.id))}`
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
		seen.add(issue.number);
		for (;;) {
			const parent = parentNumber(issue, this.map);
			if (parent === undefined) return ancestors;
			if (seen.has(parent) || ancestors.length >= MAX_DEPTH) {
				throw new BackendLimitError(
					'github',
					'sub-issue depth',
					MAX_DEPTH,
					`The parents of #${id} loop or go deeper than ${MAX_DEPTH} levels; check ${this.issueUrl(parent)}`
				);
			}
			seen.add(parent);
			({ issue } = await this.issue(String(parent)));
			ancestors.push(toSummary(issue, this.map));
		}
	}

	async getFullTree(id: string): Promise<TaskTreeNode> {
		const ancestors = await this.getAncestors(id);
		const rootId = ancestors.at(-1)?.id ?? (await this.issue(id)).issue.number.toString();
		const tree = await this.getTree(rootId);
		const pending: TaskTreeNode[] = [tree];
		const target = String(this.numberOf(id));
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

	/**
	 * Whether the dependency lists of an issue are worth reading: its counts say it has some, or task changed its dependencies a moment
	 * ago and GitHub has not counted them yet (the counts lag; the lists do not).
	 */
	private mayHaveBlockers(issue: ApiIssue): boolean {
		return (issue.issue_dependencies_summary?.total_blocked_by ?? 0) > 0 || this.touchedDependencies(issue);
	}

	private mayBlockOthers(issue: ApiIssue): boolean {
		return (issue.issue_dependencies_summary?.total_blocking ?? 0) > 0 || this.touchedDependencies(issue);
	}

	private touchedDependencies(issue: ApiIssue): boolean {
		return this.client.recently('dependencies', COUNT_MEMORY_MS).includes(issue.number);
	}

	/**
	 * Whether the sub-issue list of an issue is worth reading: its count says it has some, or task attached a sub-issue to it a moment
	 * ago and GitHub has not counted it yet (the count lags; the list does not).
	 */
	private mayHaveChildren(issue: ApiIssue): boolean {
		return (
			(issue.sub_issues_summary?.total ?? 0) > 0 ||
			this.client.recently('subIssues', COUNT_MEMORY_MS).includes(issue.number)
		);
	}

	/** The issues whose managed block says they duplicate this one (fills.linkTypes.duplicateOf: duplicate-marker only). */
	private async duplicatesOf(issue: ApiIssue): Promise<TaskSummary[]> {
		if (this.fills['linkTypes.duplicateOf']?.use !== 'duplicate-marker') return [];
		const { issues } = await this.issuesAll();
		const found: TaskSummary[] = [];
		for (const other of issues) {
			if (other.number === issue.number || !(other.body ?? '').includes('task:begin')) continue;
			try {
				if (splitBody(other, this.map).duplicateOf === String(issue.number))
					found.push(toSummary(other, this.map));
			} catch (error) {
				// A block that cannot be read is reported when that issue itself is read; it must not hide the others here.
				if (!(error instanceof BackendDataError)) throw error;
				this.map.notice({
					kind: 'ignored',
					text: `${error.message}; it was skipped while looking for the duplicates of #${issue.number}`,
				});
			}
		}
		return found;
	}

	// ---------------------------------------------------------------- writes (githubWrites.ts)

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
