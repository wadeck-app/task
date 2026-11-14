// GitHub issue JSON -> task shapes, pure: summaries for lists, the record for a read, the status history replayed from the
// timeline, the activity rows, the comments. Nothing here talks to the network; the backend feeds it what it fetched.
//
// Mapping (design 2.1; each row is documented in CLAUDE.md "Storage strategy"):
//   id            the issue number as a string (`ids: assigned`)
//   title         the issue title
//   description   the body without the managed task block; absent when empty or equal to the title (CRLF read as LF)
//   status        state + state_reason + the status labels, through the statusMap (statusMapping.ts)
//   labels        the issue labels without the status labels, the type labels and (with fills.meta: labels) the meta labels
//   type          a type label (typePrefix), else a native issue type that typeMap or the project's types name
//   meta          only with fills.meta: labels: labels `meta:key=value`
//   parentId      `parent_issue_url` (same repository only)
//   links         blockedBy from the dependencies; duplicateOf from the managed block when present
//   history       replayed from the timeline: labeled / unlabeled / closed / reopened through the same status mapping
//   activity      the other timeline events, mapped to the activity kinds of the local log (`other` for those without one)
import { activityPreview, BackendDataError } from '@wadeck-app/task-core';
import type { ActivityEntry, TaskComment, TaskLink, TaskRecord, TaskSummary } from '@wadeck-app/task-core';

import { readManagedBlock } from '../forge-common/managedBlock.js';
import type { ReadNotice } from '../kinds.js';
import type { GitHubSettings } from './githubOptions.js';
import type { StatusMapper } from './statusMapping.js';

export interface ApiLabel {
	name: string;
}

/** The fields of a GitHub issue this strategy reads (REST, verified against the real API). */
export interface ApiIssue {
	id: number;
	node_id?: string;
	number: number;
	title: string;
	body: string | null;
	state: 'open' | 'closed';
	state_reason: string | null;
	labels: Array<ApiLabel | string>;
	type?: { name: string } | null;
	created_at: string;
	updated_at: string;
	comments: number;
	parent_issue_url?: string | null;
	sub_issues_summary?: { total: number; completed: number };
	issue_dependencies_summary?: { total_blocked_by: number; total_blocking: number };
	pull_request?: unknown;
}

export interface ApiComment {
	id: number;
	user: { login: string } | null;
	body: string;
	created_at: string;
	updated_at: string;
}

export interface ApiEvent {
	event: string;
	created_at?: string;
	actor?: { login: string } | null;
	[key: string]: unknown;
}

export interface MapContext {
	settings: GitHubSettings;
	mapper: StatusMapper;
	/** `fills.meta: labels` is declared: meta labels are meta, not labels. */
	metaFromLabels: boolean;
	/** `fills.meta: body-block` is declared: the meta is read from the managed block of the body. */
	metaFromBlock: boolean;
	/** The valid task types of the project (empty = any). */
	projectTypes: readonly string[];
	/** Called for something left out of a read that the user should know. */
	notice: (notice: ReadNotice) => void;
	issueUrl: (number: number) => string;
}

export const iso = (instant: string): string => new Date(instant).toISOString();

export function isPullRequest(issue: ApiIssue): boolean {
	return issue.pull_request !== undefined && issue.pull_request !== null;
}

export function labelNames(issue: ApiIssue): string[] {
	return issue.labels.map(label => (typeof label === 'string' ? label : label.name));
}

/** The label of a deleted task when `fills.delete: tombstone` is declared: such an issue is hidden from every read. Reserved. */
export const TOMBSTONE_LABEL = 'task:deleted';

export function isTombstone(issue: ApiIssue): boolean {
	return labelNames(issue).some(name => name.toLowerCase() === TOMBSTONE_LABEL);
}

const ISSUE_PATH = /\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;

/** The label events of an issue created with labels come about a second after its creation (measured on the real API). */
const CREATION_WINDOW_MS = 2000;
/** Events of one request are at most a second apart (measured); two status changes closer than that read as one. */
const GROUP_WINDOW_MS = 1000;

