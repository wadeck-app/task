import React, { useState } from 'react';
import { TONE_PILL, toneOf } from '../tones.js';
import type { Tone } from '../tones.js';

export interface NoticeProps {
	/** The message. Named like dsl-ui `Badge.label` so a view can swap one for the other. */
	label: string;
	/** `info`, `warning` or `danger` (the names of dsl-ui Badge); `success` and `neutral` also work. */
	variant?: 'info' | 'warning' | 'danger' | 'success' | 'neutral';
}

// Above this many characters the message is clamped to three lines behind a "Show more" button.
const LONG_MESSAGE = 140;

/**
 * A short message that WRAPS: the feedback of an action ("change saved but 1 event was not delivered") in a narrow
 * column, where dsl-ui `Badge` keeps one line and overflows. A long message (a replay command, say) is clamped to
 * three lines and can be expanded: nothing is cut for good.
 *
 * IN SCOPE: a sentence or two. OUT OF SCOPE: actions, dismissal, rich content.
 *
 * @registryCategory atomic
 * @registryTags notice message feedback alert
 */
export function Notice({ label, variant = 'info' }: NoticeProps): React.ReactElement | null {
	const [expanded, setExpanded] = useState(false);
	if (!label) {
		return null;
	}
	const tone: Tone = toneOf(variant);
	const isLong = label.length > LONG_MESSAGE;
	return (
		<div
			role={variant === 'danger' ? 'alert' : 'status'}
			className={`min-w-0 break-words rounded-md px-2.5 py-1.5 text-xs leading-snug ${TONE_PILL[tone]}`}
		>
			<p className={`m-0 ${isLong && !expanded ? 'line-clamp-3' : ''}`}>{label}</p>
			{isLong ? (
				// The button repeats the colour of the text: a link-like control inside a tinted box.
				<button
					type="button"
					className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-xs font-medium underline"
					onClick={() => setExpanded(value => !value)}
				>
					{expanded ? 'Show less' : 'Show more'}
				</button>
			) : null}
		</div>
	);
}
