// Display text of values the views cannot format themselves (the DSL table ignores column formats and widths).

/** The longest title shown in a table cell; the whole title is on the detail page. */
const MAX_TITLE_CHARS = 90;
const ELLIPSIS = '\u2026';

/** `title`, cut with an ellipsis when it would make a table row unreadable. */
export function shortTitle(title: string, max = MAX_TITLE_CHARS): string {
	return title.length <= max ? title : `${title.slice(0, max - 1).trimEnd()}${ELLIPSIS}`;
}

/** "2026-10-19 19:37": an ISO timestamp as UTC date and minute; a value that is not a timestamp is returned as is. */
export function shortUtcTime(iso: string): string {
	const match = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)/.exec(iso);
	return match === null ? iso : `${match[1]} ${match[2]}`;
}
