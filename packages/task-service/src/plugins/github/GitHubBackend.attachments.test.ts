// The images of a comment on the github strategy over the fake server: the numeric repository id, one upload per image BEFORE the comment,
// the markdown of the comment, the refusals (404, 422, 429) with the file and the status named, the comment that fails after the uploads,
// and the token that appears nowhere. The upload endpoint is undocumented: the fake of it is guarded by the recorded exchange
// (githubConformance.test.ts, step "upload an image").
import {
	BackendRejectedError,
	InvalidCommentTextError,
	PartialWriteError,
	TaskNotFoundError,
	UnsupportedByBackendError,
	COMMENT_TEXT_MAX,
} from '@wadeck-app/task-core';
import type { CommentAttachment } from '@wadeck-app/task-core';

import { FakeGitHub } from './fakeGitHub.testkit.js';
import { WRITE_STATUS_MAP, WRITE_STATUSES, makeGitHubBackend } from './githubBackend.testkit.js';
import type { TestBackend } from './githubBackend.testkit.js';
import { GitHubClient } from './githubClient.js';
import { MemoryResponseCache } from './responseCache.js';

let fake: FakeGitHub;
let t: TestBackend;

const R = '/repos/acme/shop';
const UPLOAD = '/user-attachments/assets';

beforeEach(async () => {
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
	t = makeGitHubBackend(fake, {
		statuses: WRITE_STATUSES,
		options: { statusMap: WRITE_STATUS_MAP },
	});
});

afterEach(async () => {
	await fake.stop();
});

const image = (name: string, bytes: number[] = [137, 80, 78, 71, 0, 255, 128], alt?: string): CommentAttachment => ({
	name,
	mimeType: name.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
	bytes: new Uint8Array(bytes),
	...(alt === undefined ? {} : { alt }),
});

/** Every request that changed something, as `METHOD /path` (the repository prefix left out). */
const sent = (): string[] => fake.writes().map(request => `${request.method} ${request.path.replace(R, '')}`);

