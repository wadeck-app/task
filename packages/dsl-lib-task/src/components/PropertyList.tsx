import React, { useMemo } from 'react';
import { PropertyLayoutContext } from '../propertyContext.js';
import type { PropertyDensity, PropertyLabelPlacement, PropertyLabelWidth } from '../propertyContext.js';

export interface PropertyListProps {
	/** Row spacing: `compact` for a dense sidebar, `comfortable` for a page body. */
	density?: PropertyDensity;
	/** `stacked`: label above its value. `inline`: label in a column on the left of its value. */
	labelPlacement?: PropertyLabelPlacement;
	/** Width of the label column when inline. */
	labelWidth?: PropertyLabelWidth;
	/** Thin line between rows. */
	dividers?: boolean;
	/**
	 * The rows (PropertyRow nodes; a row alone also works, with the default layout).
	 * @slot tag:composite
	 */
	items: React.ReactNode;
}

// @formatter:off
const DENSITY_GAP: Record<PropertyDensity, string> = {
	compact: 'gap-y-1.5',
	comfortable: 'gap-y-3',
};
// @formatter:on

/**
 * A list of label / value rows (the facts of an item: status, type, dates...).
 *
 * IN SCOPE: aligned label and value pairs, any node as a value. OUT OF SCOPE: editing (put a control in the value).
 *
 * @registryCategory composite
 * @registryTags property list details sidebar
 */
export function PropertyList({
	density = 'comfortable',
	labelPlacement = 'stacked',
	labelWidth = 'normal',
	dividers = false,
	items,
}: PropertyListProps): React.ReactElement {
	const layout = useMemo(() => ({ density, labelPlacement, labelWidth }), [density, labelPlacement, labelWidth]);
	return (
		<PropertyLayoutContext.Provider value={layout}>
			<div
				data-testid="property-list"
				data-density={density}
				className={`flex flex-col ${DENSITY_GAP[density]}${dividers ? ' divide-y divide-border' : ''}`}
			>
				{items}
			</div>
		</PropertyLayoutContext.Provider>
	);
}
