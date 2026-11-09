// GitLab issue JSON -> task shapes, pure: summaries for lists, the record for a read, the status history replayed from the label and
// state events, the activity rows, the comments. Nothing here talks to the network; the backend feeds it what it fetched.
//
// NOT VERIFIED AGAINST A REAL GITLAB. Mapping (design 2.1; each row is documented in CLAUDE.md "Storage strategy: gitlab"):
//   id            the issue iid as a string (`ids: assigned`)
//   title         the issue title
//   description   the description without the managed task block; absent when empty or equal to the title (CRLF read as LF)
//   status        state (opened/closed) + the status labels, through the statusMap (gitlabStatusMapping.ts)
//   labels        the issue labels without the status labels, the type labels and (with fills.meta: labels) the meta labels
//   type          a type label (typePrefix / typeMap.label), else a native issue_type that typeMap names (incident, test_case)
//   meta          only with fills.meta: labels (`meta:key=value`, or the scoped `meta::key::value` on Premium and Ultimate) or body-block
//   parentId      none: the REST API has no parent of an issue (capability hierarchy: none)
//   links         blockedBy from the issue links (premium and ultimate); duplicateOf / causedBy from the managed block when declared
//   history       replayed from resource_label_events + resource_state_events through the same status mapping
//   activity      the label events that are not status labels (type, meta, labels); system notes are text and are not read
import { BackendDataError } from '@wadeck-app/task-core';
import type { ActivityEntry, TaskComment, TaskLink, TaskRecord, TaskSummary } from '@wadeck-app/task-core';

import type { ReadNotice } from '../kinds.js';
import type { GitLabSettings } from './gitlabOptions.js';
import type { StatusMapper } from './gitlabStatusMapping.js';
import type { ApiIssue, ApiLabelEvent, ApiNote, ApiStateEvent } from './gitlabTypes.js';

export interface MapContext {
	settings: GitLabSettings;
	mapper: StatusMapper;
	/** `fills.meta: labels` is declared: meta labels are meta, not labels. */
	metaFromLabels: boolean;
	/** `fills.meta: body-block` is declared: the meta is read from the managed block of the description. */
	metaFromBlock: boolean;
	/** The valid task types of the project (empty = any). */
	projectTypes: readonly string[];
	/** Called for something left out of a read that the user should know. */
	notice: (notice: ReadNotice) => void;
	/** The page of an issue on GitLab, for the fix a message gives. */
	issueUrl: (iid: number) => string;
}

export const iso = (instant: string): string => new Date(instant).toISOString();

export function labelNames(issue: ApiIssue): string[] {
	return issue.labels.map(label => (typeof label === 'string' ? label : label.name));
}

/** The label of a deleted task when `fills.delete: tombstone` is declared: such an issue is hidden from every read. Reserved. */
export const TOMBSTONE_LABEL = 'task:deleted';

export function isTombstone(issue: ApiIssue): boolean {
	return labelNames(issue).some(name => name.toLowerCase() === TOMBSTONE_LABEL);
}

export function statusOfIssue(issue: ApiIssue, ctx: MapContext): string {
	return ctx.mapper.statusOf({ iid: issue.iid, state: issue.state, labels: labelNames(issue) });
}

export function toSummary(issue: ApiIssue, ctx: MapContext): TaskSummary {
	return {
		id: String(issue.iid),
		title: issue.title,
		status: statusOfIssue(issue, ctx),
		createdAt: iso(issue.created_at),
	};
}

// ---- description: the visible text and the managed block ----

const BLOCK = /<!--\s*task:begin\s+v(\d+)\s*-->([\s\S]*?)<!--\s*task:end\s*-->/;
const BLOCK_BEGIN = /<!--\s*task:begin\b/;

export interface BodyParts {
	description: string | undefined;
	/** The links the managed block holds (`duplicateOf`, `causedBy`): what GitLab cannot return. */
	blockLinks: TaskLink[];
	/** The meta the managed block holds (always read; only used with `fills.meta: body-block`). */
	blockMeta: Record<string, string> | undefined;
	/** The whole content of the managed block, to be written back with a change; absent when the description has no block. */
	blockData: Record<string, unknown> | undefined;
	/** The description without the block, trimmed (CRLF as LF): what a write puts back in front of the block. */
	visibleText: string;
}

/**
 * Splits the description of an issue: the managed block (HTML comment holding JSON, written by task) is removed from the description
 * and read for the links GitLab cannot return. A block that cannot be read is an error naming the issue, never a guess.
 */