/** The number in an issue API URL when it is an issue of the configured repository; undefined for another repository. */
export function numberInRepo(url: string, repoFull: string): number | 'other' {
	const match = ISSUE_PATH.exec(new URL(url).pathname);
	if (match === null) return 'other';
	return `${match[1]}/${match[2]}`.toLowerCase() === repoFull.toLowerCase() ? Number(match[3]) : 'other';
}

/** The parent of an issue in this repository. A parent in another repository is not a task here: left out, and said. */
export function parentNumber(issue: ApiIssue, ctx: MapContext): number | undefined {
	const url = issue.parent_issue_url;
	if (url === undefined || url === null) return undefined;
	const number = numberInRepo(url, ctx.settings.repo.full);
	if (number === 'other') {
		ctx.notice({
			kind: 'ignored',
			text: `issue #${issue.number} has a parent in another repository (${url}); it shows as a root task here`,
		});
		return undefined;
	}
	return number;
}

export function statusOfIssue(issue: ApiIssue, ctx: MapContext): string {
	return ctx.mapper.statusOf({
		number: issue.number,
		state: issue.state,
		stateReason: issue.state_reason,
		labels: labelNames(issue),
	});
}

export function toSummary(issue: ApiIssue, ctx: MapContext): TaskSummary {
	const parent = parentNumber(issue, ctx);
	return {
		id: String(issue.number),
		title: issue.title,
		status: statusOfIssue(issue, ctx),
		createdAt: iso(issue.created_at),
		...(parent === undefined ? {} : { parentId: String(parent) }),
	};
}

/// ---- body: description and the managed block ----

export interface BodyParts {
	description: string | undefined;
	/** The target of `duplicateOf` the managed block holds. */
	duplicateOf: string | undefined;
	/** The meta the managed block holds (always read; only used with `fills.meta: body-block`). */
	blockMeta: Record<string, string> | undefined;
	/** The whole content of the managed block, to be written back with a change; absent when the body has no block. */
	blockData: Record<string, unknown> | undefined;
	/** The body without the block, trimmed (CRLF as LF): what a write puts back in front of the block. */
	visibleText: string;
}

/**
 * Splits the body of an issue: the managed block (HTML comment holding JSON, written by task) is removed from the description and
 * read for the links GitHub cannot return. A block that cannot be read is an error naming the issue, never a guess.
 */
export function splitBody(issue: ApiIssue, ctx: MapContext): BodyParts {
	const raw = (issue.body ?? '').replace(/\r\n/g, '\n');
	const block = readManagedBlock({
		raw,
		backendKind: 'github',
		forgeName: 'GitHub',
		subject: `issue #${issue.number}`,
		issueUrl: ctx.issueUrl(issue.number),
		linkTypes: ['duplicateOf'],
	});
	// The last `duplicateOf` of the block wins.
	const duplicateOf = block.links.at(-1)?.target;
	const trimmed = block.text.trim();
	return {
		description: trimmed === '' || trimmed === issue.title ? undefined : trimmed,
		duplicateOf,
		blockMeta: block.blockMeta,
		blockData: block.blockData,
		visibleText: trimmed,
	};
}

// ---- labels, type, meta ----

function lower(text: string): string {
	return text.toLowerCase();
}

function isTypeLabel(name: string, ctx: MapContext): boolean {
	const { typePrefix, typeMap } = ctx.settings;
	return (
		lower(name).startsWith(lower(typePrefix)) ||
		Object.values(typeMap).some(rule => rule.label !== undefined && lower(rule.label) === lower(name))
	);
}

function isMetaLabel(name: string, ctx: MapContext): boolean {
	return ctx.metaFromLabels && lower(name).startsWith(lower(ctx.settings.metaPrefix));
}

/** Labels that are neither a status, a type nor (with the fill) a meta entry. */
export function userLabels(issue: ApiIssue, ctx: MapContext): string[] {
	return labelNames(issue).filter(
		name => !ctx.mapper.isStatusLabel(name) && !isTypeLabel(name, ctx) && !isMetaLabel(name, ctx)
	);
}

/** The task type name of a type label, or undefined when the label is not one. */
export function typeOfLabel(name: string, ctx: MapContext): string | undefined {
	const { typePrefix, typeMap } = ctx.settings;
	for (const [type, rule] of Object.entries(typeMap)) {
		if (rule.label !== undefined && lower(rule.label) === lower(name)) return type;
	}
	return lower(name).startsWith(lower(typePrefix)) ? name.slice(typePrefix.length) : undefined;
}