const failure = async (call: () => Promise<unknown>): Promise<Error> => {
	try {
		await call();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a failure');
};

const everything = (error: Error): string =>
	JSON.stringify({ message: error.message, ...(error as unknown as Record<string, unknown>), stack: error.stack });

describe('a comment with images', () => {
	it('declares the capability', () => {
		expect(t.backend.capabilities.commentAttachments).toBe(true);
	});

	it('uploads every image BEFORE the comment is created, then posts one comment naming them', async () => {
		const n = fake.addIssue({ title: 'With images' });

		const result = await t.backend.addComment(String(n), 'see the screens', {
			attachments: [image('login.png'), image('logout.jpg')],
		});

		// Uploads in the order given, then the comment, nothing else changes.
		expect(sent()).toEqual([`POST ${UPLOAD}`, `POST ${UPLOAD}`, `POST /issues/${n}/comments`]);
		expect(fake.uploads.map(upload => upload.name)).toEqual(['login.png', 'logout.jpg']);
		expect(result.attachments).toEqual([
			{ name: 'login.png', alt: 'login.png', url: fake.uploads[0]!.url },
			{ name: 'logout.jpg', alt: 'logout.jpg', url: fake.uploads[1]!.url },
		]);
		expect(result.comment.text).toBe(
			`see the screens\n\n![login.png](${fake.uploads[0]!.url})\n![logout.jpg](${fake.uploads[1]!.url})`
		);
		expect(fake.issues.get(n)!.comments).toHaveLength(1);
	});

	it('sends the token scheme, the raw bytes, the mime type and the numeric id of the repository', async () => {
		const n = fake.addIssue({ title: 'Wire' });
		const bytes = [0, 1, 2, 255, 254, 253, 10, 13, 0];

		await t.backend.addComment(String(n), 'x', { attachments: [image('a b&c.png', bytes)] });

		expect(fake.uploads).toHaveLength(1);
		const upload = fake.uploads[0]!;
		// `token`, never `Bearer` (which GitHub answers with a misleading 404 there).
		expect(upload.scheme).toBe('token');
		expect(upload.requestContentType).toBe('application/octet-stream');
		expect([...upload.bytes]).toEqual(bytes);
		expect(upload.name).toBe('a b&c.png');
		expect(upload.contentType).toBe('image/png');
		expect(upload.repositoryId).toBe(String(FakeGitHub.REPOSITORY_ID));
		// The repository id was asked once, as a read, before the first upload.
		const reads = fake.requests.filter(request => request.method === 'GET' && request.path === R);
		expect(reads).toHaveLength(1);
		const order = fake.requests.map(request => `${request.method} ${request.path}`);
		expect(order.indexOf(`GET ${R}`)).toBeLessThan(order.indexOf(`POST ${UPLOAD}`));
	});

	it('asks for the repository id once for the whole process, not once per comment', async () => {
		const n = fake.addIssue({ title: 'Twice' });

		await t.backend.addComment(String(n), 'one', { attachments: [image('a.png'), image('b.png')] });
		await t.backend.addComment(String(n), 'two', { attachments: [image('c.png')] });

		expect(fake.requests.filter(request => request.method === 'GET' && request.path === R)).toHaveLength(1);
		expect(fake.uploads).toHaveLength(3);
	});

	it('uses the alt of the attachment, and replaces a reference in the text instead of appending the image twice', async () => {
		const n = fake.addIssue({ title: 'Markdown' });

		const result = await t.backend.addComment(String(n), 'before\n![the login](./shots/login.png)\nafter', {
			attachments: [image('login.png', undefined, 'unused alt'), image('extra.png', undefined, 'extra image')],
		});

		const [login, extra] = fake.uploads;
		expect(result.comment.text).toBe(
			`before\n![the login](${login!.url})\nafter\n\n![extra image](${extra!.url})`
		);
	});

	it('accepts an image without any text', async () => {
		const n = fake.addIssue({ title: 'Image only' });

		const result = await t.backend.addComment(String(n), '', { attachments: [image('only.png')] });

		expect(result.comment.text).toBe(`![only.png](${fake.uploads[0]!.url})`);
	});

	it('leaves a comment without images exactly as before: no repository read, no upload', async () => {
		const n = fake.addIssue({ title: 'Plain' });

		await t.backend.addComment(String(n), 'plain text', { attachments: [] });

		expect(fake.uploads).toEqual([]);
		expect(fake.requests.filter(request => request.path === R)).toEqual([]);
	});
});

describe('what is refused before any upload', () => {
	it.each([
		['an empty file', [image('empty.png', [])], /"empty.png" is empty/],
		['a name that is not an image', [{ ...image('notes.txt'), mimeType: 'text/plain' }], /not an image task can attach/],
		['two files with one name', [image('a.png'), image('a.png')], /two attachments are named/],
	])('%s: nothing reaches GitHub', async (_name, attachments, message) => {
		const n = fake.addIssue({ title: 'Refused' });
		fake.requests.splice(0);

		const error = await failure(() => t.backend.addComment(String(n), 'x', { attachments }));

		expect(error).toBeInstanceOf(InvalidCommentTextError);
		expect(error.message).toMatch(message);
		expect(fake.requests).toEqual([]);
	});

	it('a body that would be too long with the image lines: refused with the figures, nothing uploaded', async () => {
		const n = fake.addIssue({ title: 'Long' });
		fake.requests.splice(0);

		const error = await failure(() =>
			t.backend.addComment(String(n), 'x'.repeat(COMMENT_TEXT_MAX - 5), { attachments: [image('a.png')] })
		);

		expect(error).toBeInstanceOf(InvalidCommentTextError);
		expect(error.message).toContain('with the image markdown');
		expect(fake.requests).toEqual([]);
	});

	it('an unknown task: not found, and nothing was uploaded', async () => {
		const error = await failure(() => t.backend.addComment('999', 'x', { attachments: [image('a.png')] }));

		expect(error).toBeInstanceOf(TaskNotFoundError);
		expect(fake.uploads).toEqual([]);
	});

	it('an author is refused as before (GitHub writes as the token user)', async () => {
		const n = fake.addIssue({ title: 'Author' });

		const error = await failure(() =>
			t.backend.addComment(String(n), 'x', { author: 'ann', attachments: [image('a.png')] })
		);

		expect(error).toBeInstanceOf(UnsupportedByBackendError);
		expect(fake.uploads).toEqual([]);
	});
});

describe('a refused upload posts nothing and says which image, which status, what to do', () => {
	it('404: the token is refused for uploads or cannot write to the repository', async () => {
		const n = fake.addIssue({ title: 'No access' });
		fake.failNext({ status: 404, pathPrefix: UPLOAD, body: { message: 'Not Found' } });

		const error = await failure(() => t.backend.addComment(String(n), 'x', { attachments: [image('shot.png')] }));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(error.message).toContain('"shot.png"');
		expect(error.message).toContain('HTTP 404');
		const hint = (error as BackendRejectedError).hint;
		expect(hint).toContain('refused the token for uploads or it has no write access to acme/shop');
		expect(hint).toContain('Issues read and write');
		expect(hint).toContain('No comment was posted');
		expect(sent().filter(line => line.includes('/comments'))).toEqual([]);
		expect(fake.issues.get(n)!.comments).toHaveLength(0);
	});

	it('404 from a read-only token: the same refusal', async () => {
		const readOnly = await FakeGitHub.start({ repo: 'acme/shop', readOnlyToken: true });
		try {
			const own = makeGitHubBackend(readOnly, { statuses: WRITE_STATUSES, options: { statusMap: WRITE_STATUS_MAP } });
			const n = readOnly.addIssue({ title: 'Read only' });

			const error = await failure(() => own.backend.addComment(String(n), 'x', { attachments: [image('a.png')] }));

			expect(error).toBeInstanceOf(BackendRejectedError);
			expect(error.message).toContain('HTTP 404');
		} finally {
			await readOnly.stop();
		}
	});

	it('422: the server reason is shown, with the mime type to check', async () => {
		const n = fake.addIssue({ title: 'Invalid' });
		fake.failNext({
			status: 422,
			pathPrefix: UPLOAD,
			body: { message: 'Validation Failed', errors: ['content type not supported'] },
		});

		const error = await failure(() => t.backend.addComment(String(n), 'x', { attachments: [image('shot.png')] }));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(error.message).toContain('"shot.png"');
		expect(error.message).toContain('HTTP 422');
		expect(error.message).toContain('content type not supported');
		expect((error as BackendRejectedError).hint).toContain('valid image/png image');
		expect(fake.issues.get(n)!.comments).toHaveLength(0);
	});

	it('429 with Retry-After: names the image and the instant, posts nothing', async () => {
		const n = fake.addIssue({ title: 'Rate limited' });
		// A retry-after longer than what a write waits out, so the client reports it instead of waiting.
		fake.failNext({ status: 429, pathPrefix: UPLOAD, headers: { 'retry-after': '120' }, body: { message: 'slow down' } });

		const error = await failure(() => t.backend.addComment(String(n), 'x', { attachments: [image('shot.png')] }));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(error.message).toContain('"shot.png"');
		expect(error.message).toContain('HTTP 429');
		expect((error as BackendRejectedError).hint).toMatch(/Retry after 20\d\d-\d\d-\d\dT/);
		expect(fake.issues.get(n)!.comments).toHaveLength(0);
	});

	it('names the images already uploaded when a later one is refused (they stay unreferenced)', async () => {
		const n = fake.addIssue({ title: 'Second fails' });
		fake.failNext({ status: 422, pathPrefix: UPLOAD, skip: 1, body: { message: 'Validation Failed' } });

		const error = await failure(() =>
			t.backend.addComment(String(n), 'x', { attachments: [image('first.png'), image('second.png')] })
		);

		expect(error.message).toContain('"second.png"');
		const hint = (error as BackendRejectedError).hint;
		expect(hint).toContain('1 image already uploaded (first.png)');
		expect(hint).toContain('cannot be removed');
		expect(fake.issues.get(n)!.comments).toHaveLength(0);
	});

	it('an other status is reported with the status and the undocumented-endpoint warning', async () => {
		const n = fake.addIssue({ title: 'Changed endpoint' });
		fake.failNext({ status: 400, pathPrefix: UPLOAD, body: { message: 'Bad request' } });

		const error = await failure(() => t.backend.addComment(String(n), 'x', { attachments: [image('a.png')] }));

		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(error.message).toContain('HTTP 400');
		expect((error as BackendRejectedError).hint).toContain('not part of the documented GitHub API');
	});
});

describe('a comment that fails after the uploads', () => {
	it('is a PartialWriteError saying what was uploaded, that it cannot be removed, and how to go on', async () => {
		const n = fake.addIssue({ title: 'Comment fails' });
		fake.failNext({ status: 422, pathPrefix: `${R}/issues/${n}/comments`, body: { message: 'Validation Failed' } });

		const error = await failure(() => t.backend.addComment(String(n), 'x', { attachments: [image('shot.png')] }));

		expect(error).toBeInstanceOf(PartialWriteError);
		const partial = error as PartialWriteError;
		expect(partial.applied).toEqual([`uploaded shot.png (${fake.uploads[0]!.url})`]);
		expect(partial.notApplied).toEqual(['the comment itself']);
		expect(partial.hint).toContain('stay on GitHub, unreferenced');
		expect(partial.hint).toContain('cannot be removed');
		expect(partial.hint).toContain('Run the same command again');
		expect(fake.issues.get(n)!.comments).toHaveLength(0);
	});

	it('when the outcome is unknown (a 502 after the write), says the comment may exist and where to look', async () => {
		const n = fake.addIssue({ title: 'Unknown outcome' });
		fake.failNext({
			status: 502,
			pathPrefix: `${R}/issues/${n}/comments`,
			applyWrite: true,
			body: { message: 'Bad Gateway' },
		});

		const error = await failure(() => t.backend.addComment(String(n), 'x', { attachments: [image('shot.png')] }));

		expect(error).toBeInstanceOf(PartialWriteError);
		expect((error as PartialWriteError).notApplied[0]).toContain('it may have been created');
		expect((error as PartialWriteError).notApplied[0]).toContain(`https://github.com/acme/shop/issues/${n}`);
	});
});

describe('the token appears nowhere', () => {
	it('not in the error of a refused upload, even when the server echoes it', async () => {
		const n = fake.addIssue({ title: 'Echo' });
		fake.failNext({
			status: 422,
			pathPrefix: UPLOAD,
			body: { message: `Validation Failed for ${fake.token}`, errors: [`bad ${fake.token}`] },
		});

		const error = await failure(() => t.backend.addComment(String(n), 'x', { attachments: [image('shot.png')] }));

		expect(everything(error)).not.toContain(fake.token);
		expect(error.message).toContain('***');
	});

	it('not in the debug lines of the client, and the address of the upload names no credential', async () => {
		const lines: string[] = [];
		const own = makeGitHubBackend(fake, {
			statuses: WRITE_STATUSES,
			options: { statusMap: WRITE_STATUS_MAP },
			client: { debug: line => lines.push(line) },
		});
		const n = fake.addIssue({ title: 'Debug' });

		await own.backend.addComment(String(n), 'x', { attachments: [image('shot.png')] });

		expect(lines.some(line => line.startsWith('POST /user-attachments/assets?name=shot.png'))).toBe(true);
		expect(lines.join('\n')).not.toContain(fake.token);
	});
});

describe('GitHubClient.upload', () => {
	const client = (baseUrl: string, uploadBaseUrl?: string): GitHubClient =>
		new GitHubClient({
			baseUrl,
			token: fake.token,
			repo: 'acme/shop',
			tokenHint: 'GITHUB_TOKEN',
			timeoutMs: 2000,
			cacheTtlMs: 0,
			cache: new MemoryResponseCache(),
			writeSpacingMs: 0,
			...(uploadBaseUrl === undefined ? {} : { uploadBaseUrl }),
		});

	it('GitHub Enterprise Server has no upload endpoint task can use: refused before any request, with the way out', async () => {
		const error = await failure(() =>
			client('https://ghe.example.com/api/v3').upload({
				name: 'a.png',
				mimeType: 'image/png',
				bytes: new Uint8Array([1]),
				repositoryId: 1,
			})
		);

		expect(error).toBeInstanceOf(UnsupportedByBackendError);
		expect((error as UnsupportedByBackendError).capability).toBe('commentAttachments');
		expect((error as UnsupportedByBackendError).hint).toContain('Enterprise Server');
	});

	it('answers with the url, and refuses an answer without one', async () => {
		const ok = await client(fake.baseUrl).upload({
			name: 'a.png',
			mimeType: 'image/png',
			bytes: new Uint8Array([1, 2]),
			repositoryId: FakeGitHub.REPOSITORY_ID,
		});
		expect(ok.url).toBe(fake.uploads[0]!.url);

		fake.failNext({ status: 201, pathPrefix: UPLOAD, body: { nothing: true } });
		const error = await failure(() =>
			client(fake.baseUrl).upload({
				name: 'b.png',
				mimeType: 'image/png',
				bytes: new Uint8Array([1]),
				repositoryId: FakeGitHub.REPOSITORY_ID,
			})
		);
		expect(error.message).toContain('without the address of the image');
	});

	it('a repository id the token cannot write to is the 404 of the endpoint', async () => {
		const error = await failure(() =>
			client(fake.baseUrl).upload({
				name: 'a.png',
				mimeType: 'image/png',
				bytes: new Uint8Array([1]),
				repositoryId: 7,
			})
		);

		expect((error as { status?: number }).status).toBe(404);
	});
});
