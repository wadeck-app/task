// Display text of values the views cannot format themselves (the DSL table ignores column formats and widths).

/** The longest title shown in a table cell; the whole title is on the detail page. */
const MAX_TITLE_CHARS = 90;
const ELLIPSIS = '\u2026';

/** `title`, cut with an ellipsis when it would make a table row unreadable. */
export function shortTitle(title: string, max = MAX_TITLE_CHARS): string {
	return title.length <= max ? title : `${title.slice(0, max - 1).trimEnd()}${ELLIPSIS}`;
}

/** The longest short title of the task page header. */
const MAX_HEADLINE_CHARS = 90;

/**
 * The headline of a task whose title is its whole description: the first line, cut after its first sentence (`.`, `!` or
 * `?` followed by a space or the end). Longer than `max` it is cut at a word boundary (an unbroken word is cut hard) and
 * ends with an ellipsis. A short single-sentence title is returned as it is.
 */
export function firstSentence(title: string, max = MAX_HEADLINE_CHARS): string {
	const line = (title.split(/\r?\n/)[0] ?? '').trim();
	const end = /[.!?](?=\s|$)/.exec(line);
	const sentence = end === null ? line : line.slice(0, end.index + 1);
	if (sentence.length <= max) {
		return sentence;
	}
	const room = sentence.slice(0, max - 1);
	const lastSpace = room.lastIndexOf(' ');
	const cut = lastSpace > 0 ? room.slice(0, lastSpace) : room;
	return `${cut.trimEnd()}${ELLIPSIS}`;
}

/** "2026-10-19 19:37": an ISO timestamp as UTC date and minute; a value that is not a timestamp is returned as is. */
export function shortUtcTime(iso: string): string {
	const match = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)/.exec(iso);
	return match === null ? iso : `${match[1]} ${match[2]}`;
}