export function typeOf(issue: ApiIssue, ctx: MapContext): string | undefined {
	const fromLabels = labelNames(issue)
		.map(name => ({ name, type: typeOfLabel(name, ctx) }))
		.filter((entry): entry is { name: string; type: string } => entry.type !== undefined && entry.type !== '');
	if (fromLabels.length > 1) {
		throw new BackendDataError(
			'github',
			`issue #${issue.number}`,
			`issue #${issue.number} carries two type labels (${fromLabels.map(entry => entry.name).join(', ')})`,
			`Remove one of them on ${ctx.issueUrl(issue.number)}`
		);
	}
	if (fromLabels.length === 1) return fromLabels[0]!.type;
	const native = issue.type?.name;
	if (native === undefined || native === '') return undefined;
	const mapped = Object.entries(ctx.settings.typeMap).find(
		([, rule]) => rule.issueType !== undefined && lower(rule.issueType) === lower(native)
	);
	if (mapped !== undefined) return mapped[0];
	if (ctx.projectTypes.length === 0) return native;
	return ctx.projectTypes.find(type => lower(type) === lower(native));
}

export function metaOf(issue: ApiIssue, ctx: MapContext): Record<string, string> | undefined {
	if (ctx.metaFromBlock) {
		const meta = splitBody(issue, ctx).blockMeta;
		return meta === undefined || Object.keys(meta).length === 0 ? undefined : meta;
	}
	if (!ctx.metaFromLabels) return undefined;
	const meta: Record<string, string> = {};
	for (const name of labelNames(issue)) {
		if (!isMetaLabel(name, ctx)) continue;
		const rest = name.slice(ctx.settings.metaPrefix.length);
		const at = rest.indexOf('=');
		const key = at < 0 ? rest : rest.slice(0, at);
		if (key === '') {
			throw new BackendDataError(
				'github',
				`issue #${issue.number}`,
				`issue #${issue.number} has the meta label "${name}" without a key`,
				`Rename it ${ctx.settings.metaPrefix}<key>=<value> or remove it on ${ctx.issueUrl(issue.number)}`
			);
		}
		if (Object.hasOwn(meta, key)) {
			throw new BackendDataError(
				'github',
				`issue #${issue.number}`,
				`issue #${issue.number} has two meta labels for the key "${key}"`,
				`Remove one of them on ${ctx.issueUrl(issue.number)}`
			);
		}
		meta[key] = at < 0 ? '' : rest.slice(at + 1);
	}
	return Object.keys(meta).length === 0 ? undefined : meta;
}

// ---- comments ----

export function commentsOf(comments: readonly ApiComment[]): TaskComment[] {
	return comments.map(comment => ({
		id: String(comment.id),
		at: iso(comment.created_at),
		text: comment.body,
		...(comment.updated_at !== comment.created_at ? { editedAt: iso(comment.updated_at) } : {}),
		...(comment.user === null ? {} : { author: comment.user.login }),
	}));
}

// ---- timeline: history and activity ----

interface Replay {
	state: 'open' | 'closed';
	reason: string | null;
	labels: string[];
}

/**
 * The status history, rebuilt by replaying labeled / unlabeled / closed / reopened over the issue's life through the same status
 * mapping as a read. The first entry is the creation. States a replay passes through that no status maps (two status labels
 * for a moment, while one is swapped for another) are skipped. The last entry is always the status the issue has now.
 */
