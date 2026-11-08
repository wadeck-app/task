// `task strategy check` on the tokens: the variable named by `tokenEnv` is set, the file named by `tokenFile` is readable by its
// owner only. The value of a token is never read into a result: a file is stat'ed, a variable is tested for presence.
import * as fs from 'node:fs';
import * as path from 'node:path';

import { TaskConfigLoader } from '@wadeck-app/task-core';

import type { CheckLine } from './plugins/kinds.js';

export function checkTokenEnv(key: string, name: string, env: NodeJS.ProcessEnv): CheckLine {
	if ((env[name] ?? '') !== '') return { name: 'token', status: 'ok', text: `${name} is set (${key})` };
	return {
		name: 'token',
		status: 'error',
		text: `${name} is not set (${key})`,
		fix: `Set ${name} in the environment of the shell that runs task (export ${name}=<token>, or setx ${name} <token> on Windows), then run: task strategy check`,
	};
}

export interface TokenFileProbe {
	/** Default: the running platform. */
	platform?: NodeJS.Platform;
	/** Reads the permission bits of a file. Default: `fs.statSync(file).mode`. */
	mode?: (file: string) => number;
}

export function checkTokenFile(key: string, configured: string, probe: TokenFileProbe = {}): CheckLine {
	const platform = probe.platform ?? process.platform;
	const file = TaskConfigLoader.expandTilde(configured);
	if (!path.isAbsolute(file)) {
		return {
			name: 'token',
			status: 'error',
			text: `${configured} is not an absolute path (${key})`,
			fix: 'Write the absolute path of the file, or one starting with ~/',
		};
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
		fs.accessSync(file, fs.constants.R_OK);
	} catch {
		return {
			name: 'token',
			status: 'error',
			text: `${file} cannot be read (${key})`,
			fix: `Create the file with the token in it, readable by you only (chmod 600 ${file}), or fix the path`,
		};
	}
	if (!stat.isFile()) {
		return {
			name: 'token',
			status: 'error',
			text: `${file} is not a file (${key})`,
			fix: 'Point tokenFile at a file holding the token',
		};
	}
	if (stat.size === 0) {
		return {
			name: 'token',
			status: 'error',
			text: `${file} is empty (${key})`,
			fix: 'Write the token in the file',
		};
	}
	if (platform === 'win32') {
		return {
			name: 'token',
			status: 'warn',
			text: `${file} is readable; its permissions cannot be checked on Windows (${key})`,
			fix: 'Make sure only your account can read the file (Properties > Security)',
		};
	}
	const mode = (probe.mode?.(file) ?? stat.mode) & 0o777;
	if ((mode & 0o077) !== 0) {
		return {
			name: 'token',
			status: 'error',
			text: `${file} is readable by other users (mode ${mode.toString(8)}) (${key})`,
			fix: `chmod 600 ${file}`,
		};
	}
	return { name: 'token', status: 'ok', text: `${file} is readable, mode ${mode.toString(8)} (${key})` };
}
