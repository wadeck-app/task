// The revision of an issue (design 1.6) and the check of a write against the revision the caller read.
//
// GitHub has no conditional write (`If-Match` is a 400), and `updated_at` has a one second resolution and is bumped by comments and
// label changes. So the revision is `<updated_at>#<etag>#<one short hash per part of the issue>`, and a write compares the PARTS IT
// CHANGES: a comment, or a label added to a task whose title is being edited, is not a conflict, while a rename made behind our back
// is, even when both fall in the same second. The hashes hide the text (the revision is shown in JSON and logs).
import * as crypto from 'node:crypto';

import { labelNames, splitBody, typeOfLabel, userLabels } from './issueMapping.js';
import type { ApiIssue, MapContext } from './issueMapping.js';

/** The parts of an issue a write can change. */
export const FIELD_GROUPS = ['title', 'body', 'status', 'type', 'labels', 'meta', 'parent', 'dependencies'] as const;
export type FieldGroup = (typeof FIELD_GROUPS)[number];
export type FieldHashes = Record<FieldGroup, string>;

function hash(text: string): string {
	return crypto.createHash('sha1').update(text).digest('hex').slice(0, 6);
}

const lowerSorted = (names: readonly string[]): string =>
	names
		.map(name => name.toLowerCase())
		.sort()
		.join('\n');

function metaPart(issue: ApiIssue, ctx: MapContext): string {
	if (ctx.metaFromBlock) {
		try {
			const meta = splitBody(issue, ctx).blockMeta ?? {};
			return JSON.stringify(
				Object.keys(meta)
					.sort()
					.map(key => [key, meta[key]])
			);
		} catch {
			// An unreadable block still has a stable hash: the write that reads it reports the problem.
			return 'unreadable';
		}
	}
	if (!ctx.metaFromLabels) return '';
	const prefix = ctx.settings.metaPrefix.toLowerCase();
	return lowerSorted(labelNames(issue).filter(name => name.toLowerCase().startsWith(prefix)));
}

/** One short hash per part of the issue. */
export function fieldHashes(issue: ApiIssue, ctx: MapContext): FieldHashes {
	const names = labelNames(issue);
	const statusLabels = names.filter(name => ctx.mapper.isStatusLabel(name));
	const typeLabels = names.filter(name => typeOfLabel(name, ctx) !== undefined);
	return {
		title: hash(issue.title),
		body: hash((issue.body ?? '').replace(/\r\n/g, '\n')),
		status: hash(`${issue.state}|${issue.state_reason ?? ''}|${lowerSorted(statusLabels)}`),
		type: hash(`${lowerSorted(typeLabels)}|${(issue.type?.name ?? '').toLowerCase()}`),
		labels: hash(lowerSorted(userLabels(issue, ctx))),
		meta: hash(metaPart(issue, ctx)),
		parent: hash(issue.parent_issue_url ?? ''),
		dependencies: hash(
			`${issue.issue_dependencies_summary?.total_blocked_by ?? 0}|${issue.issue_dependencies_summary?.total_blocking ?? 0}`
		),
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
	if (hashes === undefined || rest.length > 0) return undefined;
	const values = hashes.split('.');
	if (values.length !== FIELD_GROUPS.length || values.some(value => !/^[0-9a-f]{6}$/.test(value))) return undefined;
	return Object.fromEntries(FIELD_GROUPS.map((group, index) => [group, values[index]!])) as FieldHashes;
}

/**
 * The parts among `groups` that differ between the revision the caller read and the current one; empty = the write may go on. The
 * same revision is never stale. A revision this backend did not issue is `['revision']` (stale for any write).
 */
export function checkRevision(expected: string, actual: string, groups: readonly FieldGroup[]): string[] {
	if (expected === actual) return [];
	const wanted = partsOf(expected);
	const current = partsOf(actual);
	if (wanted === undefined || current === undefined) return ['revision'];
	return groups.filter(group => wanted[group] !== current[group]);
}
