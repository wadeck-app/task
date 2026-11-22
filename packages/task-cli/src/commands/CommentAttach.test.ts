import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ownConfigFile } from '@wadeck-app/task-service';
import { FakeGitHub } from '@wadeck-app/task-service/fakeGitHub';

import { runTaskCommand } from '../TaskIndex.js';
import { taskHelp } from '../cli/help.js';
import { type RegisteredTestProject, registerTestProject } from '../testHelpers.js';

// task comment --attach <file>[#alt]: the files are read here, the images are stored by GitHub (fake server), nothing is committed.
let tmpDir: string;
let github: RegisteredTestProject;
let local: RegisteredTestProject;
let fake: FakeGitHub;
let stderr: string[];

const TOKEN_VARIABLE = 'TASK_CLI_ATTACH_GITHUB_TOKEN';
const PNG = [137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 1, 2];

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-github-'));
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
	github = await registerTestProject(path.join(tmpDir, 'shop'));
	fs.writeFileSync(
		ownConfigFile(github.storage),
		`statuses:
    - backlog
    - { name: done, terminal: true }
strategy:
    type: github
    options:
        repo: acme/shop
        baseUrl: ${fake.baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        cache: { ttlSeconds: 0 }
        timeoutSeconds: 3
        writeSpacingSeconds: 0
        statusMap:
            backlog: { state: open }
            done: { state: closed }
`
	);
	local = await registerTestProject(path.join(tmpDir, 'plain'));
	vi.stubEnv(TOKEN_VARIABLE, fake.token);
	stderr = [];
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await fake.stop();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const onGitHub = (...args: string[]) => runTaskCommand(args, github.dir);
const onLocal = (...args: string[]) => runTaskCommand(args, local.dir);

/** Writes a file of the test and returns its absolute path. */
function file(name: string, bytes: number[] | Buffer = PNG): string {
	const full = path.join(tmpDir, name);
	fs.writeFileSync(full, Buffer.from(bytes));
	return full;
}

