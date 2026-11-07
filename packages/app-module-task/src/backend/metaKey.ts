// The key of a metadata key: base64url (no padding) of its UTF-8 bytes (see pathKey.ts). A metadata key may hold "/" or "%",
// which a URL path cannot carry through app-core (404), so the page sets and removes it through /tasks/:id/meta-keys/:key.
import { decodePathKey, encodePathKey } from './pathKey.js';

const KEY_USAGE =
	'Use PUT or DELETE /tasks/<id>/meta-keys/<key>, <key> being the base64url (no padding) of the metadata key in UTF-8, as given as "keyId" in "metaEntries" by GET /tasks/<id>. To address it by name use /tasks/<id>/meta/<key>.';

export function metaKey(key: string): string {
	return encodePathKey(key);
}

/** The metadata key of a path key; anything that is not the canonical key of a UTF-8 text is a 400 with the expected format. */
export function metaKeyFromKey(key: string): string {
	return decodePathKey(key, 'metadata key', KEY_USAGE);
}
