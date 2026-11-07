import React, { useState } from 'react';

type Size = 'sm' | 'md' | 'lg' | 'xl' | '2xl';

// @formatter:off
const SIZE_CLASSES: Record<Size, string> = {
	sm: 'text-sm font-normal',
	md: 'text-base font-semibold',
	lg: 'text-lg font-semibold',
	xl: 'text-xl font-semibold',
	'2xl': 'text-2xl font-semibold',
};
// Static class names: Tailwind only keeps the ones it can read in the source.
const CLAMP_CLASSES: Record<number, string> = {
	1: 'line-clamp-1',
	2: 'line-clamp-2',
	3: 'line-clamp-3',
	4: 'line-clamp-4',
};
// @formatter:on

// A line of the page holds roughly this many characters; a text shorter than lines x this never needs "Show more".
const CHARS_PER_LINE = 70;

export interface TitleTextProps {
	/** The text: a task title, which for a task created by a flow is its whole description. */
	text: string;
	/** `2xl` is the size of the page headers; the default `xl` suits a title that can be long. */
	size?: Size;
	/** Clamp to this many lines (1 to 4) behind an ellipsis; 0 shows everything. */
	lines?: 0 | 1 | 2 | 3 | 4;
	/** While clamped, the whole text is the tooltip of the heading. */
	tooltip?: boolean;
	/** While clamped and long, a "Show more" button unfolds the whole text (and "Show less" folds it back). */
	expandable?: boolean;
}

/**
 * The title of a page: a heading that stays readable whatever it holds. dsl-ui `PageHeader` prints the title whole, so a
 * 600-character description fills eight lines, and one unbroken word runs out of its column.
 *
 * IN SCOPE: a heading (or a block of plain text, `size: sm`) clamped to a few lines, wrapped at any character, with the
 * full text on demand. OUT OF SCOPE: markdown, links, actions beside the title (compose those around it).
 *
 * @registryCategory atomic
 * @registryTags title heading text clamp truncate long
 */
export function TitleText({
	text,
	size = 'xl',
	lines = 2,
	tooltip = false,
	expandable = false,
}: TitleTextProps): React.ReactElement | null {
	const [expanded, setExpanded] = useState(false);
	if (!text) {
		return null;
	}
	const Tag = size === 'sm' ? 'p' : 'h1';
	const clamped = lines > 0 && !expanded;
	const needsToggle = expandable && lines > 0 && text.length > lines * CHARS_PER_LINE;
	const className = [
		'm-0 min-w-0 break-words [overflow-wrap:anywhere] text-content',
		SIZE_CLASSES[size],
		'leading-snug',
		clamped ? CLAMP_CLASSES[lines] : '',
	]
		.filter(Boolean)
		.join(' ');
	return (
		<div className="min-w-0">
			<Tag className={className} title={tooltip && lines > 0 ? text.trim() : undefined}>
				{text}
			</Tag>
			{needsToggle ? (
				<button
					type="button"
					aria-expanded={expanded}
					className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-muted underline"
					onClick={() => setExpanded(value => !value)}
				>
					{expanded ? 'Show less' : 'Show more'}
				</button>
			) : null}
		</div>
	);
}