export function splitBody(issue: ApiIssue, ctx: MapContext): BodyParts {
	const raw = (issue.description ?? '').replace(/\r\n/g, '\n');
	let text = raw;
	const blockLinks: TaskLink[] = [];
	let blockMeta: Record<string, string> | undefined;
	let blockData: Record<string, unknown> | undefined;
	const subject = `issue #${issue.iid}`;
	const fix = `Repair or remove the block between <!-- task:begin v1 --> and <!-- task:end --> on ${ctx.issueUrl(issue.iid)}`;
	const match = BLOCK.exec(raw);
	if (match === null && BLOCK_BEGIN.test(raw)) {
		throw new BackendDataError('gitlab', subject, `the task block of ${subject} has no end marker`, fix);
	}
	if (match !== null) {
		if (match[1] !== '1') {
			throw new BackendDataError(
				'gitlab',
				subject,
				`the task block of ${subject} has format v${match[1]}, which this version of task does not read`,
				'Update task (task cli update), or remove the block on GitLab'
			);
		}
		let data: unknown;
		try {
			data = JSON.parse(match[2]!);
		} catch (error) {
			throw new BackendDataError(
				'gitlab',
				subject,
				`the task block of ${subject} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
				fix
			);
		}
		if (typeof data !== 'object' || data === null || Array.isArray(data)) {
			throw new BackendDataError('gitlab', subject, `the task block of ${subject} is not a JSON object`, fix);
		}
		blockData = data as Record<string, unknown>;
		const meta = (data as { meta?: unknown }).meta;
		if (meta !== undefined) {
			if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
				throw new BackendDataError(
					'gitlab',
					subject,
					`the task block of ${subject} has a "meta" that is not an object`,
					fix
				);
			}
			blockMeta = {};
			for (const [key, value] of Object.entries(meta)) {
				if (typeof value !== 'string') {
					throw new BackendDataError(
						'gitlab',
						subject,
						`the task block of ${subject} has a meta value that is not a text (${key})`,
						fix
					);
				}
				blockMeta[key] = value;
			}
		}
		const links = (data as { links?: unknown }).links;
		if (links !== undefined) {
			if (!Array.isArray(links)) {
				throw new BackendDataError(
					'gitlab',
					subject,
					`the task block of ${subject} has a "links" that is not a list`,
					fix
				);
			}
			for (const link of links as Array<{ type?: unknown; target?: unknown }>) {
				if (
					(link?.type === 'duplicateOf' || link?.type === 'causedBy') &&
					(typeof link.target === 'string' || typeof link.target === 'number')
				) {
					blockLinks.push({ type: link.type, target: String(link.target) });
				}
			}
		}
		text = raw.replace(BLOCK, '');
	}
	const trimmed = text.trim();
	return {
		description: trimmed === '' || trimmed === issue.title ? undefined : trimmed,
		blockLinks,
		blockMeta,
		blockData,
		visibleText: trimmed,
	};
}

const blockOf = (data: Record<string, unknown>): string =>
	`<!-- task:begin v1 -->${JSON.stringify(data)}<!-- task:end -->`;

/** The description to write: the visible text, then the managed block when it holds anything (the block is last, an empty one is dropped). */
export function composeBody(visibleText: string, data: Record<string, unknown> | undefined): string {
	if (data === undefined || Object.keys(data).length === 0) return visibleText;
	return visibleText === ''
		? blockOf(data)
		: `${visibleText}

${blockOf(data)}`;
}

// ---- labels, type, meta ----

const lower = (text: string): string => text.toLowerCase();

export function isTypeLabel(name: string, ctx: MapContext): boolean {
	const { typePrefix, typeMap } = ctx.settings;
	return (
		lower(name).startsWith(lower(typePrefix)) ||
		Object.values(typeMap).some(rule => rule.label !== undefined && lower(rule.label) === lower(name))
	);
}

export function isMetaLabel(name: string, ctx: MapContext): boolean {
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
			'gitlab',
			`issue #${issue.iid}`,
			`issue #${issue.iid} carries two type labels (${fromLabels.map(entry => entry.name).join(', ')})`,
			`Remove one of them on ${ctx.issueUrl(issue.iid)}`
		);
	}
	if (fromLabels.length === 1) return fromLabels[0]!.type;
	const native = issue.issue_type;
	if (native === undefined || native === 'issue' || native === 'task') return undefined;
	const mapped = Object.entries(ctx.settings.typeMap).find(([, rule]) => rule.issueType === native);
	return mapped?.[0];
}

/** The label that holds one meta entry. Scoped (Premium, Ultimate): `meta::key::value`; plain: `meta:key=value`. */
export function metaLabelName(key: string, value: string, ctx: MapContext): string {
	const { metaPrefix, scopedLabels } = ctx.settings;
	return scopedLabels ? `${metaPrefix}${key}::${value}` : `${metaPrefix}${key}=${value}`;
}

/** Why this meta key or value cannot be a label, as a sentence; undefined when it can. */
export function metaLabelProblem(key: string, value: string, ctx: MapContext): string | undefined {
	if (key === '') return 'a metadata key cannot be empty';
	if (key.includes(',') || value.includes(',')) {
		return `the metadata "${key}" holds a comma, which cannot be part of a GitLab label name`;
	}
	if (key !== key.trim() || value !== value.trim()) {
		return `the metadata "${key}" starts or ends with a space, which GitLab trims from a label name`;
	}
	if (ctx.settings.scopedLabels) {
		if (key.includes('::') || value.includes('::')) {
			return `the metadata "${key}" contains "::", which delimits the scope of a GitLab scoped label`;
		}
		if (value === '') return `the metadata "${key}" is empty, which a scoped label meta::key::value cannot hold`;
		return undefined;
	}
	if (key.includes('=')) return `the metadata key "${key}" contains "=", which separates key and value in the label`;
	return undefined;
}

/** key and value of a meta label name; undefined when the name is not a meta label. Throws BackendDataError for a malformed scoped one. */
export function parseMetaLabel(name: string, ctx: MapContext, iid: number): { key: string; value: string } | undefined {
	if (!isMetaLabel(name, ctx)) return undefined;
	const rest = name.slice(ctx.settings.metaPrefix.length);
	if (ctx.settings.scopedLabels) {
		const at = rest.lastIndexOf('::');
		if (at <= 0 || at + 2 >= rest.length) {
			throw new BackendDataError(
				'gitlab',
				`issue #${iid}`,
				`issue #${iid} has the meta label "${name}", which is not of the form ${ctx.settings.metaPrefix}<key>::<value>`,
				`Rename or remove it on ${ctx.issueUrl(iid)}`
			);
		}
		return { key: rest.slice(0, at), value: rest.slice(at + 2) };
	}
	const at = rest.indexOf('=');
	const key = at < 0 ? rest : rest.slice(0, at);
	if (key === '') {
		throw new BackendDataError(
			'gitlab',
			`issue #${iid}`,
			`issue #${iid} has the meta label "${name}" without a key`,
			`Rename it ${ctx.settings.metaPrefix}<key>=<value> or remove it on ${ctx.issueUrl(iid)}`
		);
	}
	return { key, value: at < 0 ? '' : rest.slice(at + 1) };
}

export function metaOf(issue: ApiIssue, ctx: MapContext): Record<string, string> | undefined {
	if (ctx.metaFromBlock) {
		const meta = splitBody(issue, ctx).blockMeta;
		return meta === undefined || Object.keys(meta).length === 0 ? undefined : meta;
	}
	if (!ctx.metaFromLabels) return undefined;
	const meta: Record<string, string> = {};
	for (const name of labelNames(issue)) {
		const entry = parseMetaLabel(name, ctx, issue.iid);
		if (entry === undefined) continue;
		if (Object.hasOwn(meta, entry.key)) {
			throw new BackendDataError(
				'gitlab',
				`issue #${issue.iid}`,
				`issue #${issue.iid} has two meta labels for the key "${entry.key}"`,
				`Remove one of them on ${ctx.issueUrl(issue.iid)}`
			);
		}
		meta[entry.key] = entry.value;
	}
	return Object.keys(meta).length === 0 ? undefined : meta;
}

// ---- comments ----

/** The user notes of an issue as task comments; system notes (GitLab's own bookkeeping) are not comments. */
export function commentsOf(notes: readonly ApiNote[]): TaskComment[] {
	return notes
		.filter(note => !note.system)
		.map(note => ({
			id: String(note.id),
			at: iso(note.created_at),
			text: note.body,
			...(note.updated_at !== note.created_at ? { editedAt: iso(note.updated_at) } : {}),
			...(note.author === null ? {} : { author: note.author.username }),
		}));
}

// ---- label and state events: history and activity ----

interface Replay {
	state: 'opened' | 'closed';
	labels: string[];
}

/** Label events of an issue created with labels may come a moment after its creation (measured on GitHub; UNVERIFIED on GitLab). */
const CREATION_WINDOW_MS = 2000;
/** Events of one request (a label swapped and the issue closed by one PUT) are at most a second apart (measured on GitHub; UNVERIFIED on GitLab). */
const GROUP_WINDOW_MS = 1000;

type TimelineEvent =
	| { kind: 'label'; at: string; id: number; name: string; added: boolean }
	| { kind: 'state'; at: string; id: number; closed: boolean };

/** Both event lists as one sequence, oldest first. */
export function timelineOf(
	labelEvents: readonly ApiLabelEvent[],
	stateEvents: readonly ApiStateEvent[]
): TimelineEvent[] {
	const events: TimelineEvent[] = [];
	for (const event of labelEvents) {
		if (event.label === null) continue;
		events.push({
			kind: 'label',
			at: event.created_at,
			id: event.id,
			name: event.label.name,
			added: event.action === 'add',
		});
	}
	for (const event of stateEvents) {
		events.push({ kind: 'state', at: event.created_at, id: event.id, closed: event.state === 'closed' });
	}
	return events.sort(
		(a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.kind === b.kind ? a.id - b.id : a.kind === 'label' ? -1 : 1)
	);
}

/**
 * The status history, rebuilt by replaying label and state events over the issue's life through the same status mapping as a read.
 * The first entry is the creation. States a replay passes through that no status maps (two status labels for a moment, while one is
 * swapped for another) are skipped. The last entry is always the status the issue has now.
 */
export function replayHistory(
	issue: ApiIssue,
	labelEvents: readonly ApiLabelEvent[],
	stateEvents: readonly ApiStateEvent[],
	ctx: MapContext,
	current: string
): TaskRecord['history'] {
	const createdAt = iso(issue.created_at);
	const state: Replay = { state: 'opened', labels: [] };
	const view = (): Parameters<StatusMapper['tryStatusOf']>[0] => ({
		iid: issue.iid,
		state: state.state,
		labels: state.labels,
	});
	const history: TaskRecord['history'] = [];
	const first = ctx.mapper.tryStatusOf(view());
	if (first !== undefined) history.push({ status: first, timestamp: createdAt });
	// The events one request produces are one change, judged after the last of them, so the status in between never shows in the
	// history: events within GROUP_WINDOW_MS of the first one of a group are its members.
	const groups: TimelineEvent[][] = [];
	for (const event of timelineOf(labelEvents, stateEvents)) {
		const last = groups.at(-1);
		if (last !== undefined && Date.parse(event.at) - Date.parse(last[0]!.at) <= GROUP_WINDOW_MS) last.push(event);
		else groups.push([event]);
	}
	for (const group of groups) {
		for (const event of group) {
			if (event.kind === 'label') {
				state.labels = event.added
					? [...state.labels, event.name]
					: state.labels.filter(held => lower(held) !== lower(event.name));
			} else state.state = event.closed ? 'closed' : 'opened';
		}
		const status = ctx.mapper.tryStatusOf(view());
		if (status === undefined || status === history.at(-1)?.status) continue;
		const timestamp = iso(group[0]!.at);
		// An issue created with its status label may show the label event right after the creation: inside the creation window it is
		// the creation status, not a change.
		if (history.length === 1 && Date.parse(timestamp) - Date.parse(createdAt) <= CREATION_WINDOW_MS) {
			history[0] = { status, timestamp: createdAt };
		} else history.push({ status, timestamp });
	}
	if (history.at(-1)?.status !== current) history.push({ status: current, timestamp: iso(issue.updated_at) });
	return history;
}

/**
 * The activity rows of an issue (everything but status changes and comments), oldest first, in the vocabulary of the local log. Only
 * the label events are read: GitLab writes a title or description change as a system NOTE (free text whose wording is not documented),
 * which is not parsed.
 */
export function activityOf(labelEvents: readonly ApiLabelEvent[], ctx: MapContext, iid: number): ActivityEntry[] {
	const rows: ActivityEntry[] = [];
	for (const event of labelEvents) {
		if (event.label === null) continue;
		const name = event.label.name;
		if (ctx.mapper.isStatusLabel(name)) continue;
		const at = iso(event.created_at);
		const added = event.action === 'add';
		if (isTypeLabel(name, ctx)) {
			const type = typeOfLabel(name, ctx);
			rows.push({ at, kind: 'type', ...(added ? { newValue: type } : { oldValue: type }) });
		} else if (isMetaLabel(name, ctx)) {
			let entry: { key: string; value: string } | undefined;
			try {
				entry = parseMetaLabel(name, ctx, iid);
			} catch {
				// A meta label that cannot be read is reported when the issue itself is read; the activity just leaves it out.
				entry = undefined;
			}
			if (entry === undefined) continue;
			rows.push(
				added
					? { at, kind: 'meta-set', field: entry.key, newValue: entry.value }
					: { at, kind: 'meta-removed', field: entry.key, oldValue: entry.value }
			);
		} else {
			rows.push({
				at,
				kind: added ? 'label-added' : 'label-removed',
				...(added ? { newValue: name } : { oldValue: name }),
			});
		}
	}
	return rows;
}

/** The links of a record: blockers from the issue links, duplicateOf / causedBy from the managed block. */
export function linksOf(blockers: readonly number[], blockLinks: readonly TaskLink[]): TaskLink[] {
	return [
		...blockers.map((target): TaskLink => ({ type: 'blockedBy', target: String(target) })),
		...blockLinks.map(link => ({ type: link.type, target: link.target })),
	];
}
