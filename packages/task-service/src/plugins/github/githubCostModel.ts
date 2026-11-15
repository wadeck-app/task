// What a migration into a GitHub project costs, counted from what the code does (githubWrites.ts, GitHubBackend.ts), for the estimate
// `task migrate --dry-run` prints BEFORE anything is written. The counts per call are the ones the fake server records
// (GitHubBackend.requestBudget.test.ts and migrate/migrateGithubCost.test.ts pin them); the real API answers the same requests, so the
// request COUNTS carry over, the times do not (see githubTraits.ts for the one time constant, which is an assumption).
//
// A "write" here is a request that changes GitHub (it is what the spacing between writes and GitHub's content-creation cap count): a create,
// a patch, a label creation, a sub-issue attach, a dependency, a comment.
import type { MigrationCostModelResult, MigrationTaskFacts } from '@wadeck-app/task-core';

import type { DeclaredFills } from '../kinds.js';
import type { GitHubSettings } from './githubOptions.js';

/** Create: the POST, then the record read again (the issue and its timeline). */
const CREATE_REQUESTS = 3;
/** Closing at creation: one PATCH (GitHub ignores the state in a create). */
const CLOSE_REQUESTS = 1;
/** Attaching to the parent: the read of the parent issue and the POST. */
const ATTACH_REQUESTS = 2;
/** A field written on its own: the conditional re-read, the write, the record read again (issue and timeline). */
const SEPARATE_WRITE_REQUESTS = 4;
/** A link: the re-read, the read of the other end, the check of what it already depends on, the POST, the record read again. */
const LINK_REQUESTS = 7;
/** A comment: the re-read, the POST, the record read again (issue, comments, timeline). */
const COMMENT_REQUESTS = 5;
/** A label the repository may lack: the probe and the creation. */
const LABEL_REQUESTS = 2;
/** The check reads a task with neither link nor comment with one request (the issue), the others whole: issue, timeline, + comments, + blockers. */
const CHECK_FIELDS_REQUESTS = 1;

export function githubCostModel(
	settings: GitHubSettings,
	fills: DeclaredFills
): (tasks: readonly MigrationTaskFacts[]) => MigrationCostModelResult {
	const metaMode = fills['meta']?.use;
	const priorityStorage = settings.priority.storage;
	const lower = (text: string): string => text.toLowerCase();
	const { map, prefix } = settings.priority;
	const priorityLabel = (priority: string): string =>
		Object.hasOwn(map, priority) ? map[priority]! : `${prefix}${priority}`;

	return tasks => {
		let writes = 0;
		let requests = 0;
		let verifyRequests = 0;
		const labels = new Set<string>();
		let autoPriority = false;
		let markerLabels = 0;

		for (const task of tasks) {
			// A task the run creates carries its fields in the create call; one an earlier run created gets what it lacks field by field.
			const carried = task.state === 'new';
			let separate = 0;
			const rule = settings.statusMap[task.status];
			if (carried) {
				writes += 1;
				requests += CREATE_REQUESTS;
				if (rule?.state === 'closed') {
					writes += 1;
					requests += CLOSE_REQUESTS;
				}
				if (task.hasParent) {
					writes += 1;
					requests += ATTACH_REQUESTS;
				}
				if (rule?.label !== undefined) labels.add(lower(rule.label));
			}
			if (task.type !== undefined) {
				const typeRule = Object.hasOwn(settings.typeMap, task.type) ? settings.typeMap[task.type] : undefined;
				if (typeRule?.issueType !== undefined || !carried) separate++;
				else labels.add(lower(typeRule?.label ?? `${settings.typePrefix}${task.type}`));
			}
			if (task.priority !== undefined) {
				if (carried && priorityStorage === 'label') labels.add(lower(priorityLabel(task.priority)));
				else {
					separate++;
					if (priorityStorage === 'auto') autoPriority = true;
				}
			}
			if (task.assignee !== undefined) separate++;
			for (const label of task.labels) {
				if (carried) labels.add(lower(label));
				else separate++;
			}
			// Metadata: labels (one per entry, the marker's is unique to its task) or entries of the body block (no cost in the create).
			const entries = Object.entries(task.meta);
			if (metaMode === 'labels') {
				for (const [key, value] of entries) {
					if (carried) labels.add(lower(`${settings.metaPrefix}${key}${value === '' ? '' : `=${value}`}`));
					else separate++;
				}
				if (task.marker) {
					if (carried) markerLabels++;
					else separate++;
				}
			} else if (metaMode === 'body-block') {
				if (!carried) separate += entries.length + (task.marker ? 1 : 0);
			}
			writes += separate;
			requests += separate * SEPARATE_WRITE_REQUESTS;

			writes += task.links.length;
			requests += task.links.length * LINK_REQUESTS;
			writes += task.comments;
			requests += task.comments * COMMENT_REQUESTS;

			const whole = task.links.length > 0 || task.comments > 0;
			const check = whole
				? 2 + (task.comments > 0 ? 1 : 0) + (task.links.includes('blockedBy') ? 1 : 0)
				: CHECK_FIELDS_REQUESTS;
			verifyRequests += check;
			requests += check;
		}

		const created = labels.size + markerLabels;
		writes += created;
		requests += created * LABEL_REQUESTS;

		const notes = [
			created > 0
				? `${created} label(s) are counted as to be created (the plan cannot see which ones already exist in the repository): a label that exists costs one request, not two, and no write`
				: undefined,
			autoPriority
				? 'priorityStorage: auto is counted as a write of its own per priority; with labels (the usual fallback) the priority rides in the create and costs nothing'
				: undefined,
		].filter((note): note is string => note !== undefined);
		return { writes, requests, verifyRequests, notes };
	};
}
