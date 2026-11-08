import * as fs from 'node:fs';

/**
 * The text of `--description-file <source>`: the file at that path, or standard input for `-`. Trailing whitespace (the
 * final newline of a file) is dropped. A missing file or an empty text throws an Error whose message says what to fix.
 * `readStdin` is injectable for tests.
 */
export function readTextSource(
	source: string,
	readStdin: () => string = () => fs.readFileSync(0, 'utf8'),
	/** What the text is, for the "is empty" message. */
	what = 'description'
): string {
	let raw: string;
	try {
		raw = source === '-' ? readStdin() : fs.readFileSync(source, 'utf8');
	} catch (error) {
		throw new Error(
			`cannot read ${source === '-' ? 'standard input' : source}: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	const text = raw.trimEnd();
	if (text === '') {
		throw new Error(`${source === '-' ? 'standard input' : source} is empty: there is no ${what} to store`);
	}
	return text;
}
