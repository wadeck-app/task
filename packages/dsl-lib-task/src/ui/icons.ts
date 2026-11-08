import {
	Ban,
	Copy,
	CornerDownRight,
	Files,
	Flame,
	Hand,
	Link2,
	ListPlus,
	Plus,
	Trash2,
	Unlink,
	Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** The icons a view can ask for by name (a `ControlButton`, a menu entry): Lucide only, a closed list so a typo is caught. */
export const NAMED_ICONS = {
	plus: Plus,
	trash: Trash2,
	link: Link2,
	unlink: Unlink,
	'sub-task': CornerDownRight,
	'add-sub-task': ListPlus,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof NAMED_ICONS;

/** Whether a value names one of {@link NAMED_ICONS}. */
export function isIconName(value: unknown): value is IconName {
	return typeof value === 'string' && Object.prototype.hasOwnProperty.call(NAMED_ICONS, value);
}

/**
 * One icon per relation, so that a choice reads without its words: what the link MEANS for this task (stopped by, stopping,
 * a copy of, copied by, started by, starting). Any other relation gets the plain link icon.
 */
export const RELATION_ICONS: Record<string, LucideIcon> = {
	blockedBy: Ban,
	blocks: Hand,
	duplicateOf: Copy,
	duplicates: Files,
	causedBy: Zap,
	causes: Flame,
};

/** The icon of a relation (see {@link RELATION_ICONS}). */
export function relationIcon(relation: string): LucideIcon {
	return RELATION_ICONS[relation] ?? Link2;
}
