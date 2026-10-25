import React from 'react';

type Gap = 'gap-1' | 'gap-2' | 'gap-3' | 'gap-4';
type Align = 'center' | 'start' | 'end' | 'baseline';

// @formatter:off
const ALIGN_CLASSES: Record<Align, string> = {
	center: 'items-center',
	start: 'items-start',
	end: 'items-end',
	baseline: 'items-baseline',
};
// @formatter:on

export interface ChipRowProps {
	/** @slot tag:atomic, tag:composite, tag:display */
	items: React.ReactNode;
	/** Space between the chips, horizontally and once wrapped, vertically. */
	gap?: Gap;
	align?: Align;
}

/**
 * A row of chips (status, labels, links...) that WRAPS onto further lines when the column is narrow. dsl-ui
 * `HorizontalStack` never wraps, so a property bar built with it overflows below about 900 px.
 *
 * IN SCOPE: a line of small controls. OUT OF SCOPE: columns, grids, item sizing (use SplitLayout).
 *
 * @registryCategory disposition
 * @registryTags layout chips wrap row
 */
export function ChipRow({ items, gap = 'gap-2', align = 'center' }: ChipRowProps): React.ReactElement {
	return (
		<div data-testid="chip-row" className={`flex min-w-0 flex-wrap ${gap} ${ALIGN_CLASSES[align]}`}>
			{items}
		</div>
	);
}
