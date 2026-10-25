import React from 'react';

type SideWidth = 'narrow' | 'normal' | 'wide';

// @formatter:off
const SIDE_WIDTH_CLASSES: Record<SideWidth, string> = {
	narrow: 'lg:w-64',
	normal: 'lg:w-80',
	wide: 'lg:w-96',
};
// @formatter:on

export interface SplitLayoutProps {
	/** The primary column: it takes the remaining width. */
	main: React.ReactNode;
	/** The secondary column (facts, properties, actions): a fixed width on wide screens. */
	side: React.ReactNode;
	/** Which side of `main` the secondary column sits on, from the `lg` breakpoint up. Stacked, `main` always comes first. */
	sidePosition?: 'right' | 'left';
	/** Width of the secondary column from the `lg` breakpoint up. */
	sideWidth?: SideWidth;
	/** Keeps the secondary column in view while the main one scrolls (from the `lg` breakpoint up). */
	sticky?: boolean;
	/** Space between the columns (and between them once stacked). */
	gap?: 'gap-4' | 'gap-6' | 'gap-8';
}

/**
 * Two columns, a main one and a side one, that stack below the `lg` breakpoint (1024 px of viewport).
 *
 * IN SCOPE: the page-level split of a detail view (content on one side, properties on the other).
 * OUT OF SCOPE: grids of cards, any further breakpoint, resizable panes.
 *
 * @registryCategory disposition
 * @registryTags layout split sidebar responsive
 */
export function SplitLayout({
	main,
	side,
	sidePosition = 'right',
	sideWidth = 'normal',
	sticky = true,
	gap = 'gap-6',
}: SplitLayoutProps): React.ReactElement {
	const direction = sidePosition === 'left' ? 'lg:flex-row-reverse' : 'lg:flex-row';
	const sideClass = [
		'min-w-0 w-full shrink-0',
		SIDE_WIDTH_CLASSES[sideWidth],
		// self-start: a sticky column stretched to the height of the row would have nothing to slide in.
		sticky ? 'lg:sticky lg:top-4 lg:self-start' : '',
	]
		.filter(Boolean)
		.join(' ');
	return (
		<div data-testid="split-layout" className={`flex flex-col ${direction} ${gap}`}>
			<div data-testid="split-layout-main" className="min-w-0 flex-1">
				{main}
			</div>
			<div data-testid="split-layout-side" className={sideClass}>
				{side}
			</div>
		</div>
	);
}
