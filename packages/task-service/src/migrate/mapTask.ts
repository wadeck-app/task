// What one source task becomes on the target, and what of it is lost (design 1.8). Pure: reads a record, the two endpoints and the
// options, writes the losses into the ledger, touches no backend. The plan (migratePlan.ts) and the run (migrateRun.ts) use the same
// result, so what the dry run printed is what the run does.
import { formatQualifiedId } from '@wadeck-app/project-sdk';
import { resolveTypeValidationStrategy } from '@wadeck-app/task-core';
import type { LinkType, VersionedRecord } from '@wadeck-app/task-core';

import type { LossLedger } from './lossLedger.js';
import type { MigrationEndpoint, MigrationOptions } from './migrateTypes.js';

/** The metadata key that records where a migrated task came from; its value is the qualified id of the source task. */
export const MIGRATED_FROM_KEY = 'migratedFrom';

/** The key of the note comment (the history of the task) in the markers. */
export const NOTE_KEY = 'history';

/** The text that marks a comment as written by a migration, so that a second run recognises it and does not write it again. */
export function commentMarker(qualifiedId: string, key: string): string {
	return `[migrated from ${qualifiedId}#${key}]`;
}

export interface MappedComment {
	/** The id of the comment in the source, or {@link NOTE_KEY} for the note. */
	key: string;
	/** The text to write, header included. */
	text: string;
	/** Passed as the author when the target stores authors. */
	author?: string;
}

export interface MappedTask {
	sourceId: string;
	/** `<source project id>/<source task id>`: the value of the marker. */
	qualifiedId: string;
	title: string;
	description?: string;
	status: string;
	/** Only when the target keeps the creation instant. */
	createdAt?: string;
	type?: string;
	labels: string[];
	/** The metadata of the task (the marker is not in it). */
	meta: Record<string, string>;
	links: Array<{ type: LinkType; sourceTarget: string }>;
	comments: MappedComment[];
}

export interface MapContext {
	source: MigrationEndpoint;
	target: MigrationEndpoint;
	options: MigrationOptions;
	ledger: LossLedger;
	/** Every task id of the source (to tell a link to a missing task). */
	sourceIds: ReadonlySet<string>;
}

/** The text cut to `max` characters, ending with a note that says so; unchanged when it fits. */
export function cutText(text: string, max: number | undefined): { text: string; cut: boolean } {
	if (max === undefined || text.length <= max) return { text, cut: false };
	const note = `\n[cut by task migrate: the original has ${text.length} characters]`;
	return { text: text.slice(0, Math.max(0, max - note.length)) + note, cut: true };
}

function statusLabel(facts: { terminal: boolean; outcome: 'positive' | 'negative' | undefined } | undefined): string {
	if (facts === undefined) return 'unknown';
	if (!facts.terminal) return 'open';
	return `ends the task (${facts.outcome ?? 'positive'})`;
}

function noteText(record: VersionedRecord, qualifiedId: string, keepsCreatedAt: boolean): string {
	const lines = [`Migrated from ${qualifiedId} by task migrate.`];
	if (!keepsCreatedAt) lines.push(`Created ${record.createdAt}.`);
	if (record.history.length > 1) {
		lines.push(
			`Status history: ${record.history.map(entry => `${entry.status} (${entry.timestamp})`).join(' -> ')}`
		);
	}
	const activity = record.activity ?? [];
	if (activity.length > 0) {
		const kinds = new Map<string, number>();
		for (const entry of activity) kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
		lines.push(
			`Other changes in the source: ${activity.length} (${[...kinds].map(([kind, count]) => `${kind} ${count}`).join(', ')})`
		);
	}
	lines.push(commentMarker(qualifiedId, NOTE_KEY));
	return lines.join('\n');
}

