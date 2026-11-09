// What the github strategy keeps and where its limits are, for `task migrate` (the loss table is built from this before any write).
import type { BackendTraits } from '@wadeck-app/task-core';

import type { DeclaredFills } from '../kinds.js';
import { labelProblem } from './githubOptions.js';
import type { GitHubSettings } from './githubOptions.js';
import { TOMBSTONE_LABEL } from './issueMapping.js';
import { BODY_MAX } from './githubWrites.js';

/** GitHub allows 8 levels of sub-issues and 100 sub-issues under one parent. */
const MAX_DEPTH = 8;
const MAX_CHILDREN = 100;
/** Room left in the body for the managed block (metadata, duplicate marker) the strategy may add. */
const BODY_ROOM = 4096;
/** GitHub allows 5000 requests an hour to a token. */
const QUOTA_PER_HOUR = 5000;

/** Rough cost of one port write: the conditional re-read, the write, and the record read again (issue, timeline, comments). */
const REQUESTS_PER_WRITE = 7;
/** Seconds one port write takes besides the spacing between writes (measured: 0.8 to 1.5 s per request on github.com). */
const SECONDS_BESIDES_SPACING = 3;

export function githubTraits(settings: GitHubSettings, fills: DeclaredFills): BackendTraits {
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
		keepsCreatedAt: false,
		authoredComments: false,
		commentTextMax: BODY_MAX,
		descriptionMax: BODY_MAX - BODY_ROOM,
		hierarchyDepth: MAX_DEPTH,
		childrenPerParent: MAX_CHILDREN,
		cost: {
			requests: REQUESTS_PER_WRITE,
			seconds: settings.writeSpacingSeconds + SECONDS_BESIDES_SPACING,
			// Reading one task: the issue and its timeline (the comments only when it has some); measured 0.7 s.
			read: { requests: 2, seconds: 0.7 },
			quotaPerHour: QUOTA_PER_HOUR,
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
			return undefined;
		},
	};
}
