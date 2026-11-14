// The revision of an issue (design 1.6) and the check of a write against the revision the caller read.
//
// GitLab documents no optimistic-lock parameter on the issue edit (VERIFIED absence on docs.gitlab.com/api/issues; the ETag of the
// REST API is UNVERIFIED), and `updated_at` is bumped by notes, label changes and state changes alike. So the revision is
// `<updated_at>#<one short hash per part of the issue>`, and a write compares the PARTS IT CHANGES: a comment, or a label added to a
// task whose title is being edited, is not a conflict, while a rename made behind our back is, even when both fall in the same
// second. The hashes hide the text (the revision is shown in JSON and logs). The issue links are not part of the revision: the
// issue JSON does not carry them, and a link write reads the link list right before it writes.
import { blockMetaPart, checkRevisionParts, partsFromHashes, shortHash } from '../forge-common/revisionParts.js';
import { labelNames, splitBody, typeOfLabel, userLabels } from './gitlabMapping.js';
import type { MapContext } from './gitlabMapping.js';
import type { ApiIssue } from './gitlabTypes.js';

/** The parts of an issue a write can change. */
export const FIELD_GROUPS = ['title', 'body', 'status', 'type', 'labels', 'meta'] as const;
export type FieldGroup = (typeof FIELD_GROUPS)[number];
export type FieldHashes = Record<FieldGroup, string>;

const hash = shortHash;

// Label names are compared exactly: GitLab labels are case sensitive.
const sorted = (names: readonly string[]): string => [...names].sort().join('\n');

function metaPart(issue: ApiIssue, ctx: MapContext): string {
	if (ctx.metaFromBlock) return blockMetaPart(() => splitBody(issue, ctx).blockMeta);
	if (!ctx.metaFromLabels) return '';
	const prefix = ctx.settings.metaPrefix;
	return sorted(labelNames(issue).filter(name => name.startsWith(prefix)));
}

/** One short hash per part of the issue. */
export function fieldHashes(issue: ApiIssue, ctx: MapContext): FieldHashes {
	const names = labelNames(issue);
	const statusLabels = names.filter(name => ctx.mapper.isStatusLabel(name));
	const typeLabels = names.filter(name => typeOfLabel(name, ctx) !== undefined);
	return {
		title: hash(issue.title),
		body: hash((issue.description ?? '').replace(/\r\n/g, '\n')),
		status: hash(`${issue.state}|${sorted(statusLabels)}`),
		type: hash(`${sorted(typeLabels)}|${issue.issue_type ?? ''}`),
		labels: hash(sorted(userLabels(issue, ctx))),
		meta: hash(metaPart(issue, ctx)),
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
