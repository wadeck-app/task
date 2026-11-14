// The revision of an issue (design 1.6) and the check of a write against the revision the caller read.
//
// GitLab documents no optimistic-lock parameter on the issue edit (VERIFIED absence on docs.gitlab.com/api/issues; the ETag of the
// REST API is UNVERIFIED), and `updated_at` is bumped by notes, label changes and state changes alike. So the revision is
// `<updated_at>#<one short hash per part of the issue>`, and a write compares the PARTS IT CHANGES: a comment, or a label added to a
// task whose title is being edited, is not a conflict, while a rename made behind our back is, even when both fall in the same
// second. The hashes hide the text (the revision is shown in JSON and logs). The `relates_to` issue links are not part of the
// revision: the issue JSON does not carry them, and a link write reads the link list right before it writes. The managed block of
// the description is covered by its own parts (`meta`, `links` for duplicateOf / causedBy, `claim` for assignee and lease), so the
// `body` part is the visible text alone: a claim made meanwhile is no conflict for a description edit, and the other way round.
import {
	blockClaimPart,
	blockMetaPart,
	checkRevisionParts,
	partsFromHashes,
	shortHash,
} from '../forge-common/revisionParts.js';
import { BackendDataError } from '@wadeck-app/task-core';

import { labelNames, readBody, typeOfLabel, userLabels } from './gitlabMapping.js';
import { priorityLabelsOf } from './gitlabPriority.js';
import type { BodyParts, MapContext } from './gitlabMapping.js';
import type { ApiIssue } from './gitlabTypes.js';

/** The parts of an issue a write can change. */
export const FIELD_GROUPS = [
	'title',
	'body',
	'status',
	'type',
	'labels',
	'meta',
	'links',
	'priority',
	'claim',
] as const;
export type FieldGroup = (typeof FIELD_GROUPS)[number];
export type FieldHashes = Record<FieldGroup, string>;

const hash = shortHash;

// Label names are compared exactly: GitLab labels are case sensitive.
const sorted = (names: readonly string[]): string => [...names].sort().join('\n');

// The description is read ONCE per issue (`readBody`); an unreadable block is a value, and the parts that need it say so.
type BodyRead = BodyParts | BackendDataError;
const parsedOrThrow = (body: BodyRead): BodyParts => {
	if (body instanceof BackendDataError) throw body;
	return body;
};

function metaPart(issue: ApiIssue, ctx: MapContext, body: BodyRead): string {
	if (ctx.metaFromBlock) return blockMetaPart(() => parsedOrThrow(body).blockMeta);
	if (!ctx.metaFromLabels) return '';
	const prefix = ctx.settings.metaPrefix;
	return sorted(labelNames(issue).filter(name => name.startsWith(prefix)));
}

/**
 * The text of the description a person edits: without the managed block, whose keys are covered by their own parts (meta, links,
 * claim). A block that cannot be read is hashed whole under its own marker: the write that reads it reports the problem.
 */
function visibleBody(issue: ApiIssue, body: BodyRead): string {
	if (body instanceof BackendDataError) return `unreadable|${(issue.description ?? '').replace(/\r\n/g, '\n')}`;
	return body.visibleText;
}

/** The duplicateOf / causedBy links the managed block holds (the relate-block fills): the one key no other part covers. */
function linksPart(body: BodyRead): string {
	if (body instanceof BackendDataError) return 'unreadable';
	return JSON.stringify(body.blockLinks.map(link => [link.type, link.target]));
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
		status: hash(`${issue.state}|${sorted(statusLabels)}`),
		type: hash(`${sorted(typeLabels)}|${issue.issue_type ?? ''}`),
		labels: hash(sorted(userLabels(issue, ctx))),
		meta: hash(metaPart(issue, ctx, body)),
		links: hash(linksPart(body)),
		// The raw labels: a change of a priority label is a change whatever the project calls it.
		priority: hash(sorted(priorityLabelsOf(names, ctx.priority))),
		claim: hash(blockClaimPart(() => parsedOrThrow(body).claim)),
	};
}

/** The revision string of an issue as read. */
export function revisionOf(issue: ApiIssue, ctx: MapContext): string {
	const hashes = fieldHashes(issue, ctx);
	return `${issue.updated_at}#${FIELD_GROUPS.map(group => hashes[group]).join('.')}`;
}

function partsOf(revision: string): FieldHashes | undefined {
	const at = revision.lastIndexOf('#');
	return at < 0 ? undefined : partsFromHashes(revision.slice(at + 1), FIELD_GROUPS);
}

/**
 * The parts among `groups` that differ between the revision the caller read and the current one; empty = the write may go on. The
 * same revision is never stale. A revision this backend did not issue is `['revision']` (stale for any write).
 */
export function checkRevision(expected: string, actual: string, groups: readonly FieldGroup[]): string[] {
	return checkRevisionParts(expected, actual, groups, partsOf);
}
