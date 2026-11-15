// What a migration maps of a source task, as comparable hashes: an in-place run reads the source again right before it switches and must
// notice an edit to anything the copy carries (not only the title and the status).
import * as crypto from 'node:crypto';

import type { VersionedRecord } from '@wadeck-app/task-core';

/** The parts of a task a migration carries, in the order they are reported. */
export const CONTENT_PARTS = [
	'title',
	'description',
	'status',
	'type',
	'labels',
	'meta',
	'parent',
	'links',
	'priority',
	'assignee',
	'comments',
] as const;

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (typeof value === 'object' && value !== null) {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonical(record[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

function hashOf(value: unknown): string {
	return crypto.createHash('sha256').update(canonical(value)).digest('hex').slice(0, 12);
}

/** One short hash per part of the task a migration maps (the lease and the activity log are not carried, so they are not here). */
export function contentParts(record: VersionedRecord): Record<string, string> {
	return {
		title: hashOf(record.title),
		description: hashOf(record.description ?? null),
		status: hashOf(record.status),
		type: hashOf(record.type ?? null),
		labels: hashOf([...(record.labels ?? [])].sort()),
		meta: hashOf(record.meta ?? {}),
		parent: hashOf(record.parentId ?? null),
		links: hashOf([...(record.links ?? [])].map(link => `${link.type}:${link.target}`).sort()),
		priority: hashOf(record.priority ?? null),
		assignee: hashOf(record.assignee ?? null),
		comments: hashOf((record.comments ?? []).map(comment => [comment.text, comment.author ?? null, comment.at])),
	};
}

/** One hash for the whole content: what the journal remembers of a task once it is migrated. */
export function contentHash(parts: Record<string, string>): string {
	return hashOf(CONTENT_PARTS.map(part => parts[part] ?? ''));
}

/** The names of the parts that differ between two {@link contentParts}. */
export function differingParts(before: Record<string, string>, after: Record<string, string>): string[] {
	return CONTENT_PARTS.filter(part => before[part] !== after[part]);
}