export function replayHistory(
	issue: ApiIssue,
	events: readonly ApiEvent[],
	ctx: MapContext,
	current: string
): TaskRecord['history'] {
	const createdAt = iso(issue.created_at);
	const state: Replay = { state: 'open', reason: null, labels: [] };
	const view = (): Parameters<StatusMapper['tryStatusOf']>[0] => ({
		number: issue.number,
		state: state.state,
		stateReason: state.reason,
		labels: state.labels,
	});
	const history: TaskRecord['history'] = [];
	const first = ctx.mapper.tryStatusOf(view());
	if (first !== undefined) history.push({ status: first, timestamp: createdAt });
	// The events one request produces (a label swapped and the issue closed by one PATCH) are one change, judged after the last of them,
	// so the status in between (the label gone, the issue not yet closed) never shows in the history. Measured on the real API: they
	// carry the same second, or two neighbouring seconds. So events within GROUP_WINDOW_MS (1 s) of the first one of a group are its members.
	const groups: ApiEvent[][] = [];
	for (const event of events) {
		if (event.created_at === undefined) continue;
		if (!['labeled', 'unlabeled', 'closed', 'reopened'].includes(event.event)) continue;
		const last = groups.at(-1);
		if (last !== undefined && Date.parse(event.created_at) - Date.parse(last[0]!.created_at!) <= GROUP_WINDOW_MS) {
			last.push(event);
		} else groups.push([event]);
	}
	for (const group of groups) {
		for (const event of group) {
			if (event.event === 'labeled' || event.event === 'unlabeled') {
				const name = (event['label'] as ApiLabel | undefined)?.name;
				if (name === undefined) continue;
				state.labels =
					event.event === 'labeled'
						? [...state.labels, name]
						: state.labels.filter(held => lower(held) !== lower(name));
			} else if (event.event === 'closed') {
				state.state = 'closed';
				// Measured: a `completed` close carries `state_reason: null` in the timeline.
				state.reason = (event['state_reason'] as string | null | undefined) ?? 'completed';
			} else {
				state.state = 'open';
				state.reason = null;
			}
		}
		const status = ctx.mapper.tryStatusOf(view());
		if (status === undefined || status === history.at(-1)?.status) continue;
		const timestamp = iso(group[0]!.created_at!);
		// An issue created with its status label shows the label event about a second after the creation (measured on the real
		// API): inside the creation window it is the creation status, not a change.
		if (history.length === 1 && Date.parse(timestamp) - Date.parse(createdAt) <= CREATION_WINDOW_MS) {
			history[0] = { status, timestamp: createdAt };
		} else history.push({ status, timestamp });
	}
	if (history.at(-1)?.status !== current) history.push({ status: current, timestamp: iso(issue.updated_at) });
	return history;
}

/** Events that mean something to a person reading the activity of a task, but have no task equivalent: shown as `other`. */
const OTHER_EVENTS = new Set([
	'assigned',
	'unassigned',
	'milestoned',
	'demilestoned',
	'locked',
	'unlocked',
	'transferred',
	'pinned',
	'unpinned',
	'cross-referenced',
]);

function numberOf(value: unknown): number | undefined {
	const number = (value as { number?: unknown } | undefined)?.number;
	return typeof number === 'number' ? number : undefined;
}

function repoOf(value: unknown): string | undefined {
	const repository = (value as { repository?: { full_name?: unknown } } | undefined)?.repository;
	return typeof repository?.full_name === 'string' ? repository.full_name : undefined;
}

/** The number of the issue an event names (`sub_issue`, `parent_issue`, `blocked_by`, `blocking`), when it is in this repository. */
function relatedInRepo(event: ApiEvent, key: string, ctx: MapContext): number | undefined {
	const related = event[key];
	const number = numberOf(related);
	if (number === undefined) return undefined;
	const repo = repoOf(related);
	return repo !== undefined && lower(repo) !== lower(ctx.settings.repo.full) ? undefined : number;
}

function otherDetail(event: ApiEvent): string | undefined {
	switch (event.event) {
		case 'assigned':
		case 'unassigned':
			return (event['assignee'] as { login?: string } | undefined)?.login;
		case 'locked':
			return (event['lock_reason'] as string | null | undefined) ?? undefined;
		case 'milestoned':
		case 'demilestoned':
			return (event['milestone'] as { title?: string } | undefined)?.title;
		case 'cross-referenced': {
			const number = numberOf((event['source'] as { issue?: unknown } | undefined)?.issue);
			return number === undefined ? undefined : `#${number}`;
		}
		default:
			return undefined;
	}
}

/**
 * The activity rows of an issue (everything but status changes and comments), oldest first, in the vocabulary of the local log.
 * An event with no task equivalent that a person would want to see becomes `other` (its name in `field`); the rest of GitHub's
 * bookkeeping events (subscribed, mentioned, referenced...) is not activity of the task and is left out.
 */
