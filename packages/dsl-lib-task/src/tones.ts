export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'purple';

// @formatter:off
/** Tinted pill: background and text of a tone. Literal strings: the stylesheet scan is static. */
export const TONE_PILL: Record<Tone, string> = {
	neutral: 'bg-muted-bg text-muted',
	info: 'bg-info-bg text-info-text',
	success: 'bg-success-bg text-success-text',
	warning: 'bg-warning-bg text-warning-text',
	danger: 'bg-danger-bg text-danger-text',
	purple: 'bg-primary-light text-primary',
};

/** Solid dot colour of a tone. */
export const TONE_DOT: Record<Tone, string> = {
	neutral: 'bg-muted',
	info: 'bg-info-text',
	success: 'bg-success',
	warning: 'bg-warning-text',
	danger: 'bg-danger',
	purple: 'bg-primary',
};

/** Text colour of a tone (icons). */
export const TONE_TEXT: Record<Tone, string> = {
	neutral: 'text-muted',
	info: 'text-info-text',
	success: 'text-success',
	warning: 'text-warning-text',
	danger: 'text-danger',
	purple: 'text-primary',
};

/** The six label colours, defined in styles/task.css with light and dark values. */
export const CHIP_PALETTE: readonly string[] = [
	'bg-task-chip-1-bg text-task-chip-1',
	'bg-task-chip-2-bg text-task-chip-2',
	'bg-task-chip-3-bg text-task-chip-3',
	'bg-task-chip-4-bg text-task-chip-4',
	'bg-task-chip-5-bg text-task-chip-5',
	'bg-task-chip-6-bg text-task-chip-6',
];
// @formatter:on

/** Whether a value is one of the known tones. */
export function isTone(value: unknown): value is Tone {
	return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TONE_PILL, value);
}

/** A tone from untrusted YAML: unknown or missing becomes `neutral`. */
export function toneOf(value: unknown): Tone {
	return isTone(value) ? value : 'neutral';
}

/** Stable index of a text in a palette (same text, same colour, in every session). */
export function hashIndex(text: string, size: number): number {
	let hash = 0;
	for (let i = 0; i < text.length; i++) {
		hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
	}
	return hash % size;
}
