import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DEFAULT_TOKEN_ENV, resolveServerToken } from './serverToken.js';
import { TaskServerStartError } from './taskServer.js';

const GOOD = 'server-token-0123456789abcdef';
let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-'));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function refusal(call: () => unknown): TaskServerStartError {
	try {
		call();
	} catch (error) {
		expect(error).toBeInstanceOf(TaskServerStartError);
		return error as TaskServerStartError;
	}
	throw new Error('expected a refusal');
}

describe('resolveServerToken: where the token of task serve comes from', () => {
	it('reads TASK_SERVE_TOKEN by default, trimmed, and says where it came from', () => {
		const result = resolveServerToken({ env: { [DEFAULT_TOKEN_ENV]: ` ${GOOD}\n` } });

		expect(DEFAULT_TOKEN_ENV).toBe('TASK_SERVE_TOKEN');
		expect(result).toEqual({ token: GOOD, origin: { kind: 'env', name: 'TASK_SERVE_TOKEN' } });
	});

	it('reads the variable the person names, or a file', () => {
		const file = path.join(dir, 'token');
		fs.writeFileSync(file, `${GOOD}\n`);

		expect(resolveServerToken({ tokenEnv: 'MY_TOKEN', env: { MY_TOKEN: GOOD } }).origin).toEqual({
			kind: 'env',
			name: 'MY_TOKEN',
		});
		expect(resolveServerToken({ tokenFile: file, env: {}, platform: 'win32' })).toEqual({
			token: GOOD,
			origin: { kind: 'file', path: file },
		});
	});

	it('an unset variable is a refusal that says how to make a token and where it goes on BOTH machines; there is no anonymous mode', () => {
		const error = refusal(() => resolveServerToken({ env: {} }));

		expect(error.message).toBe('no token: the environment variable TASK_SERVE_TOKEN is not set');
		expect(error.hint).toContain('randomBytes(32)');
		expect(error.hint).toContain('BOTH machines');
		expect(error.hint).toContain('export TASK_SERVE_TOKEN=');
		expect(error.hint).toContain('--token-file');
	});

	it('a token that is too short is refused without printing it', () => {
		const error = refusal(() => resolveServerToken({ env: { [DEFAULT_TOKEN_ENV]: 'hunter2' } }));

		expect(error.message).toContain('too short (7 characters; at least 16 are required)');
		expect(error.message).not.toContain('hunter2');
	});

	it('refuses both options at once, and a token typed where the NAME of the variable belongs, without echoing it', () => {
		expect(refusal(() => resolveServerToken({ tokenEnv: 'A', tokenFile: '/x', env: {} })).message).toBe(
			'give either --token-env or --token-file, not both'
		);
		const typed = refusal(() => resolveServerToken({ tokenEnv: GOOD.replace(/-/g, ''), env: {} }));
		expect(typed.message).toContain('looks like a token');
		expect(typed.message).not.toContain(GOOD.replace(/-/g, ''));
		expect(typed.hint).toContain('NAME of an environment variable');
		const spaced = refusal(() => resolveServerToken({ tokenEnv: 'not a name', env: {} }));
		expect(spaced.message).toContain('is not an environment variable name');
	});

	it.each([
		['a relative path', 'token', 'is not an absolute path'],
		['a missing file', 'MISSING', 'cannot be read'],
	])('refuses a token file that is %s', (_name, file, expected) => {
		const given = file === 'MISSING' ? path.join(dir, 'absent') : file;

		expect(refusal(() => resolveServerToken({ tokenFile: given, env: {}, platform: 'win32' })).message).toContain(
			expected
		);
	});

	it('refuses an empty token file and one with several words', () => {
		const empty = path.join(dir, 'empty');
		const words = path.join(dir, 'words');
		fs.writeFileSync(empty, '\n');
		fs.writeFileSync(words, 'two words here and more');

		expect(refusal(() => resolveServerToken({ tokenFile: empty, env: {}, platform: 'win32' })).message).toContain(
			'is empty'
		);
		expect(refusal(() => resolveServerToken({ tokenFile: words, env: {}, platform: 'win32' })).message).toContain(
			'not a token'
		);
	});

	it('refuses a token file other users can read on POSIX, with the command that fixes it', () => {
		const file = path.join(dir, 'open');
		fs.writeFileSync(file, GOOD);

		const error = refusal(() =>
			resolveServerToken({ tokenFile: file, env: {}, platform: 'linux', mode: () => 0o644 })
		);

		expect(error.message).toContain('readable by other users (mode 644)');
		expect(error.hint).toContain(`chmod 600 ${file}`);
		expect(resolveServerToken({ tokenFile: file, env: {}, platform: 'linux', mode: () => 0o600 }).token).toBe(GOOD);
	});
});
