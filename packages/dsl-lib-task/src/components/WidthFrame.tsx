import React from 'react';

type Width = 'left' | 'wide' | 'centered' | 'full' | 'reading';

// @formatter:off
const WIDTH_CLASSES: Record<Width, string> = {
	left: 'max-w-6xl',
	wide: 'max-w-7xl',
	centered: 'mx-auto max-w-6xl',
	full: 'max-w-full',
	reading: 'max-w-4xl',
};
// @formatter:on

export interface WidthFrameProps {
	/** `left`: 72rem against the menu (default). `wide`: 80rem. `centered`: 72rem centred. `full`: the whole area. `reading`: 56rem. */
	width?: Width;
	/** The page content. @slot tag:layout, tag:table, tag:form, tag:display, tag:composite, tag:atomic */
	items: React.ReactNode;
}

/**
 * The width of a page design: a frame that caps and aligns its content and makes every text break inside it.
 *
 * The page sits in a dsl-ui `PageContent` with `maxWidth: full`; the default PageContent (72rem, centred) would cap every
 * design at the same width. A design wraps its view in this frame with the width it was drawn for.
 *
 * IN SCOPE: capping and aligning the width of a page. OUT OF SCOPE: columns (use SplitLayout), padding, breakpoints,
 * experiments (the width is fixed per design).
 *
 * @registryCategory disposition
 * @registryTags layout width page frame
 */
export function WidthFrame({ width = 'left', items }: WidthFrameProps): React.ReactElement {
	const chosen: Width = width in WIDTH_CLASSES ? width : 'left';
	return (
		<div
			data-testid="width-frame"
			data-width={chosen}
			className={`w-full min-w-0 [overflow-wrap:anywhere] ${WIDTH_CLASSES[chosen]}`}
		>
			{items}
		</div>
	);
}
