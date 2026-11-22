// The images of a comment on GitHub: stored by GitHub itself as user-attachments assets (never committed anywhere), then named in the
// comment as markdown. Two requests of their own: the numeric id of the repository (`GET /repos/{owner}/{repo}`, once per process) and
// one upload per image (GithubClient.upload). The endpoint is NOT part of the documented REST API (gh uses the same one): when it
// changes, the failure is a typed error naming the image and the status, never a silent drop. The credentials need nothing more than
// the strategy's own (Issues: Read and write): see the comment in credentialRequirements.ts.
import { BackendRejectedError, RateLimitedError, altOf } from '@wadeck-app/task-core';
import type { CommentAttachment, UploadedAttachment } from '@wadeck-app/task-core';

import { GitHubHttpError } from './githubClient.js';
import type { GitHubClient } from './githubClient.js';

/** The numeric REST id of the repository, which the upload endpoint asks for. Read through the client (cached, ETag). */
export async function readRepositoryId(client: GitHubClient, repoPath: string, repo: string): Promise<number> {
	const answer = await client.get<{ id?: unknown }>(repoPath);
	const id = answer.body?.id;
	if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
		throw new BackendRejectedError(
			'github',
			'uploadAttachment',
			`GitHub did not give the numeric id of ${repo}, which an image upload needs`,
			`Check that ${repo} is the repository you mean (task strategy check); nothing was uploaded.`
		);
	}
	return id;
}

const noun = (count: number): string => `${count} image${count === 1 ? '' : 's'}`;

/** What is left on GitHub when a later step fails: an upload cannot be removed. */
export function orphanNote(uploaded: readonly UploadedAttachment[]): string {
	return uploaded.length === 0
		? 'Nothing was uploaded.'
		: `${noun(uploaded.length)} already uploaded (${uploaded.map(item => item.name).join(', ')}) stay on GitHub, unreferenced: an upload cannot be removed.`;
}

/** The refusal of one upload, as the typed error that names the file, the status and the next step. Other failures are returned unchanged. */
function uploadFailure(
	error: unknown,
	attachment: CommentAttachment,
	repo: string,
	uploaded: readonly UploadedAttachment[]
): unknown {
	const note = `No comment was posted. ${orphanNote(uploaded)}`;
	if (error instanceof RateLimitedError) {
		return new BackendRejectedError(
			'github',
			'uploadAttachment',
			`GitHub refused the upload of "${attachment.name}" (HTTP 429, rate limit)`,
			`${error.retryAt === undefined ? 'Wait at least a minute' : `Retry after ${error.retryAt.toISOString()}`} and run the command again. ${note}`
		);
	}
	if (!(error instanceof GitHubHttpError)) return error;
	const reason = [error.detail, ...error.errors].filter(text => text !== '').join('; ');
	if (error.status === 404) {
		return new BackendRejectedError(
			'github',
			'uploadAttachment',
			`GitHub refused the upload of "${attachment.name}" (HTTP 404)`,
			`GitHub refused the token for uploads or it has no write access to ${repo}; the token must be the one of the strategy with Issues read and write (task strategy help github). ${note}`
		);
	}
	if (error.status === 422) {
		return new BackendRejectedError(
			'github',
			'uploadAttachment',
			`GitHub refused the upload of "${attachment.name}" (HTTP 422${reason === '' ? '' : `: ${reason}`})`,
			`Check that "${attachment.name}" is a valid ${attachment.mimeType} image, then try again. ${note}`
		);
	}
	return new BackendRejectedError(
		'github',
		'uploadAttachment',
		`GitHub answered HTTP ${error.status} to the upload of "${attachment.name}"${reason === '' ? '' : `: ${reason}`}`,
		`The upload endpoint is not part of the documented GitHub API and may have changed; try again later or leave --attach out. ${note}`
	);
}

/** Uploads the images one after the other, in order. The first refusal stops it with the typed error (the earlier uploads are named in it). */
export async function uploadAttachments(
	client: GitHubClient,
	repositoryId: number,
	repo: string,
	attachments: readonly CommentAttachment[]
): Promise<UploadedAttachment[]> {
	const uploaded: UploadedAttachment[] = [];
	for (const attachment of attachments) {
		try {
			const { url } = await client.upload({
				name: attachment.name,
				mimeType: attachment.mimeType,
				bytes: attachment.bytes,
				repositoryId,
			});
			uploaded.push({ name: attachment.name, alt: altOf(attachment), url });
		} catch (error) {
			throw uploadFailure(error, attachment, repo, uploaded);
		}
	}
	return uploaded;
}
