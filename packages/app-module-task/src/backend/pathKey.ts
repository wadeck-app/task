// The key of a free text in a URL path: base64url (no padding) of its UTF-8 bytes. A label or a metadata key may hold "/" or
// "%", which a URL path cannot carry through app-core (404), so the routes also take them as a key (see labelKey.ts, metaKey.ts).
import { RequestError } from './errors.js';

export function encodePathKey(text: string): string {
	return Buffer.from(text, 'utf8').toString('base64url');
}

/**
 * The text of a key; anything that is not the canonical key of a non-blank UTF-8 text is a 400 with the expected format.
 * `what` names the text in the messages ("label", "metadata key"), `usage` is the hint.
 */
export function decodePathKey(key: string, what: string, usage: string): string {
	const refuse = (why: string): never => {
		throw new RequestError(400, `invalid ${what} key "${key}": ${why}`, usage);
	};
	if (!/^[A-Za-z0-9_-]+$/.test(key)) {
		return refuse('only A-Z a-z 0-9 - _ are allowed (base64url, no "=" padding), and it must not be empty');
	}
	const bytes = Buffer.from(key, 'base64url');
	if (bytes.toString('base64url') !== key) {
		return refuse('not a canonical base64url value');
	}
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return refuse('the decoded bytes are not valid UTF-8');
	}
	if (text.trim() === '') {
		return refuse(`the decoded ${what} is blank`);
	}
	return text;
}
