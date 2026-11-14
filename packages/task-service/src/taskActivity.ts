import { INVERSE_LINK_NAMES } from '@wadeck-app/task-core';
import type { ActivityEntry, LinkType, TaskRecord } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';
import { headlineOf } from './taskText.js';

/** The tones the views know (same words as the module's status tones). */
export type ActivityTone = 'neutral' | 'info' | 'success' | 'danger' | 'purple';

/** `created` and `status` come from `TaskRecord.history`; the others are the kinds of `TaskRecord.activity`. */
export type ActivityRowKind = 'created' | 'status' | 'comment' | ActivityEntry['kind'];

export interface ActivityRow {
	/** Stable within one answer: `history-<n>` or `activity-<n>`, n = position in the stored list. */
	id: string;
	/** Where the row was read: the status history, the activity log, or the task's comments. */
	source: 'history' | 'activity' | 'comments';
	at: string;
	kind: ActivityRowKind;
	/** A lucide icon name (kebab-case). */
	icon: string;
	tone: ActivityTone;
	/** One plain English sentence, e.g. "Type changed from bug to feature". */
	text: string;
	/** Status rows: the status before (absent for the creation) and after. */
	from?: string;
	to?: string;
	/** Who did it: the author of a comment when it has one; tasks have no user model, so every other row has none. */
	actor?: string;
	/** `comment` rows: the id of the comment (for edit / remove) and when it was last edited. `text` is its FULL text. */
	commentId?: string;
	editedAt?: string;
	/** Old and new text of an edit (title, description), each already cut to a preview. */
	details?: { oldValue?: string; newValue?: string };
	/** The row mirrors a link held by the other task. */
	inverse?: true;
}

// A kind this file does not know (written by a newer task) gets `circle`.
const ICONS: Record<string, string> = {
	created: 'circle-plus',
	status: 'arrow-right-left',
	type: 'shapes',
	'label-added': 'tag',
	'label-removed': 'tag',
	'meta-set': 'sliders-horizontal',
	'meta-removed': 'sliders-horizontal',
	parent: 'git-branch',
	'child-added': 'git-branch',
	'child-removed': 'git-branch',
	'link-added': 'link',
	'link-removed': 'unlink',
	title: 'pencil',
	description: 'file-text',
	priority: 'flag',
	assignee: 'user',
	claim: 'user-check',
	release: 'user-minus',
	other: 'circle-dot',
	comment: 'message-square',
	'comment-edited': 'pencil',
	'comment-removed': 'message-square-x',
};

const LINK_WORDS: Record<LinkType, string> = {
	blockedBy: 'blocked by',
	duplicateOf: 'duplicate of',
	causedBy: 'caused by',
};

/** `<id> <headline>` of a readable task, else the id alone (the task was deleted, or never existed here). */
type TaskLabel = (id: string) => string;

async function taskLabeler(ctx: TaskServiceContext): Promise<TaskLabel> {
	const byId = new Map((await ctx.store.list()).map(task => [task.id, task.title]));
	return id => {
		const title = byId.get(id);
		return title === undefined ? id : `${id} ${headlineOf(title)}`;
	};
}

function linkWord(entry: ActivityEntry): string {
	const type = entry.field as LinkType;
	if (entry.inverse === true) {
		return INVERSE_LINK_NAMES[type] ?? String(entry.field);
	}
	return LINK_WORDS[type] ?? String(entry.field);
}

function describeEntry(entry: ActivityEntry, label: TaskLabel): Pick<ActivityRow, 'text' | 'details'> {
	const { oldValue, newValue } = entry;
	const key = entry.field ?? '?';
	switch (entry.kind) {
		case 'type':
			if (oldValue !== undefined && newValue !== undefined)
				return { text: `Type changed from ${oldValue} to ${newValue}` };
			if (newValue !== undefined) return { text: `Type set to ${newValue}` };
			return { text: `Type cleared${oldValue === undefined ? '' : ` (was ${oldValue})`}` };
		case 'label-added':
			return { text: `Label ${newValue ?? '?'} added` };
		case 'label-removed':
			return { text: `Label ${oldValue ?? '?'} removed` };
		case 'meta-set':
			return {
				text:
					oldValue === undefined
						? `Metadata ${key} set to ${newValue ?? ''}`.trimEnd()
						: `Metadata ${key} changed from ${oldValue === '' ? '(empty)' : oldValue} to ${newValue === '' ? '(empty)' : (newValue ?? '')}`,
			};
		case 'meta-removed':
			return {
				text: `Metadata ${key} removed${oldValue === undefined ? '' : ` (was ${oldValue === '' ? '(empty)' : oldValue})`}`,
			};
		case 'parent':
			if (oldValue !== undefined && newValue !== undefined) {
				return { text: `Parent changed from ${label(oldValue)} to ${label(newValue)}` };
			}
			if (newValue !== undefined) return { text: `Parent set to ${label(newValue)}` };
			return { text: `Parent removed${oldValue === undefined ? '' : ` (was ${label(oldValue)})`}` };
		case 'priority':
			if (oldValue !== undefined && newValue !== undefined) {
				return { text: `Priority changed from ${oldValue} to ${newValue}` };
			}
			return { text: newValue === undefined ? 'Priority cleared' : `Priority set to ${newValue}` };
		case 'assignee':
			if (oldValue !== undefined && newValue !== undefined) {
				return { text: `Assignee changed from ${oldValue} to ${newValue}` };
			}
			return { text: newValue === undefined ? 'Unassigned' : `Assigned to ${newValue}` };
		// `newValue` = the assignee, `field` = the end of the lease; `oldValue` = the previous holder of a takeover.
		case 'claim': {
			const until = entry.field === undefined ? '' : ` until ${entry.field}`;
			const by = newValue ?? '?';
			if (oldValue === undefined) return { text: `Claimed by ${by}${until}` };
			// A renewal has the same name on both sides (a backend that records it so).
			if (oldValue === newValue) return { text: `Lease renewed by ${by}${until}` };
			return { text: `Taken over from ${oldValue} by ${by}${until}` };
		}
		case 'release':
			return { text: oldValue === undefined ? 'Released' : `Released by ${oldValue}` };
		case 'child-added':
			return { text: `Sub-task ${label(entry.target ?? '?')} added` };
		case 'child-removed':
			return { text: `Sub-task ${label(entry.target ?? '?')} detached` };
		case 'link-added':
			return { text: `Linked: ${linkWord(entry)} ${label(entry.target ?? '?')}` };
		case 'link-removed':
			return { text: `Unlinked: ${linkWord(entry)} ${label(entry.target ?? '?')}` };
		// `field` is the comment id; the texts are previews (the comment row of an edited comment holds the full text).
		case 'comment-edited':
			return { text: `Comment ${key} edited`, details: texts(entry) };
		case 'comment-removed':
			return { text: `Comment ${key} removed`, details: texts(entry) };
		case 'title':
			return { text: 'Title edited', details: texts(entry) };
		case 'description':
			return { text: 'Description edited', details: texts(entry) };
		case 'other':
			return { text: `Remote event: ${key}${newValue === undefined ? '' : ` (${newValue})`}` };
	}
	// A kind written by a newer task: still shown, never dropped.
	return { text: `Change recorded: ${String((entry as { kind: unknown }).kind)}` };
}

