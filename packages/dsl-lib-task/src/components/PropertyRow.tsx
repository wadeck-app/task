import React, { useContext } from 'react';
import { PropertyLayoutContext } from '../propertyContext.js';
import type { PropertyDensity, PropertyLabelWidth } from '../propertyContext.js';

export interface PropertyRowProps {
	/** The name of the property. */
	label: string;
	/** Explains the property; shown as a tooltip on the label. */
	hint?: string;
	/** Inline labels only: `text` (default) lines the label up with a line of text, `control` with the text of a 32 px control (a picker, a chip row). */
	align?: 'text' | 'control';
	/**
	 * The value: any nodes.
	 * @slot tag:layout, tag:display, tag:composite, tag:atomic, tag:form
	 */
	items: React.ReactNode;
}

// @formatter:off
const LABEL_WIDTH: Record<PropertyLabelWidth, string> = {
	narrow: 'w-24',
	normal: 'w-32',
	wide: 'w-40',
};
const ROW_PADDING: Record<PropertyDensity, string> = {
	compact: 'py-0.5 text-sm',
	comfortable: 'py-1 text-sm',
};
// @formatter:on

/**
 * One label / value row of a PropertyList. Takes its density and label placement from the list around it.
 *
 * @registryCategory composite
 * @registryTags property row details
 */
export function PropertyRow({ label, hint, align = 'text', items }: PropertyRowProps): React.ReactElement {
	const { density, labelPlacement, labelWidth } = useContext(PropertyLayoutContext);
	const inline = labelPlacement === 'inline';
	return (
		<div
			data-testid="property-row"
			className={`flex ${inline ? 'flex-row items-start gap-3' : 'flex-col gap-0.5'} ${ROW_PADDING[density]}`}
		>
			<span
				title={hint}
				className={`shrink-0 text-xs font-medium tracking-wide text-muted${inline ? ` ${LABEL_WIDTH[labelWidth]} ${align === 'control' ? 'pt-2' : 'pt-0.5'}` : ''}`}
			>
				{label}
			</span>
			<div className="min-w-0 flex-1 text-content">{items}</div>
		</div>
	);
}
