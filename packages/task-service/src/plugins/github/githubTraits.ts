// What the github strategy keeps and where its limits are, for `task migrate` (the loss table is built from this before any write).
import type { BackendTraits } from '@wadeck-app/task-core';

import type { DeclaredFills } from '../kinds.js';
import { githubCostModel } from './githubCostModel.js';
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

/** A field written on its own: the conditional re-read, the write, and the record read again (issue, timeline). The counts of a whole run are in githubCostModel.ts. */
const REQUESTS_PER_WRITE = 4;
/**
 * Seconds one write takes besides the spacing between writes. AN ASSUMPTION, not a measurement of this code: about 4 requests around a
 * write at the 0.3 to 1 s per request measured on github.com (2026-11-08, before the create carried its fields), so about 3 s.
 */
const SECONDS_BESIDES_SPACING = 3;
/** GitHub documents 80 content-generating requests a minute and 500 an hour (docs.github.com, rate limits for the REST API). */
const CONTENT_PER_MINUTE = 80;
const CONTENT_PER_HOUR = 500;

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
	// With the native field the prefix is free; with labels (or auto, which may fall back to them) it carries the priority of a task.
	const priorityPrefix = settings.priority.storage === 'field' ? undefined : settings.priority.prefix.toLowerCase();

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
			// `resolve` answers the fields of one issue with ONE request (no timeline, comments or blockers).
			resolve: { requests: 1, seconds: 0.35 },
			quotaPerHour: QUOTA_PER_HOUR,
			contentCap: {
				perHour: CONTENT_PER_HOUR,
				perMinute: CONTENT_PER_MINUTE,
				source: 'GitHub documents 80 content-generating requests a minute and 500 an hour (docs.github.com, rate limits for the REST API)',
			},
			model: githubCostModel(settings, fills),
		},
		foldsCreate: true,
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
			if (priorityPrefix !== undefined && lower.startsWith(priorityPrefix)) {
				return `"${label}" is reserved: it carries the priority of a task`;
			}
			if (lower === TOMBSTONE_LABEL) return `"${label}" is reserved: it marks a deleted task`;
			return undefined;
		},
	};
}
