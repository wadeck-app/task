// The last step of a migration: every task the run touched is read again from the target and compared with what the plan said it
// should hold. A difference is reported, never repaired: the person decides (a forge may normalise a text, a person may have edited).
import type { VersionedRecord } from '@wadeck-app/task-core';

import { MIGRATED_FROM_KEY, commentMarker } from './mapTask.js';
import type { MappedTask } from './mapTask.js';
import type { MigrationMismatch } from './migrateTypes.js';

const normal = (text: string): string => text.replace(/\r\n/g, '\n').trim();

export interface Expectation {
	mapped: MappedTask;
	targetId: string;
	/** The parent on the target (its id there), when the task keeps one. */
	parentTargetId?: string;
	/** Whether the target holds metadata (then the marker is expected). */
	marker: boolean;
	keepsCreatedAt: boolean;
	/** The target ids of the links the task must hold, by type. */
	links: Array<{ type: string; target: string }>;
}

/** What differs between the record read back and the expectation; empty when the task is as planned. */
export function compare(expect: Expectation, actual: VersionedRecord): MigrationMismatch[] {
	const { mapped } = expect;
	const found: MigrationMismatch[] = [];
	const differ = (field: string, expected: string, got: string): void => {
		found.push({ sourceId: mapped.sourceId, targetId: expect.targetId, field, expected, actual: got });
	};

	if (actual.title !== mapped.title) differ('title', mapped.title, actual.title);
	const expectedBody = normal(mapped.description ?? mapped.title);
	const actualBody = normal(actual.description ?? actual.title);
	if (expectedBody !== actualBody) differ('description', expectedBody, actualBody);
	if (actual.status !== mapped.status) differ('status', mapped.status, actual.status);
	if ((actual.type ?? '') !== (mapped.type ?? '')) differ('type', mapped.type ?? '(none)', actual.type ?? '(none)');

	if (mapped.priority !== undefined && actual.priority !== mapped.priority) {
		differ('priority', mapped.priority, actual.priority ?? '(none)');
	}
	if (mapped.assignee !== undefined && actual.assignee !== mapped.assignee) {
		differ('assignee', mapped.assignee, actual.assignee ?? '(none)');
	}

	const labels = new Set((actual.labels ?? []).map(label => label.toLowerCase()));
	const missingLabels = mapped.labels.filter(label => !labels.has(label.toLowerCase()));
	if (missingLabels.length > 0)
		differ('labels', missingLabels.join(', '), `(missing; has ${[...labels].join(', ')})`);

	const expectedMeta = { ...mapped.meta, ...(expect.marker ? { [MIGRATED_FROM_KEY]: mapped.qualifiedId } : {}) };
	for (const [key, value] of Object.entries(expectedMeta)) {
		const got = actual.meta !== undefined && Object.hasOwn(actual.meta, key) ? actual.meta[key] : undefined;
		if (got !== value) differ(`meta.${key}`, value, got ?? '(absent)');
	}

	if ((actual.parentId ?? '') !== (expect.parentTargetId ?? '')) {
		differ('parent', expect.parentTargetId ?? '(none)', actual.parentId ?? '(none)');
	}

	for (const link of expect.links) {
		const present = (actual.links ?? []).some(held => held.type === link.type && held.target === link.target);
		if (!present) differ(`link ${link.type}`, link.target, '(absent)');
	}

	for (const comment of mapped.comments) {
		const marker = commentMarker(mapped.qualifiedId, comment.key);
		if (!(actual.comments ?? []).some(held => held.text.includes(marker))) {
			differ(`comment ${comment.key}`, `a comment holding ${marker}`, '(absent)');
		}
	}

	if (expect.keepsCreatedAt && mapped.createdAt !== undefined && actual.createdAt !== mapped.createdAt) {
		differ('createdAt', mapped.createdAt, actual.createdAt);
	}
	return found;
}
