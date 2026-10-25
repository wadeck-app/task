// The key of a label: base64url (no padding) of its UTF-8 bytes. A label may hold "/" or "%", which a URL path cannot
// carry through app-core (404), so the page removes a label by key (DELETE /tasks/:id/label-keys/:key).
import { RequestError } from './errors.js';

const KEY_USAGE =
	'Use DELETE /tasks/<id>/label-keys/<key>, <key> being the base64url (no padding) of the label in UTF-8, as given in "labelKeys" by GET /tasks/<id>. To remove by name use DELETE /tasks/<id>/labels/<label>.';

export function labelKey(label: string): string {
	return Buffer.from(label, 'utf8').toString('base64url');
}

/** The label of a key; anything that is not the canonical key of a UTF-8 text is a 400 with the expected format. */
export function labelFromKey(key: string): string {
	const refuse = (why: string): never => {
		throw new RequestError(400, `invalid label key "${key}": ${why}`, KEY_USAGE);
	};
	if (!/^[A-Za-z0-9_-]+$/.test(key)) {
		return refuse('only A-Z a-z 0-9 - _ are allowed (base64url, no "=" padding), and it must not be empty');
	}
	const bytes = Buffer.from(key, 'base64url');
	if (bytes.toString('base64url') !== key) {
		return refuse('not a canonical base64url value');
	}
	let label: string;
	try {
		label = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return refuse('the decoded bytes are not valid UTF-8');
	}
	if (label.trim() === '') {
		return refuse('the decoded label is blank');
	}
	return label;
}