describe('task comment --attach on a github project', () => {
	it('uploads the files, posts ONE comment naming them, and answers the urls (--json)', async () => {
		fake.addIssue({ title: 'Alpha' });
		const shot = file('login.png');
		const photo = file('photo.JPG', [255, 216, 255, 0, 9]);

		const result = await onGitHub('comment', '1', 'the', 'screens', '--attach', `${shot}#the login page`, '--attach', photo, '--json');

		expect(result.exitCode).toBe(0);
		const json = JSON.parse(result.output) as {
			taskId: string;
			comment: { text: string };
			attachments: Array<{ name: string; alt: string; url: string }>;
		};
		expect(json.attachments).toEqual([
			{ name: 'login.png', alt: 'the login page', url: fake.uploads[0]!.url },
			{ name: 'photo.JPG', alt: 'photo.JPG', url: fake.uploads[1]!.url },
		]);
		expect(json.comment.text).toBe(
			`the screens\n\n![the login page](${fake.uploads[0]!.url})\n![photo.JPG](${fake.uploads[1]!.url})`
		);
		// The bytes are the files', the mime types come from the extensions, and the uploads come before the comment.
		expect([...fake.uploads[0]!.bytes]).toEqual(PNG);
		expect([...fake.uploads[1]!.bytes]).toEqual([255, 216, 255, 0, 9]);
		expect(fake.uploads.map(upload => upload.contentType)).toEqual(['image/png', 'image/jpeg']);
		expect(fake.writes().map(request => `${request.method} ${request.path}`)).toEqual([
			'POST /user-attachments/assets',
			'POST /user-attachments/assets',
			'POST /repos/acme/shop/issues/1/comments',
		]);
	});

	it('the text mode prints the comment id and one line per image', async () => {
		fake.addIssue({ title: 'Alpha' });

		const result = await onGitHub('comment', '1', 'x', '--attach', file('a.png'));

		expect(result.exitCode).toBe(0);
		const lines = result.output.split('\n');
		expect(lines[0]).toMatch(/^Comment \d+ added to task 1$/);
		expect(lines[1]).toBe(`  attached a.png: ${fake.uploads[0]!.url}`);
	});

	it('an image alone is a comment (no text needed), and a reference in the text is replaced by the url', async () => {
		fake.addIssue({ title: 'Alpha' });

		const only = await onGitHub('comment', '1', '--attach', file('only.png'), '--json');
		const placed = await onGitHub('comment', '1', 'look: ![here](./tmp/placed.png) ok', '--attach', file('placed.png'), '--json');

		expect(only.exitCode).toBe(0);
		expect((JSON.parse(only.output) as { comment: { text: string } }).comment.text).toBe(
			`![only.png](${fake.uploads[0]!.url})`
		);
		expect((JSON.parse(placed.output) as { comment: { text: string } }).comment.text).toBe(
			`look: ![here](${fake.uploads[1]!.url}) ok`
		);
	});

	it('takes a file whose name contains # as is, when it exists', async () => {
		fake.addIssue({ title: 'Alpha' });
		const odd = file('issue#12.png');

		const result = await onGitHub('comment', '1', 'x', '--attach', odd, '--json');

		expect(result.exitCode).toBe(0);
		expect(fake.uploads[0]!.name).toBe('issue#12.png');
	});

	it('a missing file is an actionable error and nothing reaches GitHub', async () => {
		fake.addIssue({ title: 'Alpha' });
		fake.requests.splice(0);

		const result = await onGitHub('comment', '1', 'x', '--attach', path.join(tmpDir, 'nope.png'));

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('nope.png');
		expect(result.output).toContain('cannot read the file');
		expect(fake.requests).toEqual([]);
	});

	it.each([
		['an empty file', 'empty.png', [] as number[], /is empty/],
		['a file that is not an image', 'notes.txt', [65, 66], /not an image task can attach \(accepted extensions: \.png, \.jpg, \.jpeg, \.gif, \.webp\)/],
	])('%s is refused with the fix, before any request', async (_label, name, bytes, message) => {
		fake.addIssue({ title: 'Alpha' });
		fake.requests.splice(0);

		const result = await onGitHub('comment', '1', 'x', '--attach', file(name, bytes));

		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(message);
		expect(fake.requests).toEqual([]);
	});

	it('a file over 10 MB is refused and the cap is said', async () => {
		fake.addIssue({ title: 'Alpha' });
		fake.requests.splice(0);

		const result = await onGitHub('comment', '1', 'x', '--attach', file('huge.png', Buffer.alloc(10 * 1024 * 1024 + 1, 1)));

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('at most 10 MB');
		expect(fake.requests).toEqual([]);
	});

	it('more than 10 attachments are refused', async () => {
		fake.addIssue({ title: 'Alpha' });
		const flags = Array.from({ length: 11 }, (_, i) => ['--attach', file(`n${i}.png`)]).flat();

		const result = await onGitHub('comment', '1', 'x', ...flags);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('at most 10 --attach');
		expect(fake.requests).toEqual([]);
	});

	it('--attach without a value is a usage error, and the help documents the flag', async () => {
		fake.addIssue({ title: 'Alpha' });

		const missing = await onGitHub('comment', '1', 'x', '--attach');
		const nothing = await onGitHub('comment', '1');

		expect(missing.exitCode).toBe(1);
		expect(missing.output).toContain('--attach requires an image file');
		expect(nothing.output).toContain('missing text');
		expect(taskHelp()).toContain('--attach <file>[#alt]');
		expect(taskHelp()).toContain('GitHub stores the image itself');
	});

	it('a refused upload is the error of the file with the status and the fix, and no comment exists (--json)', async () => {
		fake.addIssue({ title: 'Alpha' });
		fake.failNext({ status: 404, pathPrefix: '/user-attachments', body: { message: 'Not Found' } });

		const result = await onGitHub('comment', '1', 'x', '--attach', file('a.png'), '--json');

		expect(result.exitCode).toBe(1);
		const json = JSON.parse(result.output) as { error: string; hint: string };
		expect(json.error).toContain('"a.png"');
		expect(json.error).toContain('HTTP 404');
		expect(json.hint).toContain('no write access to acme/shop');
		expect(fake.issues.get(1)!.comments).toHaveLength(0);
		expect(`${result.output}${stderr.join('')}`).not.toContain(fake.token);
	});
});

describe('task comment --attach where the strategy cannot store images', () => {
	it('a local project refuses it loudly, names the capability and the github strategy, and writes nothing', async () => {
		const created = JSON.parse((await onLocal('new', 'Local task', '--json')).output) as { id: string };

		const result = await onLocal('comment', created.id, 'x', '--attach', file('a.png'), '--json');

		expect(result.exitCode).toBe(1);
		const json = JSON.parse(result.output) as { error: string; hint: string };
		expect(json.error).toContain('capability "commentAttachments"');
		expect(json.hint).toContain('never commits or copies files for you');
		expect(json.hint).toContain('github strategy');
		const comments = JSON.parse((await onLocal('comments', created.id, '--json')).output) as unknown[];
		expect(comments).toEqual([]);
	});
});
