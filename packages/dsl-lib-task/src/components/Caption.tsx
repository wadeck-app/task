import React from 'react';
import { CONTROL_H } from '../ui/tokens.js';

export interface CaptionProps {
	/** The text. */
	text: string;
	/** `muted` (default) or `default` (the content colour). */
	tone?: 'muted' | 'default';
	/** The monospace font (an id, a path). */
	mono?: boolean;
}

/**
 * A line of plain text that lines up with the pills of a ChipRow: the height of a control, centered, long words
 * wrapped instead of overflowing.
 *
 * IN SCOPE: one short text. OUT OF SCOPE: rich content, links, actions.
 *
 * @registryCategory atomic
 * @registryTags caption text label muted
 */
export function Caption({ text, tone = 'muted', mono = false }: CaptionProps): React.ReactElement {
	return (
		<span
			className={`inline-flex ${CONTROL_H} min-w-0 items-center break-words text-sm ${tone === 'default' ? 'text-content' : 'text-muted'}${mono ? ' font-mono' : ''}`}
		>
			{typeof text === 'string' ? text : ''}
		</span>
	);
}
