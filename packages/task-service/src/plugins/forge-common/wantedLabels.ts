// The labels a forge project's configuration needs in the repository: the status labels of the statusMap, the labels of the types,
// and the tombstone label when deletion is emulated. `task labels sync` creates them, `task strategy check` reports the missing ones.
// Pure: no I/O. What differs between forges is whether two names that differ by case are one label (`sameLabel`).
import type { DeclaredFills } from '../kinds.js';

export type WantedLabelKind = 'status' | 'type' | 'deleted';

export interface WantedLabel {
	name: string;
	kind: WantedLabelKind;
	/** Why the project needs it, for the report (`status "review"`). */
	why: string;
}

/** The part of the settings of a forge the labels come from. */
export interface LabelSettings {
	statusMap: Record<string, { label?: string | undefined }>;
	typeMap: Record<string, { label?: string | undefined; issueType?: string | undefined }>;
	typePrefix: string;
}

/**
 * In the order of the config: statuses, then types, then the tombstone. A name appears once; `identity` maps a name to what makes
 * two names the same label (lower case on GitHub, the name itself on GitLab).
 */
export function wantedLabelsOf(
	settings: LabelSettings,
	projectTypes: readonly string[],
	fills: DeclaredFills,
	tombstone: string,
	identity: (name: string) => string
): WantedLabel[] {
	const wanted = new Map<string, WantedLabel>();
	const add = (label: WantedLabel): void =>
		void (wanted.has(identity(label.name)) || wanted.set(identity(label.name), label));
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
		add({ name: tombstone, kind: 'deleted', why: 'deleted tasks (fills.delete: tombstone)' });
	}
	return [...wanted.values()];
}
