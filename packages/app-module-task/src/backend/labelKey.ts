// The key of a label: base64url (no padding) of its UTF-8 bytes (see pathKey.ts). A label may hold "/" or "%", which a URL
// path cannot carry through app-core (404), so the page removes a label by key (DELETE /tasks/:id/label-keys/:key).
import { decodePathKey, encodePathKey } from './pathKey.js';

const KEY_USAGE =
	'Use DELETE /tasks/<id>/label-keys/<key>, <key> being the base64url (no padding) of the label in UTF-8, as given in "labelKeys" by GET /tasks/<id>. To remove by name use DELETE /tasks/<id>/labels/<label>.';

export function labelKey(label: string): string {
	return encodePathKey(label);
}

/** The label of a key; anything that is not the canonical key of a UTF-8 text is a 400 with the expected format. */
export function labelFromKey(key: string): string {
	return decodePathKey(key, 'label', KEY_USAGE);
}
