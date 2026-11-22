// `--attach <file>[#alt]`: reads the image files of a comment. The service stays pure (it receives bytes); the files are read here,
// and every problem is found BEFORE any request: a missing file, an empty one, one over the size cap, a name that is not an image.
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	ATTACHMENT_EXTENSIONS_TEXT,
	ATTACHMENT_MAX_BYTES,
	ATTACHMENT_MAX_COUNT,
	imageMimeOf,
	checkAttachments,
} from '@wadeck-app/task-core';
import type { CommentAttachment } from '@wadeck-app/task-core';

/** Splits `file#alt`: the whole word is the file when such a file exists (a `#` in a name), else the text after the first `#` is the alt. */
function splitSpec(spec: string): { file: string; alt: string | undefined } {
	if (fs.existsSync(spec)) return { file: spec, alt: undefined };
	const hash = spec.indexOf('#');
	if (hash < 0) return { file: spec, alt: undefined };
	const alt = spec.slice(hash + 1).trim();
	return { file: spec.slice(0, hash), alt: alt === '' ? undefined : alt };
}

/**
 * Reads the `--attach` values into attachments (name = base name of the file, mime type from its extension). Throws an Error whose
 * message names the file and the fix; the count, size, extension and name rules are the ones of task-core (checkAttachments).
 */
export function readAttachments(specs: readonly string[]): CommentAttachment[] {
	if (specs.length > ATTACHMENT_MAX_COUNT) {
		throw new Error(
			`at most ${ATTACHMENT_MAX_COUNT} --attach per comment (${specs.length} given): put the others in another comment`
		);
	}
	const attachments: CommentAttachment[] = [];
	for (const spec of specs) {
		const { file, alt } = splitSpec(spec);
		const name = path.basename(file);
		const mimeType = imageMimeOf(name);
		if (mimeType === undefined) {
			throw new Error(
				`--attach ${file}: not an image task can attach (accepted extensions: ${ATTACHMENT_EXTENSIONS_TEXT})`
			);
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch (error) {
			throw new Error(
				`--attach ${file}: cannot read the file (${(error as NodeJS.ErrnoException).code ?? 'error'}); check the path (relative to ${process.cwd()}). A file name containing # cannot be followed by an alt text.`
			);
		}
		if (!stat.isFile()) throw new Error(`--attach ${file}: not a file`);
		if (stat.size === 0) throw new Error(`--attach ${file}: the file is empty (0 bytes); save the image again`);
		if (stat.size > ATTACHMENT_MAX_BYTES) {
			throw new Error(
				`--attach ${file}: ${(stat.size / (1024 * 1024)).toFixed(1)} MB; an image is at most ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB: reduce it (smaller screenshot, higher compression)`
			);
		}
		const bytes = new Uint8Array(fs.readFileSync(file));
		attachments.push({ name, mimeType, bytes, ...(alt === undefined ? {} : { alt }) });
	}
	checkAttachments(attachments);
	return attachments;
}