function texts(entry: ActivityEntry): { oldValue?: string; newValue?: string } {
	return {
		...(entry.oldValue === undefined ? {} : { oldValue: entry.oldValue }),
		...(entry.newValue === undefined ? {} : { newValue: entry.newValue }),
	};
}

function statusTone(ctx: TaskServiceContext, status: string): ActivityTone {
	if (ctx.config.negativeStatuses.includes(status)) return 'danger';
	if (ctx.config.terminalStatuses.includes(status)) return 'success';
	return status === ctx.config.defaultStatus ? 'neutral' : 'info';
}

/**
 * Everything that happened to a task as ONE list, newest first: the status history (its first entry is the creation)
 * merged with the activity log by instant (ISO strings of one format, so they compare as text; equal instants keep the
 * recorded order, the activity after the history). Ids of other tasks read `<id> <headline>` when the task is readable.
 * A task written before the log existed shows its status history only.
 */
export async function describeTaskActivity(ctx: TaskServiceContext, record: TaskRecord): Promise<ActivityRow[]> {
	const label = await taskLabeler(ctx);
	const history = record.history ?? [];
	const chronological: ActivityRow[] = [
		...history.map((entry, index): ActivityRow => {
			const created = index === 0;
			return {
				id: `history-${index}`,
				source: 'history',
				at: entry.timestamp,
				kind: created ? 'created' : 'status',
				icon: ICONS[created ? 'created' : 'status']!,
				...(created ? {} : { from: history[index - 1]!.status }),
				to: entry.status,
				tone: created ? 'neutral' : statusTone(ctx, entry.status),
				text: created
					? `Created with status ${entry.status}`
					: `Status changed from ${history[index - 1]!.status} to ${entry.status}`,
			};
		}),
		...(record.activity ?? []).map((entry, index): ActivityRow => ({
			id: `activity-${index}`,
			source: 'activity',
			at: entry.at,
			kind: entry.kind,
			// Giving a task up (unassigned) has the minus icon of a release.
			icon:
				entry.kind === 'assignee' && entry.newValue === undefined
					? 'user-minus'
					: (ICONS[entry.kind] ?? 'circle'),
			tone: entry.kind.startsWith('link') ? 'purple' : 'neutral',
			...describeEntry(entry, label),
			...(entry.inverse === true ? { inverse: true as const } : {}),
		})),
		// Each comment is a row with its full text; its edits and removals are `comment-edited` / `comment-removed` entries above.
		...(record.comments ?? []).map((comment): ActivityRow => ({
			id: `comment-${comment.id}`,
			source: 'comments',
			at: comment.at,
			kind: 'comment',
			icon: ICONS['comment']!,
			tone: 'neutral',
			text: comment.text,
			commentId: comment.id,
			...(comment.author === undefined ? {} : { actor: comment.author }),
			...(comment.editedAt === undefined ? {} : { editedAt: comment.editedAt }),
		})),
	];
	// Array.prototype.sort is stable: equal instants keep the history-then-activity order.
	return chronological.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).reverse();
}

export interface TaskActivity {
	/** Full id of the resolved task. */
	id: string;
	/** Newest first. */
	rows: ActivityRow[];
}

/** The merged activity of a task (see {@link describeTaskActivity}). */
export async function getTaskActivity(ctx: TaskServiceContext, input: { id: string }): Promise<TaskActivity> {
	const task = await ctx.store.findByPrefix(input.id);
	return { id: task.id, rows: await describeTaskActivity(ctx, task) };
}
