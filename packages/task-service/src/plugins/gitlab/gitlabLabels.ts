// The labels a gitlab project's configuration needs in the project: the status labels of the statusMap, the labels of the types, and
// the tombstone label when deletion is emulated. `task labels sync` creates them, `task strategy check` reports the missing ones.
// Pure: no I/O. The rule is shared with github (`forge-common/wantedLabels.ts`).
import { wantedLabelsOf } from '../forge-common/wantedLabels.js';
import type { WantedLabel } from '../forge-common/wantedLabels.js';
import type { DeclaredFills } from '../kinds.js';
import type { GitLabSettings } from './gitlabOptions.js';
import { TOMBSTONE_LABEL } from './gitlabMapping.js';

export type { WantedLabel, WantedLabelKind } from '../forge-common/wantedLabels.js';

/** In the order of the config: statuses, then types, then the tombstone. A name appears once (names are case sensitive on GitLab). */
export function wantedLabels(
	settings: GitLabSettings,
	projectTypes: readonly string[],
	fills: DeclaredFills
): WantedLabel[] {
	return wantedLabelsOf(settings, projectTypes, fills, TOMBSTONE_LABEL, name => name);
}
