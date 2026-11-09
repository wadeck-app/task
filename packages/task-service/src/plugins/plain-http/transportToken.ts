// Where the token of the plain-http transport comes from: the NAME of an environment variable, or the path of a file (the config never
// holds the token). A missing or unusable token is a RemoteUnauthorizedError (reason `missing`) that says which key to fix and how;
// there is no anonymous mode. The value leaves this file as the return value only.
import * as fs from 'node:fs';
import * as path from 'node:path';

import { RemoteUnauthorizedError, TaskConfigLoader } from '@wadeck-app/task-core';

export type TokenSource = { kind: 'env'; name: string } | { kind: 'file'; path: string };

export interface TokenFileProbe {
	platform?: NodeJS.Platform;
	/** Permission bits of the file; default: what the file system reports (tests inject it). */
	mode?: (file: string) => number;
}

const HOW_TO_MAKE_ONE =
	'Use the same long random token on both machines: the one task serve was started with (see: task serve --help).';

function missing(message: string, hint: string): RemoteUnauthorizedError {
	return new RemoteUnauthorizedError('missing', message, hint);
}

/** The token, trimmed. Throws RemoteUnauthorizedError naming where it should have been and how to provide it. */
export function resolveToken(source: TokenSource, env: NodeJS.ProcessEnv, probe: TokenFileProbe = {}): string {
	if (source.kind === 'env') {
		const value = (env[source.name] ?? '').trim();
		if (value === '') {
			throw missing(
				`No token for the task server: the environment variable ${source.name} is not set (transport option tokenEnv)`,
				`Set it in the shell that runs task: export ${source.name}=<token> (Windows: setx ${source.name} <token>, then open a new terminal). ${HOW_TO_MAKE_ONE}`
			);
		}
		return checked(value, `the environment variable ${source.name}`);
	}
	const file = TaskConfigLoader.expandTilde(source.path);
	if (!path.isAbsolute(file)) {
		throw missing(
			`The token file ${source.path} is not an absolute path (transport option tokenFile)`,
			'Write the absolute path of the file, or one starting with ~/'
		);
	}
	let text: string;
	try {
		const mode = probe.mode?.(file) ?? fs.statSync(file).mode;
		if ((probe.platform ?? process.platform) !== 'win32' && (mode & 0o077) !== 0) {
			throw missing(
				`The token file ${file} is readable by other users (mode ${(mode & 0o777).toString(8)})`,
				`Restrict it to your user: chmod 600 ${file}`
			);
		}
		text = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if (error instanceof RemoteUnauthorizedError) throw error;
		throw missing(
			`The token file ${file} cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error)})`,
			`Write the token alone in ${file}, readable by you only. ${HOW_TO_MAKE_ONE}`
		);
	}
	const value = text.trim();
	if (value === '') {
		throw missing(`The token file ${file} is empty`, `Write the token alone in ${file}. ${HOW_TO_MAKE_ONE}`);
	}
	return checked(value, `the file ${file}`);
}

function checked(value: string, from: string): string {
	if (/\s/.test(value)) {
		throw missing(
			`${from} holds something that is not a token (it contains spaces or line breaks)`,
			'Put only the token in it.'
		);
	}
	return value;
}
