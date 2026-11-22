import {
	ATTACHMENT_MAX_BYTES,
	ATTACHMENT_MAX_COUNT,
	PLACEHOLDER_ATTACHMENT_URL,
	altOf,
	checkAttachments,
	composeCommentBody,
	imageMimeOf,
} from './commentAttachments.js';
import type { CommentAttachment, UploadedAttachment } from './commentAttachments.js';
import { COMMENT_TEXT_MAX, InvalidCommentTextError } from './taskComments.js';

const png = (name = 'shot.png', bytes = 3, alt?: string): CommentAttachment => ({
	name,
	mimeType: imageMimeOf(name) ?? 'image/png',
	bytes: new Uint8Array(bytes).fill(1),
	...(alt === undefined ? {} : { alt }),
});

const uploaded = (name: string, alt = name, n = 1): UploadedAttachment => ({
	name,
	alt,
	url: `https://github.com/user-attachments/assets/${String(n).padStart(8, '0')}`,
});

function refusal(action: () => unknown): InvalidCommentTextError {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(InvalidCommentTextError);
		return error as InvalidCommentTextError;
	}
	throw new Error('expected a refusal');
}

describe('imageMimeOf', () => {
	it.each([
		['a.png', 'image/png'],
		['A.PNG', 'image/png'],
		['a.jpg', 'image/jpeg'],
		['a.jpeg', 'image/jpeg'],
		['a.gif', 'image/gif'],
		['a.webp', 'image/webp'],
	])('%s is %s', (name, mime) => {
		expect(imageMimeOf(name)).toBe(mime);
	});

	it.each(['a.svg', 'a.bmp', 'a.txt', 'png', 'a.png.exe'])('%s is not an image task attaches', name => {
		expect(imageMimeOf(name)).toBeUndefined();
	});
});

describe('checkAttachments', () => {
	it('accepts a list within the rules', () => {
		expect(() => checkAttachments([png('a.png'), png('b.jpg'), png('c.gif'), png('d.webp')])).not.toThrow();
		expect(() => checkAttachments([])).not.toThrow();
	});

	it('refuses an empty file, naming it and the fix', () => {
		const error = refusal(() => checkAttachments([png('empty.png', 0)]));
		expect(error.message).toContain('"empty.png" is empty');
		expect(error.hint).toContain('empty.png');
	});

	it('refuses a file over the cap, stating the cap', () => {
		const error = refusal(() => checkAttachments([png('big.png', ATTACHMENT_MAX_BYTES + 1)]));
		expect(error.message).toContain('"big.png"');
		expect(error.message).toContain('at most 10.0 MB');
		expect(error.hint).toContain('Reduce');
	});

	it('accepts a file of exactly the cap', () => {
		expect(() => checkAttachments([png('edge.png', ATTACHMENT_MAX_BYTES)])).not.toThrow();
	});

	it('refuses an extension that is not an image and lists the accepted ones', () => {
		const error = refusal(() =>
			checkAttachments([{ name: 'notes.txt', mimeType: 'text/plain', bytes: new Uint8Array([1]) }])
		);
		expect(error.message).toContain('"notes.txt"');
		expect(error.message).toContain('.png, .jpg, .jpeg, .gif, .webp');
	});

	it('refuses a mime type that does not match the extension', () => {
		const error = refusal(() =>
			checkAttachments([{ name: 'a.png', mimeType: 'image/gif', bytes: new Uint8Array([1]) }])
		);
		expect(error.message).toContain('does not match');
	});

	it('refuses more than the maximum count', () => {
		const many = Array.from({ length: ATTACHMENT_MAX_COUNT + 1 }, (_, i) => png(`n${i}.png`));
		const error = refusal(() => checkAttachments(many));
		expect(error.message).toContain(`at most ${ATTACHMENT_MAX_COUNT}`);
		expect(() => checkAttachments(many.slice(0, ATTACHMENT_MAX_COUNT))).not.toThrow();
	});

	it('refuses two attachments with the same name (a reference could not tell them apart)', () => {
		const error = refusal(() => checkAttachments([png('a.png'), png('A.png')]));
		expect(error.message).toContain('two attachments are named');
		expect(error.hint).toContain('Rename');
	});
});

