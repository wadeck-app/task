// The labels a github project's configuration needs in the repository: the status labels of the statusMap, the labels of the types,
// the labels of the priorities when they live in labels, and the tombstone label when deletion is emulated. `task labels sync`
// creates them, `task strategy check` reports the missing ones. Pure: no I/O. The rule is shared with gitlab
// (`forge-common/wantedLabels.ts`).
import { wantedLabelsOf } from '../forge-common/wantedLabels.js';
import type { WantedLabel } from '../forge-common/wantedLabels.js';
import type { DeclaredFills } from '../kinds.js';
import type { GitHubSettings } from './githubOptions.js';
import { labelOfPriority } from './githubPriority.js';
import type { PriorityContext } from './githubPriority.js';
import { TOMBSTONE_LABEL } from './issueMapping.js';

export type { WantedLabel, WantedLabelKind } from '../forge-common/wantedLabels.js';

/** The label of each priority of the project, in the order of the project's priorities (none when the priorities are not known). */
export function priorityLabelsWanted(pc: PriorityContext): Array<{ name: string; why: string }> {
	return (pc.priorities ?? []).map(priority => ({
		name: labelOfPriority(priority, pc),
		why: `priority "${priority}"`,
	}));
}

/**
 * In the order of the config: statuses, then types, then (`priorityLabels`, given only when the priority lives in labels) priorities,
 * then the tombstone. A name appears once, whatever its case.
 */
export function wantedLabels(
	settings: GitHubSettings,
	projectTypes: readonly string[],
	fills: DeclaredFills,
	priorityLabels: ReadonlyArray<{ name: string; why: string }> = []
): WantedLabel[] {
	return wantedLabelsOf(settings, projectTypes, fills, TOMBSTONE_LABEL, name => name.toLowerCase(), priorityLabels);
}
