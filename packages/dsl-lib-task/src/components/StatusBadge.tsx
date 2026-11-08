import { Ban, CheckCircle2, Circle, CircleDot } from 'lucide-react';
import React from 'react';
import { CONTROL_H, GAP_CONTROLS, ICON_SIZE, PILL_RADIUS, PILL_TEXT } from '../ui/tokens.js';
import { TONE_DOT, TONE_PILL, TONE_TEXT, toneOf } from '../tones.js';
import type { Tone } from '../tones.js';

export type StatusIcon = 'open' | 'progress' | 'done' | 'blocked' | 'none';

export interface StatusBadgeProps {
	/** The status text, e.g. `in-progress`. It stays the accessible name when only the icon is drawn. */
	label: string;
	/** Colour family. An unknown value is drawn as `neutral`. */
	tone?: Tone;
	/** Glyph before the label: an open circle, a half-done circle, a check, a ban. */
	icon?: StatusIcon;
	/** `control`: the height, radius and text of a pill or a button (h-8), for a badge that sits in a row with controls. */
	size?: 'sm' | 'md' | 'control';
	/** Monospace label (an id). */
	mono?: boolean;
	/** `pill`: tinted capsule. `dot`: bare coloured dot and text. `icon`: the glyph alone (the label becomes its tooltip). */
	appearance?: 'pill' | 'dot' | 'icon';
}

const ICONS = { open: Circle, progress: CircleDot, done: CheckCircle2, blocked: Ban } as const;

// @formatter:off
const PILL_SIZE: Record<NonNullable<StatusBadgeProps['size']>, string> = {
	sm: 'px-2 py-0.5 text-xs gap-1',
	md: 'px-2.5 py-1 text-sm gap-1.5',
	control: `${CONTROL_H} px-3 ${PILL_TEXT} ${GAP_CONTROLS}`,
};
const TEXT_SIZE: Record<NonNullable<StatusBadgeProps['size']>, string> = {
	sm: 'text-xs gap-1.5',
	md: 'text-sm gap-2',
	control: `${PILL_TEXT} ${GAP_CONTROLS}`,
};
// @formatter:on

/**
 * The generic status chip: a pill, a dot or a glyph, coloured by tone.
 *
 * IN SCOPE: showing one status value. OUT OF SCOPE: changing it (see ActionSelect).
 *
 * @registryCategory atomic
 * @registryTags status badge pill lozenge
 */
export function StatusBadge({
	label,
	tone = 'neutral',
	icon = 'none',
	size = 'sm',
	mono = false,
	appearance = 'pill',
}: StatusBadgeProps): React.ReactElement {
	const resolved = toneOf(tone);
	const Glyph = icon === 'none' ? null : ICONS[icon];
	const glyphSize = size === 'sm' ? 12 : ICON_SIZE;

	if (appearance === 'icon') {
		return (
			<span
				data-testid="status-badge"
				data-tone={resolved}
				role="img"
				aria-label={label}
				title={label}
				className={`inline-flex items-center ${TONE_TEXT[resolved]}`}
			>
				{Glyph ? (
					<Glyph size={glyphSize + 2} aria-hidden="true" />
				) : (
					<Circle size={glyphSize + 2} aria-hidden="true" />
				)}
			</span>
		);
	}
	if (appearance === 'dot') {
		return (
			<span
				data-testid="status-badge"
				data-tone={resolved}
				className={`inline-flex items-center text-content ${TEXT_SIZE[size]}`}
			>
				{Glyph ? (
					<Glyph size={glyphSize} aria-hidden="true" className={TONE_TEXT[resolved]} />
				) : (
					<span
						data-testid="status-badge-dot"
						aria-hidden="true"
						className={`inline-block h-2 w-2 shrink-0 rounded-full ${TONE_DOT[resolved]}`}
					/>
				)}
				<span>{label}</span>
			</span>
		);
	}
	return (
		<span
			data-testid="status-badge"
			data-tone={resolved}
			className={`inline-flex items-center whitespace-nowrap ${PILL_RADIUS} ${size === 'control' ? '' : 'font-medium'} ${PILL_SIZE[size]} ${TONE_PILL[resolved]}`}
		>
			{Glyph ? <Glyph size={glyphSize} aria-hidden="true" /> : null}
			<span className={mono ? 'font-mono' : ''}>{label}</span>
		</span>
	);
}
