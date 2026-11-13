// The labels a gitlab project's configuration needs in the project: the status labels of the statusMap, the labels of the types, and
// the tombstone label when deletion is emulated. `task labels sync` creates them, `task strategy check` reports the missing ones.
// Pure: no I/O.
import type { DeclaredFills } from '../kinds.js';
import type { GitLabSettings } from './gitlabOptions.js';
import { TOMBSTONE_LABEL } from './gitlabMapping.js';

export type WantedLabelKind = 'status' | 'type' | 'deleted';

export interface WantedLabel {
	name: string;
	kind: WantedLabelKind;
	/** Why the project needs it, for the report (`status "review"`). */
	why: string;
}

/** In the order of the config: statuses, then types, then the tombstone. A name appears once (names are case sensitive on GitLab). */
export function wantedLabels(
	settings: GitLabSettings,
	projectTypes: readonly string[],
	fills: DeclaredFills
): WantedLabel[] {
	const wanted = new Map<string, WantedLabel>();
	const add = (label: WantedLabel): void => void (wanted.has(label.name) || wanted.set(label.name, label));
	for (const [status, rule] of Object.entries(settings.statusMap)) {
		if (rule.label !== undefined) add({ name: rule.label, kind: 'status', why: `status "${status}"` });
	}
	for (const type of projectTypes) {
		const rule = Object.hasOwn(settings.typeMap, type) ? settings.typeMap[type] : undefined;
		// A type mapped to a native issue type needs no label.
		if (rule?.issueType !== undefined) continue;
		add({ name: rule?.label ?? `${settings.typePrefix}${type}`, kind: 'type', why: `type "${type}"` });
	}
	if (fills['delete']?.use === 'tombstone') {
		add({ name: TOMBSTONE_LABEL, kind: 'deleted', why: 'deleted tasks (fills.delete: tombstone)' });
	}
	return [...wanted.values()];
}
