// Images attached to a comment: the rules every adapter and backend shares (extensions, size, count) and the one place that decides how
// the markdown of the final comment is composed. Pure: no file, no network. Reading the files is the adapter's job (task-cli); storing
// them is the backend's (github: a user-attachments asset). task never commits or copies a file anywhere.
import { COMMENT_TEXT_MAX, InvalidCommentTextError } from './taskComments.js';

/** One image to attach: the bytes are already read, the name is the base name of the file. */
export interface CommentAttachment {
	/** Base name of the file (`shot.png`): what a `![alt](./shot.png)` reference of the text is matched against. */
	name: string;
	/** `image/png`, `image/jpeg`, `image/gif` or `image/webp`. */
	mimeType: string;
	bytes: Uint8Array;
	/** The alternative text of the image; the file name when absent. */
	alt?: string;
}

/** What a backend stored for one attachment. */
export interface UploadedAttachment {
	name: string;
	alt: string;
	/** Where the image lives (github: `https://github.com/user-attachments/assets/<uuid>`). */
	url: string;
}

/** An image is at most this many bytes. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** A comment carries at most this many attachments. */
export const ATTACHMENT_MAX_COUNT = 10;

/** The accepted extensions (lower case, with the dot) and the mime type each one is uploaded as. */
export const ATTACHMENT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
});

/** The accepted extensions as a sentence fragment: `.png, .jpg, .jpeg, .gif, .webp`. */
export const ATTACHMENT_EXTENSIONS_TEXT = Object.keys(ATTACHMENT_MIME_BY_EXTENSION).join(', ');

/** The mime type of an image file name by its extension, undefined for any other extension. */
export function imageMimeOf(fileName: string): string | undefined {
	const dot = fileName.lastIndexOf('.');
	if (dot < 0) return undefined;
	return ATTACHMENT_MIME_BY_EXTENSION[fileName.slice(dot).toLowerCase()];
}

const mebibytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Refuses a list of attachments that the rules do not allow, before any request: too many, an empty file, a file over the size cap, an
 * extension that is not an image, a mime type that does not match the extension, two files with the same name (a reference in the text
 * could not tell them apart). Every message names the file and the fix. Throws InvalidCommentTextError.
 */
export function checkAttachments(attachments: readonly CommentAttachment[]): void {
	if (attachments.length > ATTACHMENT_MAX_COUNT) {
		throw new InvalidCommentTextError(
			`a comment carries at most ${ATTACHMENT_MAX_COUNT} attachments (${attachments.length} given)`,
			`Attach ${ATTACHMENT_MAX_COUNT} images or fewer, and put the others in another comment.`
		);
	}
	const seen = new Set<string>();
	for (const attachment of attachments) {
		const name = attachment.name;
		const expected = imageMimeOf(name);
		if (expected === undefined) {
			throw new InvalidCommentTextError(
				`"${name}" is not an image task can attach (accepted extensions: ${ATTACHMENT_EXTENSIONS_TEXT})`,
				`Attach a ${ATTACHMENT_EXTENSIONS_TEXT} file, or convert "${name}" to one of them.`
			);
		}
		if (attachment.mimeType !== expected) {
			throw new InvalidCommentTextError(
				`the mime type ${attachment.mimeType} of "${name}" does not match its extension (${expected})`,
				'Let the caller derive the mime type from the file name (imageMimeOf).'
			);
		}
		if (attachment.bytes.byteLength === 0) {
			throw new InvalidCommentTextError(
				`"${name}" is empty (0 bytes)`,
				`Check that "${name}" was saved completely, then attach it again.`
			);
		}
		if (attachment.bytes.byteLength > ATTACHMENT_MAX_BYTES) {
			throw new InvalidCommentTextError(
				`"${name}" is ${mebibytes(attachment.bytes.byteLength)}; an image is at most ${mebibytes(ATTACHMENT_MAX_BYTES)}`,
				`Reduce "${name}" (smaller screenshot, higher compression) to ${mebibytes(ATTACHMENT_MAX_BYTES)} or less.`
			);
		}
		const key = name.toLowerCase();
		if (seen.has(key)) {
			throw new InvalidCommentTextError(
				`two attachments are named "${name}"`,
				'Rename one of the files: the text refers to an attachment by its file name.'
			);
		}
		seen.add(key);
	}
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An alternative text that cannot break the markdown image syntax: one line, no bracket. */
function cleanAlt(alt: string): string {
	return alt.replace(/\s+/g, ' ').replace(/\[/g, '(').replace(/\]/g, ')').trim();
}

/** The alternative text of an attachment: its own, or the file name. */
export function altOf(attachment: Pick<CommentAttachment, 'name' | 'alt'>): string {
	const alt = cleanAlt(attachment.alt ?? '');
	return alt === '' ? cleanAlt(attachment.name) : alt;
}

/** The URL an upload answers is `https://github.com/user-attachments/assets/` + a 36 character id: used to measure the body before any upload. */
export const PLACEHOLDER_ATTACHMENT_URL = `https://github.com/user-attachments/assets/${'0'.repeat(36)}`;

/**
 * The markdown body of a comment with its attachments:
 * - `![alt](./shot.png)` (any relative path, the last segment is the file name) in the text is replaced by the uploaded URL, keeping
 *   the alternative text written there (the attachment's own when that one is empty);
 * - an attachment the text does not reference is appended after the text, each as `![alt](url)` on its own line;
 * - a blank text is allowed when there is at least one attachment.
 * The result is checked against the 10000 characters of a comment (InvalidCommentTextError names the sizes).
 */
export function composeCommentBody(text: string, uploaded: readonly UploadedAttachment[]): string {
	let body = text.trim();
	const appended: string[] = [];
	for (const item of uploaded) {
		const reference = new RegExp(
			`!\\[([^\\]\\n]*)\\]\\(\\s*(?:<)?(?:[^)\\s<>]*[/\\\\])?${escapeRegExp(item.name)}(?:>)?\\s*\\)`,
			'gi'
		);
		let referenced = false;
		body = body.replace(reference, (_match, written: string) => {
			referenced = true;
			const alt = cleanAlt(written) === '' ? item.alt : cleanAlt(written);
			return `![${alt}](${item.url})`;
		});
		if (!referenced) appended.push(`![${item.alt}](${item.url})`);
	}
	if (appended.length > 0) body = body === '' ? appended.join('\n') : `${body}\n\n${appended.join('\n')}`;
	if (body === '') {
		throw new InvalidCommentTextError('a comment cannot be blank', 'Give the text of the comment, or attach an image.');
	}
	if (body.length > COMMENT_TEXT_MAX) {
		throw new InvalidCommentTextError(
			`a comment is at most ${COMMENT_TEXT_MAX} characters; this one has ${body.length} with the image markdown of its ${uploaded.length} attachment(s)`,
			`Shorten the text by ${body.length - COMMENT_TEXT_MAX} characters or more, or attach fewer images. Nothing was uploaded.`
		);
	}
	return body;
}
