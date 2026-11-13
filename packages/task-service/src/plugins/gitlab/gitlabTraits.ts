// What the gitlab strategy keeps and where its limits are, for `task migrate` (the loss table is built from this before any write).
// The limits are the documented or recorded ones (gitlab.com Free, 2026-11-09), the costs are estimates.
import type { BackendTraits } from '@wadeck-app/task-core';

import type { DeclaredFills } from '../kinds.js';
import { COMMENT_MAX, DESCRIPTION_MAX, labelProblem } from './gitlabOptions.js';
import { CHILDREN_READ_MAX, HIERARCHY_DEPTH } from './gitlabWorkItems.js';
import type { GitLabSettings } from './gitlabOptions.js';
import { TOMBSTONE_LABEL } from './gitlabMapping.js';

/** Room left in the description for the managed block (metadata, duplicate / caused-by markers) the strategy may add. */
const BODY_ROOM = 4096;

/** Rough cost of one port write: the conditional re-read, the write, and the record read again (issue, notes, two event lists, links). ESTIMATE. */
const REQUESTS_PER_WRITE = 7;
/** Seconds one port write takes besides the spacing between writes. ESTIMATE (GitLab.com answers in a few hundred ms per request). */
const SECONDS_BESIDES_SPACING = 3;

export function gitlabTraits(settings: GitLabSettings, fills: DeclaredFills): BackendTraits {
	const statusLabels = new Set(
		Object.values(settings.statusMap)
			.map(rule => rule.label)
			.filter((label): label is string => label !== undefined)
	);
	const typeLabels = new Set(
		Object.values(settings.typeMap)
			.map(rule => rule.label)
			.filter((label): label is string => label !== undefined)
	);
	const typePrefix = settings.typePrefix;
	const metaPrefix = settings.metaPrefix;
	const metaInLabels = fills['meta']?.use === 'labels';

	return {
		// `created_at` of a create needs administrator or owner rights (docs.gitlab.com/api/issues): never relied on.
		keepsCreatedAt: false,
		authoredComments: false,
		commentTextMax: COMMENT_MAX,
		descriptionMax: DESCRIPTION_MAX - BODY_ROOM,
		// Free tier: an Issue or Incident and its native Tasks, two levels (VERIFIED-LIVE). The migration plan drops a deeper parent with a
		// loss row. Children: task reads 100 at most and refuses a longer list, so a parent holds 99 here.
		hierarchyDepth: HIERARCHY_DEPTH,
		childrenPerParent: CHILDREN_READ_MAX - 1,
		cost: {
			requests: REQUESTS_PER_WRITE,
			seconds: settings.writeSpacingSeconds + SECONDS_BESIDES_SPACING,
			read: { requests: 6, seconds: 1.8 },
		},
		labelProblem: label => {
			const refused = labelProblem(label);
			if (refused !== undefined) return refused;
			if (statusLabels.has(label)) return `"${label}" is reserved: it carries the status of a task`;
			if (typeLabels.has(label) || label.startsWith(typePrefix)) {
				return `"${label}" is reserved: it carries the type of a task`;
			}
			if (metaInLabels && label.startsWith(metaPrefix))
				return `"${label}" is reserved: it carries the metadata of a task`;
			if (label === TOMBSTONE_LABEL) return `"${label}" is reserved: it marks a deleted task`;
			return undefined;
		},
	};
}
