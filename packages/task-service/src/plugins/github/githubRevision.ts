// The revision of an issue (design 1.6) and the check of a write against the revision the caller read.
//
// GitHub has no conditional write (`If-Match` is a 400), and `updated_at` has a one second resolution and is bumped by comments and
// label changes. So the revision is `<updated_at>#<etag>#<one short hash per part of the issue>`, and a write compares the PARTS IT
// CHANGES: a comment, or a label added to a task whose title is being edited, is not a conflict, while a rename made behind our back
// is, even when both fall in the same second. The hashes hide the text (the revision is shown in JSON and logs).
import { BackendDataError } from '@wadeck-app/task-core';

import {
	blockClaimPart,
	blockMetaPart,
	checkRevisionParts,
	partsFromHashes,
	shortHash,
} from '../forge-common/revisionParts.js';
import { fieldPriorityName, priorityLabelsOf } from './githubPriority.js';
import { labelNames, readBody, typeOfLabel, userLabels } from './issueMapping.js';
import type { ApiIssue, BodyParts, MapContext } from './issueMapping.js';

/** The parts of an issue a write can change. */
export const FIELD_GROUPS = [
	'title',
	'body',
	'status',
	'type',
	'labels',
	'meta',
	'parent',
	'dependencies',
	'priority',
	'claim',
] as const;
export type FieldGroup = (typeof FIELD_GROUPS)[number];
export type FieldHashes = Record<FieldGroup, string>;

const hash = shortHash;

const lowerSorted = (names: readonly string[]): string =>
	names
		.map(name => name.toLowerCase())
		.sort()
		.join('\n');

// The body is read ONCE per issue (`readBody`); an unreadable block is a value, and the parts that need it say so.
type BodyRead = BodyParts | BackendDataError;
const parsedOrThrow = (body: BodyRead): BodyParts => {
	if (body instanceof BackendDataError) throw body;
	return body;
};

function metaPart(issue: ApiIssue, ctx: MapContext, body: BodyRead): string {
	if (ctx.metaFromBlock) return blockMetaPart(() => parsedOrThrow(body).blockMeta);
	if (!ctx.metaFromLabels) return '';
	const prefix = ctx.settings.metaPrefix.toLowerCase();
	return lowerSorted(labelNames(issue).filter(name => name.toLowerCase().startsWith(prefix)));
}

/**
 * The text of the body a person edits: without the managed block, whose keys are covered by their own parts (meta, dependencies for
 * the duplicate marker, claim). A block that cannot be read is hashed whole under its own marker: the write that reads it reports it.
 */
function visibleBody(issue: ApiIssue, body: BodyRead): string {
	if (body instanceof BackendDataError) return `unreadable|${(issue.body ?? '').replace(/\r\n/g, '\n')}`;
	return body.visibleText;
}

function duplicateOfPart(body: BodyRead): string {
	if (body instanceof BackendDataError) return 'unreadable';
	return body.duplicateOf ?? '';
}

/** One short hash per part of the issue. */
export function fieldHashes(issue: ApiIssue, ctx: MapContext): FieldHashes {
	const names = labelNames(issue);
	const body = readBody(issue, ctx);
	const statusLabels = names.filter(name => ctx.mapper.isStatusLabel(name));
	const typeLabels = names.filter(name => typeOfLabel(name, ctx) !== undefined);
	return {
		title: hash(issue.title),
		body: hash(visibleBody(issue, body)),
		status: hash(`${issue.state}|${issue.state_reason ?? ''}|${lowerSorted(statusLabels)}`),
		type: hash(`${lowerSorted(typeLabels)}|${(issue.type?.name ?? '').toLowerCase()}`),
		labels: hash(lowerSorted(userLabels(issue, ctx))),
		meta: hash(metaPart(issue, ctx, body)),
		parent: hash(issue.parent_issue_url ?? ''),
		// The counts, and the `duplicateOf` target the managed block holds (the one key of the block no other part covers).
		dependencies: hash(
			`${issue.issue_dependencies_summary?.total_blocked_by ?? 0}|${issue.issue_dependencies_summary?.total_blocking ?? 0}|${duplicateOfPart(body)}`
		),
		// The raw option name and the raw labels: a change of the value on GitHub is a change whatever the project calls it.
		priority: hash(
			`${fieldPriorityName(issue.issue_field_values, ctx.priority)?.toLowerCase() ?? ''}|${lowerSorted(priorityLabelsOf(issue, ctx.priority))}`
		),
		claim: hash(blockClaimPart(() => parsedOrThrow(body).claim)),
	};
}

const cleanEtag = (etag: string | undefined): string => (etag ?? '').replace(/^W\//, '').replace(/"/g, '');

/** The revision string of an issue as read (with the ETag of that read). */
export function revisionOf(issue: ApiIssue, etag: string | undefined, ctx: MapContext): string {
	const hashes = fieldHashes(issue, ctx);
	return `${issue.updated_at}#${cleanEtag(etag)}#${FIELD_GROUPS.map(group => hashes[group]).join('.')}`;
}

function partsOf(revision: string): FieldHashes | undefined {
	const [, , hashes, ...rest] = revision.split('#');
	return hashes === undefined || rest.length > 0 ? undefined : partsFromHashes(hashes, FIELD_GROUPS);
}

/**
 * The parts among `groups` that differ between the revision the caller read and the current one; empty = the write may go on. The
 * same revision is never stale. A revision this backend did not issue is `['revision']` (stale for any write).
 */
export function checkRevision(expected: string, actual: string, groups: readonly FieldGroup[]): string[] {
	return checkRevisionParts(expected, actual, groups, partsOf);
}
