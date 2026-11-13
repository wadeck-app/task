// GitLab issue JSON -> task shapes, pure: summaries for lists, the record for a read, the status history replayed from the label and
// state events, the activity rows, the comments. Nothing here talks to the network; the backend feeds it what it fetched.
//
// Verified against gitlab.com Free on 2026-11-09 (fixtures/live-conformance.json). Label names are compared EXACTLY (GitLab labels are
// case sensitive: `bug` and `Bug` are two labels). Mapping (design 2.1; each row is documented in CLAUDE.md "Storage strategy: gitlab"):
//   id            the issue iid as a string (`ids: assigned`)
//   title         the issue title
//   description   the description without the managed task block; absent when empty or equal to the title (CRLF read as LF)
//   status        state (opened/closed) + the status labels, through the statusMap (gitlabStatusMapping.ts)
//   labels        the issue labels without the status labels, the type labels and (with fills.meta: labels) the meta labels
//   type          a type label (typePrefix / typeMap.label), else a native issue_type that typeMap names (incident, task)
//   meta          only with fills.meta: labels (`meta:key=value`) or body-block
//   parentId      the parent of a native Task (GraphQL hierarchy widget, read by the backend; capability hierarchy: limited)
//   links         duplicateOf / causedBy from the managed block when declared
//   history       replayed from resource_label_events + resource_state_events through the same status mapping
//   activity      the label events that are not status labels (type, meta, labels) and the system notes of title, description, type
//                 and hierarchy (activityOf); a system note nobody documented is kept as an 'other' entry with its text
import { BackendDataError, activityPreview } from '@wadeck-app/task-core';
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
	return labelNames(issue).some(name => name === TOMBSTONE_LABEL);
}

export function statusOfIssue(issue: ApiIssue, ctx: MapContext): string {
	return ctx.mapper.statusOf({ iid: issue.iid, state: issue.state, labels: labelNames(issue) });
}