export function mapTask(record: VersionedRecord, ctx: MapContext): MappedTask {
	const { source, target, options, ledger } = ctx;
	const caps = target.backend.capabilities;
	const traits = target.traits;
	const id = record.id;
	const qualifiedId = formatQualifiedId(source.project.id, id);

	// Status: the same name, else the target's default (a loss). An outcome that differs is a loss too, the task still gets that status.
	const targetStatuses = target.facts.statuses;
	const sourceStatus = source.facts.statuses.find(status => status.name === record.status);
	const targetStatus = targetStatuses.find(status => status.name === record.status);
	let status = record.status;
	if (targetStatus === undefined) {
		const fallback = targetStatuses.find(candidate => candidate.default)?.name;
		if (fallback === undefined) {
			throw new Error(`the target project defines no default status, so "${record.status}" cannot be mapped`);
		}
		ledger.add('status', id, record.status);
		status = fallback;
	} else if (
		sourceStatus !== undefined &&
		(sourceStatus.terminal !== targetStatus.terminal ||
			(sourceStatus.terminal && sourceStatus.outcome !== targetStatus.outcome))
	) {
		ledger.add(
			'status-outcome',
			id,
			`${record.status}: ${statusLabel(sourceStatus)} in the source, ${statusLabel(targetStatus)} in the target`
		);
	}

	// Title and description. A description over the target's limit is cut (a loss), the title is the backend's business.
	let description: string | undefined;
	if (record.description !== undefined && record.description !== record.title) {
		const cut = cutText(record.description, traits.descriptionMax);
		if (cut.cut) ledger.add('text-length', id, 'description');
		description = cut.text;
	}

	// Type.
	let type: string | undefined;
	if (record.type !== undefined) {
		if (resolveTypeValidationStrategy(target.facts.types).validate(record.type).valid) type = record.type;
		else ledger.add('type', id, record.type);
	}

	// Labels.
	const labels: string[] = [];
	for (const label of record.labels ?? []) {
		const problem = caps.labels ? traits.labelProblem?.(label) : 'the target has no labels';
		if (problem === undefined) labels.push(label);
		else ledger.add('labels', id, problem);
	}

	// Metadata, and the marker that makes a second run recognise the task.
	const meta: Record<string, string> = {};
	const entries = Object.entries(record.meta ?? {}).filter(([key]) => key !== MIGRATED_FROM_KEY);
	for (const [key, value] of entries) {
		if (caps.meta) meta[key] = value;
		else ledger.add('meta', id, undefined);
	}
	if (!caps.meta) ledger.add('marker', id);

	// Links.
	const links: MappedTask['links'] = [];
	for (const link of record.links ?? []) {
		const kind = `links:${link.type}` as const;
		if (!caps.linkTypes.includes(link.type)) ledger.add(kind, id, `${id} ${link.type} ${link.target}`);
		else if (!ctx.sourceIds.has(link.target)) ledger.add('links:dangling', id, `${id} ${link.type} ${link.target}`);
		else links.push({ type: link.type, sourceTarget: link.target });
	}

	// Comments: written by the migrating user; the time (and the author, when the target cannot store it) go in a first line.
	const comments: MappedComment[] = [];
	const sourceComments = record.comments ?? [];
	if (sourceComments.length > 0 && !caps.comments) {
		ledger.add('comments', id, undefined, sourceComments.length);
	} else {
		for (const comment of sourceComments) {
			const stored = traits.authoredComments && comment.author !== undefined;
			const header =
				`Originally posted ${comment.at}` +
				(comment.author !== undefined && !stored ? ` by ${comment.author}` : '') +
				(comment.editedAt === undefined ? '' : ` (edited ${comment.editedAt})`) +
				` ${commentMarker(qualifiedId, comment.id)}`;
			const cut = cutText(`${header}\n\n${comment.text}`, traits.commentTextMax);
			if (cut.cut) ledger.add('text-length', id, 'comment');
			const author =
				stored && comment.author !== undefined
					? comment.author.slice(0, traits.commentAuthorMax ?? comment.author.length)
					: undefined;
			comments.push({ key: comment.id, text: cut.text, ...(author === undefined ? {} : { author }) });
		}
	}

	// History: the creation instant and the status history go in a note when asked (and when the target can hold comments).
	const hasHistory = record.history.length > 1 || (record.activity ?? []).length > 0;
	const noted = options.historyComment && caps.comments;
	if (noted) {
		comments.push({ key: NOTE_KEY, text: noteText(record, qualifiedId, traits.keepsCreatedAt) });
	} else {
		if (hasHistory) ledger.add('history', id);
		if (!traits.keepsCreatedAt) ledger.add('created-at', id);
	}

	return {
		sourceId: id,
		qualifiedId,
		title: record.title,
		...(description === undefined ? {} : { description }),
		status,
		...(traits.keepsCreatedAt ? { createdAt: record.createdAt } : {}),
		...(type === undefined ? {} : { type }),
		labels,
		meta,
		links,
		comments,
	};
}
