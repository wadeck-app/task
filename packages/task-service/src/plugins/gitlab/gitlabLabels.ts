// The labels a gitlab project's configuration needs in the project: the status labels of the statusMap, the labels of the types, the
// labels of the priorities (on GitLab a priority is always a label) and the tombstone label when deletion is emulated. `task labels
// sync` creates them, `task strategy check` reports the missing ones.
// Pure: no I/O. The rule is shared with github (`forge-common/wantedLabels.ts`).
import { wantedLabelsOf } from '../forge-common/wantedLabels.js';
import type { WantedLabel } from '../forge-common/wantedLabels.js';
import type { DeclaredFills } from '../kinds.js';
import type { GitLabSettings } from './gitlabOptions.js';
import { TOMBSTONE_LABEL } from './gitlabMapping.js';
import { labelOfPriority } from './gitlabPriority.js';
import type { PriorityContext } from './gitlabPriority.js';

export type { WantedLabel, WantedLabelKind } from '../forge-common/wantedLabels.js';

/** The label of each priority of the project, in the order of the project's priorities (none when the priorities are not known). */
export function priorityLabelsWanted(pc: PriorityContext): Array<{ name: string; why: string }> {
	return (pc.priorities ?? []).map(priority => ({
		name: labelOfPriority(priority, pc),
		why: `priority "${priority}"`,
	}));
}

/** In the order of the config: statuses, then types, then priorities, then the tombstone. A name appears once (names are case sensitive on GitLab). */
export function wantedLabels(
	settings: GitLabSettings,
	projectTypes: readonly string[],
	fills: DeclaredFills,
	priority: PriorityContext
): WantedLabel[] {
	return wantedLabelsOf(settings, projectTypes, fills, TOMBSTONE_LABEL, name => name, priorityLabelsWanted(priority));
}
