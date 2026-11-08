import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BackendAuthError } from '@wadeck-app/task-core';

import { resolveToken } from './githubToken.js';
import type { TokenWhere } from './githubToken.js';

const WHERE: TokenWhere = {
	source: '/reg/projects/p1/task/config/config.yml',
	project: 'shop',
	repo: 'acme/shop',
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
		return error as BackendAuthError;
	}
	throw new Error('expected a refusal');
}

describe('resolveToken: from an environment variable', () => {
	it('returns the value, trimmed', () => {
		expect(resolveToken({ kind: 'env', name: 'GH' }, { GH: '  tok123\n' }, WHERE)).toBe('tok123');
	});

	it('an unset or empty variable names the project, the file, the key and the way to set it', () => {
		for (const env of [{}, { GH: '' }, { GH: '   ' }]) {
			const error = failure(() => resolveToken({ kind: 'env', name: 'GH' }, env, WHERE));

			expect(error.reason).toBe('missing');
			expect(error.message).toBe(
				'No GitHub token: the environment variable GH is not set (strategy.options.tokenEnv of project "shop", /reg/projects/p1/task/config/config.yml)'
			);
			expect(error.hint).toContain('export GH=<token>');
			expect(error.hint).toContain('setx GH');
			expect(error.hint).toContain('Issues: Read and Metadata: Read');
			expect(error.hint).toContain('acme/shop');
		}
	});

	it('a value with spaces or line breaks is not a token', () => {
		const error = failure(() => resolveToken({ kind: 'env', name: 'GH' }, { GH: 'a b' }, WHERE));

		expect(error.message).toBe(
			'the environment variable GH holds something that is not a token (it contains spaces or line breaks)'
		);
		expect(error.message).not.toContain('a b');
	});
});

describe('resolveToken: from a file', () => {
	function write(content: string): string {
		const file = path.join(dir, 'token');
		fs.writeFileSync(file, content);
		return file;
	}

	it('returns the content, trimmed', () => {
		const file = write('tok123\n');

		expect(resolveToken({ kind: 'file', path: file }, {}, { ...WHERE, platform: 'win32' })).toBe('tok123');
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

	it('on a POSIX system a file readable by others is refused with the chmod', () => {
		const file = write('tok123');

		const error = failure(() =>
			resolveToken({ kind: 'file', path: file }, {}, { ...WHERE, platform: 'linux', mode: () => 0o644 })
		);
		expect(error.message).toContain('readable by other users (mode 644)');
		expect(error.hint).toBe(`chmod 600 ${file}`);

		expect(resolveToken({ kind: 'file', path: file }, {}, { ...WHERE, platform: 'linux', mode: () => 0o600 })).toBe(
			'tok123'
		);
	});

	it('expands ~ to the home directory', () => {
		const error = failure(() =>
			resolveToken({ kind: 'file', path: '~/definitely-not-a-token-file-xyz' }, {}, WHERE)
		);

		// The message names the expanded absolute path, not the ~ the config holds.
		expect(error.message).toContain('definitely-not-a-token-file-xyz');
		expect(error.message).not.toContain('~');
		expect(path.isAbsolute(/The token file (.+?) cannot be read/.exec(error.message)![1]!)).toBe(true);
	});
});
