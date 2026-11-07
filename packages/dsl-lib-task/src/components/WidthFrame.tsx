import { isDev, useAbExperiments, useAbTest, useRegisterAbTests } from '@wadeck-app/dsl-ui';
import React from 'react';

type Width = 'left' | 'centered' | 'full' | 'reading';

// @formatter:off
const WIDTH_CLASSES: Record<Width, string> = {
	left: 'max-w-6xl',
	centered: 'mx-auto max-w-6xl',
	full: 'max-w-full',
	reading: 'max-w-4xl',
};
// @formatter:on

const INITIAL: Width = 'left';

export interface WidthFrameProps {
	/** The page content. @slot tag:layout, tag:table, tag:form, tag:display, tag:composite, tag:atomic */
	items: React.ReactNode;
}

/**
 * The width of the task page, and the A/B row that changes it ("Width", in the same dock as the AbTest nodes of the
 * views). One component rather than an AbTest node because the choice wraps the WHOLE page: an AbTest holding the page
 * would repeat every design once per width in the generated view.
 *
 * The page sits in a dsl-ui `PageContent` with `maxWidth: full`; the default PageContent (72rem, centred) would cap every
 * choice. Left (default): at most 72rem, against the menu, so a wide screen has no empty band on its left. Centered: the
 * old PageContent column. Full: the whole area. Reading: 56rem.
 * Experiments off (production, or the host did not enable them): the default width, no storage or URL read, no row.
 *
 * IN SCOPE: capping and aligning the width of a page. OUT OF SCOPE: columns (use SplitLayout), padding, breakpoints.
 *
 * @registryCategory disposition
 * @registryTags layout width page frame experiment
 */
export function WidthFrame({ items }: WidthFrameProps): React.ReactElement {
	const host = useAbExperiments();
	const enabled = host ? host.enabled : isDev();
	const test = useAbTest<Width>({
		id: 'task-width',
		label: 'Width',
		initial: INITIAL,
		options: {
			left: {
				label: 'Left, 72rem',
				hint: 'At most 72rem, against the menu: no empty band on the left of a wide screen.',
			},
			centered: {
				label: 'Centered, 72rem (today)',
				hint: 'The shell column as it is today: 72rem, centred in the area right of the menu.',
			},
			full: { label: 'Full width', hint: 'The whole area right of the menu; long lines on a wide screen.' },
			reading: {
				label: 'Reading, 56rem',
				hint: 'A narrower reading column against the menu; a side column of a design gets less room.',
			},
		},
	});
	useRegisterAbTests([test]);
	const width = enabled ? test.value : INITIAL;
	return (
		<div
			data-testid="width-frame"
			data-width={width}
			className={`w-full min-w-0 [overflow-wrap:anywhere] ${WIDTH_CLASSES[width]}`}
		>
			{items}
		</div>
	);
}
