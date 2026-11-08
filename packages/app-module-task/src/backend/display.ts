// Display text of values the views cannot format themselves (the DSL table ignores column formats and widths).
import { headlineOf } from '@wadeck-app/task-service';

/** The longest title shown in a table cell; the whole text is on the detail page. */
const MAX_TITLE_CHARS = 90;
const ELLIPSIS = '...';

/**
 * What a list, tree, table or picker shows of a title: its headline (task-service `headlineOf`: the first line or sentence,
 * at most 90 characters), so a title that is a whole prompt (old tasks) never becomes a cell. Cut with an ellipsis at `max`
 * when a caller needs less than 90 characters.
 */
export function shortTitle(title: string, max = MAX_TITLE_CHARS): string {
	const headline = headlineOf(title);
	return headline.length <= max ? headline : `${headline.slice(0, max - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

/** "2026-10-19 19:37": an ISO timestamp as UTC date and minute; a value that is not a timestamp is returned as is. */
export function shortUtcTime(iso: string): string {
	const match = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)/.exec(iso);
	return match === null ? iso : `${match[1]} ${match[2]}`;
}
