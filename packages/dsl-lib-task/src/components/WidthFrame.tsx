import { ChevronsLeftRight, ChevronsRightLeft } from 'lucide-react';
import React from 'react';
import { ICON_BUTTON_CLASS, ICON_SIZE } from '../ui/tokens.js';

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

/** localStorage key of the reader's choice: only `full` is ever stored (the design's own width is the absence of a value). */
const FULL_WIDTH_STORAGE_KEY = 'task.page.width';

function readFullWidthChoice(): boolean {
	try {
		return window.localStorage.getItem(FULL_WIDTH_STORAGE_KEY) === 'full';
	} catch (error) {
		console.warn(
			`[WidthFrame] the width choice cannot be read from the browser storage: ${(error as Error).message}`
		);
		return false;
	}
}

function saveFullWidthChoice(full: boolean): void {
	try {
		if (full) window.localStorage.setItem(FULL_WIDTH_STORAGE_KEY, 'full');
		else window.localStorage.removeItem(FULL_WIDTH_STORAGE_KEY);
	} catch (error) {
		console.warn(
			`[WidthFrame] the width choice cannot be saved in the browser storage: ${(error as Error).message}`
		);
	}
}

export interface WidthFrameProps {
	/** `left`: 72rem against the menu (default). `wide`: 80rem. `centered`: 72rem centred. `full`: the whole area. `reading`: 56rem. */
	width?: Width;
	/** Adds a button at the end of the frame that switches between the width of the design and `full`; the choice is remembered in the browser. */
	expandable?: boolean;
	/** The page content. @slot tag:layout, tag:table, tag:form, tag:display, tag:composite, tag:atomic */
	items: React.ReactNode;
}

/**
 * The width of a page design: a frame that caps and aligns its content and makes every text break inside it.
 *
 * The page sits in a dsl-ui `PageContent` with `maxWidth: full`; the default PageContent (72rem, centred) would cap every
 * design at the same width. A design wraps its view in this frame with the width it was drawn for.
 *
 * IN SCOPE: capping and aligning the width of a page, an optional reader's switch to the full width. OUT OF SCOPE: columns
 * (use SplitLayout), padding, breakpoints, experiments (the width is fixed per design).
 *
 * @registryCategory disposition
 * @registryTags layout width page frame
 */
export function WidthFrame({ width = 'left', expandable = false, items }: WidthFrameProps): React.ReactElement {
	const designWidth: Width = width in WIDTH_CLASSES ? width : 'left';
	const [full, setFull] = React.useState<boolean>(() => expandable && readFullWidthChoice());
	const chosen: Width = expandable && full ? 'full' : designWidth;
	const label = full ? 'Use the standard width' : 'Use the full width';
	const Icon = full ? ChevronsRightLeft : ChevronsLeftRight;

	const toggle = (): void => {
		const next = !full;
		setFull(next);
		saveFullWidthChoice(next);
	};

	return (
		<div
			data-testid="width-frame"
			data-width={chosen}
			className={`w-full min-w-0 [overflow-wrap:anywhere] ${WIDTH_CLASSES[chosen]}`}
		>
			{expandable ? (
				<div className="mb-2 flex justify-end">
					<button
						type="button"
						className={ICON_BUTTON_CLASS}
						aria-label={label}
						aria-pressed={full}
						title={label}
						onClick={toggle}
					>
						<Icon size={ICON_SIZE} aria-hidden="true" />
					</button>
				</div>
			) : null}
			{items}
		</div>
	);
}
