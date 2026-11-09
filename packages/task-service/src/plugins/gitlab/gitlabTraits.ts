// What the gitlab strategy keeps and where its limits are, for `task migrate` (the loss table is built from this before any write).
// NOT VERIFIED AGAINST A REAL GITLAB: the limits are the documented ones, the costs are estimates (nothing was measured).
import type { BackendTraits } from '@wadeck-app/task-core';

import type { DeclaredFills } from '../kinds.js';
import { COMMENT_MAX, DESCRIPTION_MAX, labelProblem } from './gitlabOptions.js';
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
			.map(rule => rule.label?.toLowerCase())
			.filter((label): label is string => label !== undefined)
	);
	const typeLabels = new Set(
		Object.values(settings.typeMap)
			.map(rule => rule.label?.toLowerCase())
			.filter((label): label is string => label !== undefined)
	);
	const typePrefix = settings.typePrefix.toLowerCase();
	const metaPrefix = settings.metaPrefix.toLowerCase();
	const metaInLabels = fills['meta']?.use === 'labels';

	return {
		// `created_at` of a create needs administrator or owner rights (docs.gitlab.com/api/issues): never relied on.
		keepsCreatedAt: false,
		authoredComments: false,
		commentTextMax: COMMENT_MAX,
		descriptionMax: DESCRIPTION_MAX - BODY_ROOM,
		// No hierarchy at all (capability hierarchy: none): the migration plan drops parents with a loss row, so no depth is declared.
		cost: {
			requests: REQUESTS_PER_WRITE,
			seconds: settings.writeSpacingSeconds + SECONDS_BESIDES_SPACING,
			read: { requests: 5, seconds: 1.5 },
		},
		labelProblem: label => {
			const refused = labelProblem(label);
			if (refused !== undefined) return refused;
			const lower = label.toLowerCase();
			if (statusLabels.has(lower)) return `"${label}" is reserved: it carries the status of a task`;
			if (typeLabels.has(lower) || lower.startsWith(typePrefix)) {
				return `"${label}" is reserved: it carries the type of a task`;
			}
			if (metaInLabels && lower.startsWith(metaPrefix))
				return `"${label}" is reserved: it carries the metadata of a task`;
			if (lower === TOMBSTONE_LABEL) return `"${label}" is reserved: it marks a deleted task`;
			if (settings.tier === 'free' && label.includes('::')) {
				return `"${label}" is a scoped label, which exists on GitLab Premium and Ultimate only`;
			}
			return undefined;
		},
	};
}