describe('altOf', () => {
	it('is the given alt, else the file name, and cannot break the markdown', () => {
		expect(altOf({ name: 'a.png' })).toBe('a.png');
		expect(altOf({ name: 'a.png', alt: '  ' })).toBe('a.png');
		expect(altOf({ name: 'a.png', alt: 'the [login] page\nbroken' })).toBe('the (login) page broken');
	});
});

describe('composeCommentBody', () => {
	it('appends an unreferenced image after the text, on its own line', () => {
		expect(composeCommentBody('see this', [uploaded('shot.png')])).toBe(
			'see this\n\n![shot.png](https://github.com/user-attachments/assets/00000001)'
		);
	});

	it('appends several images one per line, in order', () => {
		const body = composeCommentBody('t', [uploaded('a.png', 'first', 1), uploaded('b.png', 'second', 2)]);
		expect(body.split('\n')).toEqual([
			't',
			'',
			'![first](https://github.com/user-attachments/assets/00000001)',
			'![second](https://github.com/user-attachments/assets/00000002)',
		]);
	});

	it('replaces a reference to the file name, whatever its relative path, keeping the alt written in the text', () => {
		const body = composeCommentBody(
			'before ![the login](./shots/shot.png) and ![](shot.png) and ![x](../up/Shot.PNG) after',
			[uploaded('shot.png', 'default alt')]
		);
		expect(body).toBe(
			'before ![the login](https://github.com/user-attachments/assets/00000001) and ![default alt](https://github.com/user-attachments/assets/00000001) and ![x](https://github.com/user-attachments/assets/00000001) after'
		);
	});

	it('does not append an image the text referenced, and appends only the others', () => {
		const body = composeCommentBody('![a](./a.png)', [uploaded('a.png', 'a', 1), uploaded('b.png', 'b', 2)]);
		expect(body).toBe(
			'![a](https://github.com/user-attachments/assets/00000001)\n\n![b](https://github.com/user-attachments/assets/00000002)'
		);
	});

	it('leaves a reference to another file, and a link that is not an image, alone', () => {
		const body = composeCommentBody('![x](./other.png) [shot.png](./shot.png)', [uploaded('shot.png')]);
		expect(body.startsWith('![x](./other.png) [shot.png](./shot.png)\n\n![shot.png](')).toBe(true);
	});

	it('does not match a longer file name that merely ends with the name', () => {
		const body = composeCommentBody('![x](./big-shot.png)', [uploaded('shot.png')]);
		expect(body.startsWith('![x](./big-shot.png)\n\n![shot.png](')).toBe(true);
	});

	it('allows a blank text when an image is attached, and refuses it without one', () => {
		expect(composeCommentBody('   ', [uploaded('a.png')])).toBe(
			'![a.png](https://github.com/user-attachments/assets/00000001)'
		);
		expect(refusal(() => composeCommentBody('  ', [])).message).toContain('cannot be blank');
	});

	it('checks the length of the FINAL body, naming how much to cut, before anything is uploaded', () => {
		const placeholders = [png('a.png'), png('b.png')].map(item => ({
			name: item.name,
			alt: altOf(item),
			url: PLACEHOLDER_ATTACHMENT_URL,
		}));
		const text = 'x'.repeat(COMMENT_TEXT_MAX - 10);
		const error = refusal(() => composeCommentBody(text, placeholders));
		expect(error.message).toContain('with the image markdown of its 2 attachment(s)');
		expect(error.hint).toContain('Nothing was uploaded');
		// Without images the same text fits.
		expect(composeCommentBody(text, [])).toBe(text);
	});

	it('the placeholder is as long as a real address (the pre-check is exact)', () => {
		expect(PLACEHOLDER_ATTACHMENT_URL).toHaveLength(
			'https://github.com/user-attachments/assets/b37b88c0-08c9-4e84-b717-7d6c2bddba73'.length
		);
	});
});
