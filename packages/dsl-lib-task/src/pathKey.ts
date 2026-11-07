/**
 * base64url (no padding) of the UTF-8 bytes of a text: the key the task module computes for a label or a metadata key.
 * A text with "/" or "%" cannot travel in a url path; its key can.
 */
export function pathKeyOf(text: string): string {
	let binary = '';
	for (const byte of new TextEncoder().encode(text)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
