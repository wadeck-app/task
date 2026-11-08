import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { checkTokenEnv, checkTokenFile } from './tokenCheck.js';

const KEY = 'strategy.options.tokenFile';

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('checkTokenEnv', () => {
	it('a set variable is ok and the value is never in the line', () => {
		const line = checkTokenEnv('strategy.options.tokenEnv', 'TASK_X', { TASK_X: 'sekret' });

		expect(line).toEqual({ name: 'token', status: 'ok', text: 'TASK_X is set (strategy.options.tokenEnv)' });
		expect(JSON.stringify(line)).not.toContain('sekret');
	});

	it.each([[{}], [{ TASK_X: '' }]])('an unset or empty variable (%j) is an error with the fix', env => {
		const line = checkTokenEnv('strategy.options.tokenEnv', 'TASK_X', env);

		expect(line).toMatchObject({
			name: 'token',
			status: 'error',
			text: 'TASK_X is not set (strategy.options.tokenEnv)',
		});
		expect(line.fix).toBe(
			'Set TASK_X in the environment of the shell that runs task (export TASK_X=<token>, or setx TASK_X <token> on Windows), then run: task strategy check'
		);
	});
});

describe('checkTokenFile', () => {
	function tokenFile(content = 'abc', mode?: number): string {
		const file = path.join(root, 'token');
		fs.writeFileSync(file, content, { mode });
		return file;
	}

	it('a missing file is an error naming the file', () => {
		const file = path.join(root, 'absent');

		const line = checkTokenFile(KEY, file, { platform: 'linux' });

		expect(line).toMatchObject({ name: 'token', status: 'error', text: `${file} cannot be read (${KEY})` });
		expect(line.fix).toBe(
			`Create the file with the token in it, readable by you only (chmod 600 ${file}), or fix the path`
		);
	});

	it('an empty file is an error', () => {
		const line = checkTokenFile(KEY, tokenFile(''), { platform: 'linux' });

		expect(line).toMatchObject({ status: 'error', text: expect.stringContaining('is empty') });
	});

	it('a directory is an error', () => {
		const line = checkTokenFile(KEY, root, { platform: 'linux' });

		expect(line).toMatchObject({ status: 'error', text: expect.stringContaining('is not a file') });
	});

	it.each([
		[0o644, 'error'],
		[0o640, 'error'],
		[0o604, 'error'],
		[0o600, 'ok'],
		[0o400, 'ok'],
	])('on a POSIX system mode %o is %s', (mode, status) => {
		const file = tokenFile();
		const line = checkTokenFile(KEY, file, { platform: 'linux', mode: () => mode });

		expect(line.status).toBe(status);
		if (status === 'error') {
			expect(line.text).toBe(`${file} is readable by other users (mode ${mode.toString(8)}) (${KEY})`);
			expect(line.fix).toBe(`chmod 600 ${file}`);
		} else {
			expect(line.text).toBe(`${file} is readable, mode ${mode.toString(8)} (${KEY})`);
		}
	});

	it('on Windows the permissions cannot be read: a warning, not a silent ok', () => {
		const file = tokenFile();

		const line = checkTokenFile(KEY, file, { platform: 'win32' });

		expect(line).toMatchObject({
			status: 'warn',
			text: `${file} is readable; its permissions cannot be checked on Windows (${KEY})`,
		});
		expect(line.fix).toBe('Make sure only your account can read the file (Properties > Security)');
	});

	it('expands a leading ~', () => {
		const line = checkTokenFile(KEY, '~/definitely-not-there-token', { platform: 'linux' });

		expect(line.status).toBe('error');
		expect(line.text).not.toContain('~');
	});

	it('refuses a relative path: it would depend on where task runs', () => {
		const line = checkTokenFile(KEY, 'token', { platform: 'linux' });

		expect(line).toMatchObject({ status: 'error', text: `token is not an absolute path (${KEY})` });
		expect(line.fix).toBe('Write the absolute path of the file, or one starting with ~/');
	});
});