export function activityOf(events: readonly ApiEvent[], ctx: MapContext): ActivityEntry[] {
	const rows: ActivityEntry[] = [];
	for (const event of events) {
		if (event.created_at === undefined) continue;
		const at = iso(event.created_at);
		const add = (kind: ActivityEntry['kind'], parts: Partial<Omit<ActivityEntry, 'at' | 'kind'>> = {}): void => {
			const defined = Object.entries(parts).filter(([, value]) => value !== undefined);
			rows.push({ at, kind, ...Object.fromEntries(defined) });
		};
		switch (event.event) {
			case 'labeled':
			case 'unlabeled': {
				const name = (event['label'] as ApiLabel | undefined)?.name;
				if (name === undefined || ctx.mapper.isStatusLabel(name)) break;
				const added = event.event === 'labeled';
				if (isTypeLabel(name, ctx)) {
					const type = typeOfLabel(name, ctx);
					add('type', added ? { newValue: type } : { oldValue: type });
				} else if (isMetaLabel(name, ctx)) {
					const rest = name.slice(ctx.settings.metaPrefix.length);
					const at2 = rest.indexOf('=');
					const key = at2 < 0 ? rest : rest.slice(0, at2);
					const value = at2 < 0 ? '' : rest.slice(at2 + 1);
					add(
						added ? 'meta-set' : 'meta-removed',
						added ? { field: key, newValue: value } : { field: key, oldValue: value }
					);
				} else {
					add(added ? 'label-added' : 'label-removed', added ? { newValue: name } : { oldValue: name });
				}
				break;
			}
			case 'renamed': {
				const rename = event['rename'] as { from?: string; to?: string } | undefined;
				add('title', {
					oldValue: rename?.from === undefined ? undefined : activityPreview(rename.from),
					newValue: rename?.to === undefined ? undefined : activityPreview(rename.to),
				});
				break;
			}
			case 'issue_type_added':
			case 'issue_type_changed':
			case 'issue_type_removed': {
				const name = (event['issue_type'] as { name?: string } | undefined)?.name;
				if (event.event === 'issue_type_removed') add('type');
				else add('type', { newValue: name });
				break;
			}
			case 'sub_issue_added':
			case 'sub_issue_removed': {
				const child = relatedInRepo(event, 'sub_issue', ctx);
				if (child === undefined) break;
				add(event.event === 'sub_issue_added' ? 'child-added' : 'child-removed', {
					target: String(child),
					inverse: true,
				});
				break;
			}
			case 'parent_issue_added':
			case 'parent_issue_removed': {
				const parent = relatedInRepo(event, 'parent_issue', ctx);
				if (parent === undefined) break;
				add(
					'parent',
					event.event === 'parent_issue_added' ? { newValue: String(parent) } : { oldValue: String(parent) }
				);
				break;
			}
			case 'blocked_by_added':
			case 'blocked_by_removed': {
				const target = relatedInRepo(event, 'blocked_by', ctx);
				if (target === undefined) break;
				add(event.event === 'blocked_by_added' ? 'link-added' : 'link-removed', {
					field: 'blockedBy',
					target: String(target),
				});
				break;
			}
			case 'blocking_added':
			case 'blocking_removed': {
				const target = relatedInRepo(event, 'blocking', ctx);
				if (target === undefined) break;
				add(event.event === 'blocking_added' ? 'link-added' : 'link-removed', {
					field: 'blockedBy',
					target: String(target),
					inverse: true,
				});
				break;
			}
			default:
				if (OTHER_EVENTS.has(event.event)) add('other', { field: event.event, newValue: otherDetail(event) });
		}
	}
	return rows;
}

/** blockedBy links from the issues the dependencies endpoint returned. */
export function linksOf(blockers: readonly number[], duplicateOf: string | undefined): TaskLink[] {
	return [
		...blockers.map((target): TaskLink => ({ type: 'blockedBy', target: String(target) })),
		...(duplicateOf === undefined ? [] : [{ type: 'duplicateOf' as const, target: duplicateOf }]),
	];
}

export { composeBody } from '../forge-common/managedBlock.js';
