// The labels a github project's configuration needs in the repository: the status labels of the statusMap, the labels of the types,
// and the tombstone label when deletion is emulated. `task labels sync` creates them, `task strategy check` reports the missing ones.
// Pure: no I/O. The rule is shared with gitlab (`forge-common/wantedLabels.ts`).
import { wantedLabelsOf } from '../forge-common/wantedLabels.js';
import type { WantedLabel } from '../forge-common/wantedLabels.js';
import type { DeclaredFills } from '../kinds.js';
import type { GitHubSettings } from './githubOptions.js';
import { TOMBSTONE_LABEL } from './issueMapping.js';

export type { WantedLabel, WantedLabelKind } from '../forge-common/wantedLabels.js';

/** In the order of the config: statuses, then types, then the tombstone. A name appears once, whatever its case. */
export function wantedLabels(
	settings: GitHubSettings,
	projectTypes: readonly string[],
	fills: DeclaredFills
): WantedLabel[] {
	return wantedLabelsOf(settings, projectTypes, fills, TOMBSTONE_LABEL, name => name.toLowerCase());
}
