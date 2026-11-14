import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { BackendAuthError } from '@wadeck-app/task-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveForgeToken } from './forgeToken.js';
import type { ForgeTokenRules } from './forgeToken.js';

const rules: ForgeTokenRules = {
	backendKind: 'gitlab',
	forgeName: 'GitLab',
	howToGetOne: set => `HOWTO ${set}`,
};
const where = { source: '/p/config.yml', project: 'demo' };

function failure(run: () => string): BackendAuthError {
	try {
		run();
	} catch (error) {
		return error as BackendAuthError;
	}
	throw new Error('expected a BackendAuthError');
}

describe('resolveForgeToken', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('reads a variable, trimmed', () => {
		expect(resolveForgeToken({ kind: 'env', name: 'T' }, { T: ' abc \n' }, where, rules)).toBe('abc');
	});

	it('a missing variable names the forge, the project, the file, the key and the step', () => {
		const error = failure(() => resolveForgeToken({ kind: 'env', name: 'T' }, {}, where, rules));
		expect(error.backendKind).toBe('gitlab');
		expect(error.reason).toBe('missing');
		expect(error.message).toBe(
			'No GitLab token: the environment variable T is not set (strategy.options.tokenEnv of project "demo", /p/config.yml)'
		);
		expect(error.hint).toContain('HOWTO Put it in T: export T=<token>');
	});

	it('refuses a value with spaces', () => {
		const error = failure(() => resolveForgeToken({ kind: 'env', name: 'T' }, { T: 'a b' }, where, rules));
		expect(error.message).toContain('holds something that is not a token');
		expect(error.hint).toBe('HOWTO Put only the token in it.');
	});

	it('reads a file, refuses a relative path, an empty file and a file readable by others (POSIX)', () => {
		const file = path.join(dir, 'token');
		fs.writeFileSync(file, 'tok\n');
		const owner = { ...where, mode: () => 0o600 };
		expect(resolveForgeToken({ kind: 'file', path: file }, {}, owner, rules)).toBe('tok');
		expect(
			failure(() => resolveForgeToken({ kind: 'file', path: 'rel/token' }, {}, where, rules)).message
		).toContain('is not an absolute path');
		const open = failure(() =>
			resolveForgeToken(
				{ kind: 'file', path: file },
				{},
				{ ...where, platform: 'linux', mode: () => 0o644 },
				rules
			)
		);
		expect(open.message).toContain('is readable by other users (mode 644)');
		expect(open.hint).toBe(`chmod 600 ${file}`);
		fs.writeFileSync(file, '  \n');
		expect(failure(() => resolveForgeToken({ kind: 'file', path: file }, {}, owner, rules)).message).toContain(
			'is empty'
		);
		const none = path.join(dir, 'none');
		expect(failure(() => resolveForgeToken({ kind: 'file', path: none }, {}, owner, rules)).message).toContain(
			'cannot be read'
		);
	});
});
