import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BackendAuthError } from '@wadeck-app/task-core';

import { resolveToken } from './gitlabToken.js';
import type { TokenWhere } from './gitlabToken.js';

const WHERE: TokenWhere = {
	source: '/reg/projects/p1/task/config/config.yml',
	project: 'shop',
	gitlabProject: 'acme/shop',
};

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-'));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function failure(call: () => unknown): BackendAuthError {
	try {
		call();
	} catch (error) {
		expect(error).toBeInstanceOf(BackendAuthError);
		expect((error as BackendAuthError).backendKind).toBe('gitlab');
		return error as BackendAuthError;
	}
	throw new Error('expected a refusal');
}

describe('resolveToken: from an environment variable', () => {
	it('returns the value, trimmed', () => {
		expect(resolveToken({ kind: 'env', name: 'GL' }, { GL: '  glpat-123\n' }, WHERE)).toBe('glpat-123');
	});

	it('an unset or empty variable names the project, the file, the key and the way to set it', () => {
		for (const env of [{}, { GL: '' }, { GL: '   ' }]) {
			const error = failure(() => resolveToken({ kind: 'env', name: 'GL' }, env, WHERE));

			expect(error.reason).toBe('missing');
			expect(error.message).toBe(
				'No GitLab token: the environment variable GL is not set (strategy.options.tokenEnv of project "shop", /reg/projects/p1/task/config/config.yml)'
			);
			expect(error.hint).toContain('export GL=<token>');
			expect(error.hint).toContain('setx GL');
			expect(error.hint).toContain('scope api');
			expect(error.hint).toContain('read_api');
			expect(error.hint).toContain('acme/shop');
		}
	});

	it('a value with spaces or line breaks is not a token, and is never echoed', () => {
		const error = failure(() => resolveToken({ kind: 'env', name: 'GL' }, { GL: 'secret part\nmore' }, WHERE));

		expect(error.message).toBe(
			'the environment variable GL holds something that is not a token (it contains spaces or line breaks)'
		);
		expect(error.message).not.toContain('secret');
		expect(error.hint).not.toContain('secret');
	});
});

describe('resolveToken: from a file', () => {
	function write(content: string): string {
		const file = path.join(dir, 'token');
		fs.writeFileSync(file, content);
		return file;
	}

	it('returns the content, trimmed', () => {
		const file = write('glpat-123\n');

		expect(resolveToken({ kind: 'file', path: file }, {}, { ...WHERE, platform: 'win32' })).toBe('glpat-123');
	});

	it('refuses a relative path', () => {
		const error = failure(() => resolveToken({ kind: 'file', path: 'token.txt' }, {}, WHERE));

		expect(error.message).toContain('is not an absolute path');
		expect(error.hint).toContain('~/');
	});

	it('refuses a missing file and an empty one, naming the key', () => {
		const missing = failure(() => resolveToken({ kind: 'file', path: path.join(dir, 'nope') }, {}, WHERE));
		const empty = failure(() =>
			resolveToken({ kind: 'file', path: write('  \n') }, {}, { ...WHERE, platform: 'win32' })
		);

		expect(missing.message).toContain('cannot be read (strategy.options.tokenFile of project "shop"');
		expect(empty.message).toContain('is empty (strategy.options.tokenFile');
		expect(missing.hint).toContain('readable by you only');
	});

	it('a file with several words is not a token', () => {
		const file = write('a b');
		const error = failure(() => resolveToken({ kind: 'file', path: file }, {}, { ...WHERE, platform: 'win32' }));
		expect(error.message).toContain('holds something that is not a token');
	});

	it('on a POSIX system a file readable by others is refused with the chmod', () => {
		const file = write('glpat-123');

		const error = failure(() =>
			resolveToken({ kind: 'file', path: file }, {}, { ...WHERE, platform: 'linux', mode: () => 0o644 })
		);
		expect(error.message).toContain('readable by other users (mode 644)');
		expect(error.hint).toBe(`chmod 600 ${file}`);

		expect(resolveToken({ kind: 'file', path: file }, {}, { ...WHERE, platform: 'linux', mode: () => 0o600 })).toBe(
			'glpat-123'
		);
	});

	it('expands ~ to the home directory', () => {
		const error = failure(() =>
			resolveToken({ kind: 'file', path: '~/definitely-not-a-token-file-xyz' }, {}, WHERE)
		);

		expect(error.message).toContain('definitely-not-a-token-file-xyz');
		expect(error.message).not.toContain('~');
		expect(path.isAbsolute(/The token file (.+?) cannot be read/.exec(error.message)![1]!)).toBe(true);
	});
});