/** `parentIid`: the parent of the issue when the caller knows it (the REST issue does not carry it). */
export function toSummary(issue: ApiIssue, ctx: MapContext, parentIid?: number): TaskSummary {
	return {
		id: String(issue.iid),
		title: issue.title,
		status: statusOfIssue(issue, ctx),
		createdAt: iso(issue.created_at),
		...(parentIid === undefined ? {} : { parentId: String(parentIid) }),
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

export function isTypeLabel(name: string, ctx: MapContext): boolean {
	const { typePrefix, typeMap } = ctx.settings;
	return (
		name.startsWith(typePrefix) ||
		Object.values(typeMap).some(rule => rule.label !== undefined && rule.label === name)
	);
}

export function isMetaLabel(name: string, ctx: MapContext): boolean {
	return ctx.metaFromLabels && name.startsWith(ctx.settings.metaPrefix);
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
		if (rule.label !== undefined && rule.label === name) return type;
	}
	return name.startsWith(typePrefix) ? name.slice(typePrefix.length) : undefined;
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
	// An Issue is the default; a native Task is the type of a hierarchy child, never a task type (it has none unless a type label says so).
	if (native === undefined || native === 'issue' || native === 'task') return undefined;
	const mapped = Object.entries(ctx.settings.typeMap).find(([, rule]) => rule.issueType === native);
	return mapped?.[0];
}

/** The label that holds one meta entry: `meta:key=value`. */
export function metaLabelName(key: string, value: string, ctx: MapContext): string {
	return `${ctx.settings.metaPrefix}${key}=${value}`;
}

/** Why this meta key or value cannot be a label, as a sentence; undefined when it can. */
export function metaLabelProblem(key: string, value: string): string | undefined {
	if (key === '') return 'a metadata key cannot be empty';
	if (key.includes(',') || value.includes(',')) {
		return `the metadata "${key}" holds a comma, which cannot be part of a GitLab label name`;
	}
	if (key !== key.trim() || value !== value.trim()) {
		return `the metadata "${key}" starts or ends with a space, which GitLab trims from a label name`;
	}
	if (key.includes('=')) return `the metadata key "${key}" contains "=", which separates key and value in the label`;
	return undefined;
}

/** key and value of a meta label name; undefined when the name is not a meta label. Throws BackendDataError for a malformed one. */
export function parseMetaLabel(name: string, ctx: MapContext, iid: number): { key: string; value: string } | undefined {
	if (!isMetaLabel(name, ctx)) return undefined;
	const rest = name.slice(ctx.settings.metaPrefix.length);
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
/**
 * VERIFIED-LIVE (gitlab.com, 2026-11-09): for one PUT that swaps labels and closes, the state event is about 0.5 s EARLIER than the
 * label events, and all the label events of that PUT carry the SAME `created_at` (`add` before `remove`); the events of two PUTs 0.8 s
 * apart are distinct. So the state event of a change is looked for within a second of the label events, preferring the label events
 * that come AFTER it.
 */
const GROUP_WINDOW_MS = 1000;
/** Label events closer than this are the events of one PUT. */
const SAME_PUT_MS = 100;

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
 * The events grouped by the request that produced them: label events with the same instant are one PUT, and the state event of that
 * PUT (a little earlier) joins them; a state event with no label events near it is a group of its own. Oldest group first.
 */
function groupEvents(events: readonly TimelineEvent[]): TimelineEvent[][] {
	const clusters: Array<{ events: TimelineEvent[]; hasState: boolean }> = [];
	for (const event of events) {
		if (event.kind !== 'label') continue;
		const last = clusters.at(-1);
		if (last !== undefined && Date.parse(event.at) - Date.parse(last.events.at(-1)!.at) <= SAME_PUT_MS) {
			last.events.push(event);
		} else clusters.push({ events: [event], hasState: false });
	}
	const alone: TimelineEvent[][] = [];
	for (const event of events) {
		if (event.kind !== 'state') continue;
		const at = Date.parse(event.at);
		// The label events of the same PUT come after it (up to a second), else they came just before.
		const target =
			clusters.find(
				cluster =>
					!cluster.hasState &&
					Date.parse(cluster.events[0]!.at) - at >= -SAME_PUT_MS &&
					Date.parse(cluster.events[0]!.at) - at <= GROUP_WINDOW_MS
			) ??
			[...clusters]
				.reverse()
				.find(
					cluster =>
						!cluster.hasState &&
						at - Date.parse(cluster.events.at(-1)!.at) >= 0 &&
						at - Date.parse(cluster.events.at(-1)!.at) <= GROUP_WINDOW_MS
				);
		if (target === undefined) alone.push([event]);
		else {
			target.events.push(event);
			target.hasState = true;
		}
	}
	const order = (group: readonly TimelineEvent[]): number => Math.min(...group.map(event => Date.parse(event.at)));
	return [...clusters.map(cluster => cluster.events), ...alone]
		.map(group => [...group].sort((a, b) => events.indexOf(a) - events.indexOf(b)))
		.sort((a, b) => order(a) - order(b));
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
	// history.
	for (const group of groupEvents(timelineOf(labelEvents, stateEvents))) {
		for (const event of group) {
			if (event.kind === 'label') {
				state.labels = event.added
					? [...state.labels, event.name]
					: state.labels.filter(held => held !== event.name);
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

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'" };

/** The text of a (system note) HTML fragment: tags dropped, the entities GitLab writes decoded. */
function plainText(html: string): string {
	return html
		.replace(/<[^>]*>/g, '')
		.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole);
}

/** What GitLab calls a native type -> the native issue_type value of the REST API. */
const NATIVE_OF_TYPE_NAME: Record<string, string> = { issue: 'issue', incident: 'incident', task: 'task' };

/**
 * The activity row of one SYSTEM note, or undefined for a note task does not report. Wording VERIFIED-LIVE (gitlab.com Free,
 * 2026-11-09): title (HTML with the two titles in <code class="idiff">), "changed the description" (no diff exists), "changed type to
 * **Incident**", "added #N as parent item" (on the child), "added #N as child item" (on the parent). The wording of a REMOVED parent or
 * child is NOT in the recording, so it is not parsed: like any other system note it becomes an 'other' row with its plain text.
 */
function noteActivity(note: ApiNote, ctx: MapContext): ActivityEntry {
	const at = iso(note.created_at);
	const body = note.body;
	const codes = [...body.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map(match => plainText(match[1]!));
	if (/^<p>changed title from /.test(body) && codes.length === 2) {
		return { at, kind: 'title', oldValue: activityPreview(codes[0]!), newValue: activityPreview(codes[1]!) };
	}
	if (body === 'changed the description') {
		// GitLab keeps no previous text and sends no diff: the entry says that something changed, never what.
		return { at, kind: 'description', newValue: '(the description was changed on GitLab; GitLab keeps no diff)' };
	}
	const typed = /^changed type to \*\*(.+)\*\*$/.exec(body);
	if (typed !== null) {
		const native = NATIVE_OF_TYPE_NAME[typed[1]!.toLowerCase()];
		const mapped =
			native === undefined
				? undefined
				: Object.entries(ctx.settings.typeMap).find(
						([, rule]) => (rule.issueType as string | undefined) === native
					)?.[0];
		if (mapped !== undefined) return { at, kind: 'type', newValue: mapped };
		return { at, kind: 'other', field: 'type', newValue: `changed type to ${typed[1]!}` };
	}
	const parent = /^added #(\d+) as parent item$/.exec(body);
	if (parent !== null) return { at, kind: 'parent', newValue: parent[1]! };
	const child = /^added #(\d+) as child item$/.exec(body);
	if (child !== null) return { at, kind: 'child-added', target: child[1]!, inverse: true };
	return { at, kind: 'other', field: 'note', newValue: activityPreview(plainText(body)) };
}

/**
 * The activity rows of an issue (everything but status changes and comments), oldest first, in the vocabulary of the local log: the
 * label events that are not status labels, and the system notes (`notes`: title, description, type, hierarchy and the rest, see
 * noteActivity). A label event whose label was deleted since (`label: null`) is skipped, never guessed. Nobody is named as the author:
 * the log has no author.
 */
export function activityOf(
	labelEvents: readonly ApiLabelEvent[],
	ctx: MapContext,
	iid: number,
	notes: readonly ApiNote[] = []
): ActivityEntry[] {
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
	for (const note of notes) if (note.system) rows.push(noteActivity(note, ctx));
	// Stable: rows with the same instant keep their order (labels first, then notes).
	return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
