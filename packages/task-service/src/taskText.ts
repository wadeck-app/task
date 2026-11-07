// Title / body text rules shared by the CLI, the app-module and the flows (one place, no adapter has its own copy).

/** A text longer than this is split into a headline (the stored title) and a body at creation. */
export const HEADLINE_MAX_LENGTH = 90;

export interface SplitText {
	/** The headline: the whole text when it is short. */
	title: string;
	/** The full original text; absent when the text is short (nothing to add to the title). */
	description?: string;
}

/**
 * Headline of a text of any length, at most {@link HEADLINE_MAX_LENGTH} characters:
 * 1. a text of up to 90 characters is its own headline, unchanged;
 * 2. else the first non-empty line, if it fits;
 * 3. else the first sentence of that line (up to `.`, `!` or `?` followed by a space or the end), if it fits;
 * 4. else the line cut at a word boundary, ending with an ellipsis (a single word longer than that is cut hard).
 */
export function headlineOf(text: string): string {
	if (text.length <= HEADLINE_MAX_LENGTH) {
		return text;
	}
	const line =
		text
			.split(/\r?\n/)
			.find(candidate => candidate.trim() !== '')
			?.trim() ?? '';
	if (line.length <= HEADLINE_MAX_LENGTH) {
		return line;
	}
	const sentence = /^.+?[.!?](?=\s|$)/.exec(line)?.[0];
	if (sentence !== undefined && sentence.length <= HEADLINE_MAX_LENGTH) {
		return sentence;
	}
	// One slot is kept for the ellipsis.
	const room = HEADLINE_MAX_LENGTH - 1;
	const wordIsComplete = /\s/.test(line[room] ?? '');
	const lastSpace = line.slice(0, room).search(/\s\S*$/);
	const cut = wordIsComplete || lastSpace <= 0 ? room : lastSpace;
	return `${line
		.slice(0, cut)
		.trimEnd()
		.replace(/[,;:]+$/, '')}…`;
}

/** Splits one text into the title to store and, when it adds information, the description holding the full text. */
export function splitHeadline(text: string): SplitText {
	const title = headlineOf(text);
	return title === text ? { title } : { title, description: text };
}

/** The description of a task: its stored one, else its title (old files hold the title twice, new ones only when it differs). */
export function taskDescription(task: { title: string; description?: string }): string {
	return task.description ?? task.title;
}

/** True when the body says more than the headline (false for the same text, whitespace around it aside, or for no body). */
export function bodyAddsInfo(headline: string, body: string | undefined): boolean {
	return body !== undefined && body.trim() !== headline.trim();
}
