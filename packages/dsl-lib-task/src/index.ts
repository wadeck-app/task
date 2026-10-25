import { createRegistry } from '@wadeck-app/dsl-renderer';
import type { ComponentRegistryEntry } from '@wadeck-app/dsl-renderer';
import { configureTaskUi } from './runtime-config.js';
import {
	ActionSelectEntry,
	BreadcrumbTrailEntry,
	LabelChipsEntry,
	NoticeEntry,
	PanelEntry,
	ProgressSummaryEntry,
	PropertyListEntry,
	PropertyRowEntry,
	SegmentedControlEntry,
	KeyValueListEntry,
	ChipRowEntry,
	SplitLayoutEntry,
	TabPanelsEntry,
	StatusBadgeEntry,
	TaskRowListEntry,
	TimelineEntry,
	VariantSwitcherEntry,
} from './generated/entries.js';

export interface TaskLibConfig {
	/** Where the module's API is mounted, e.g. `/api/modules/task`. */
	apiBase: string;
	/** Where the module's pages are mounted, e.g. `/modules/task`. */
	routeBase: string;
}

/**
 * The registry entries the library ships, configured for where the host mounts the API and the pages. Not imported
 * for its side effects: the components talk to `apiBase` only once this has been called. The names are the types
 * the views use, prefixed by the host with the module id (`$type: task:SplitLayout`).
 */
export function createTaskLibEntries(config: TaskLibConfig): ComponentRegistryEntry[] {
	configureTaskUi({ apiBase: config.apiBase, routeBase: config.routeBase });

	const registry = createRegistry([
		ActionSelectEntry,
		BreadcrumbTrailEntry,
		LabelChipsEntry,
		NoticeEntry,
		PanelEntry,
		ProgressSummaryEntry,
		PropertyListEntry,
		PropertyRowEntry,
		SegmentedControlEntry,
		KeyValueListEntry,
		ChipRowEntry,
		SplitLayoutEntry,
		TabPanelsEntry,
		StatusBadgeEntry,
		TaskRowListEntry,
		TimelineEntry,
		VariantSwitcherEntry,
	]);
	return Object.values(registry);
}
