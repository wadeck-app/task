// Where the bearer token of `task serve` comes from: the NAME of an environment variable (default TASK_SERVE_TOKEN) or the path of a
// file. There is no anonymous mode and no token on the command line (it would show in the process list and the shell history).
// A missing, short or unusable token is a TaskServerStartError that says how to make one. The value leaves this file as the return
// value only; a message never echoes what was typed where a variable NAME belongs.
import * as fs from 'node:fs';
import * as path from 'node:path';

import { TaskConfigLoader } from '@wadeck-app/task-core';

import { MIN_TOKEN_LENGTH } from './serverAuth.js';
import { TaskServerStartError } from './taskServer.js';

export const DEFAULT_TOKEN_ENV = 'TASK_SERVE_TOKEN';

export type TokenOrigin = { kind: 'env'; name: string } | { kind: 'file'; path: string };

export interface ServerTokenInput {
	tokenEnv?: string;
	tokenFile?: string;
	env: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	/** Permission bits of the file; default: what the file system reports (tests inject it). */
	mode?: (file: string) => number;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOW_TO_MAKE_ONE =
	"Create a long random token (for example: node -e \"process.stdout.write(require('crypto').randomBytes(32).toString('hex'))\") and give the SAME value to BOTH machines: here as the server's token, on the other machine in the variable (or file) named in the transport options of the project.";

function refuse(message: string, hint: string): never {
	throw new TaskServerStartError(message, hint);
}

function checked(value: string, from: string): string {
	if (/\s/.test(value))
		refuse(
			`${from} holds something that is not a token (it contains spaces or line breaks)`,
			'Put only the token in it.'
		);
	if (value.length < MIN_TOKEN_LENGTH) {
		refuse(
			`the token is too short (${value.length} characters; at least ${MIN_TOKEN_LENGTH} are required)`,
			HOW_TO_MAKE_ONE
		);
	}
	return value;
}

/**
 * A token typed where the variable NAME belongs is the likely mistake of `--token-env <value>`. A name is short and mostly upper case;
 * anything long, or lower case mixed with digits, is treated as a token and never printed.
 */
function looksLikeToken(text: string): boolean {
	return text.length >= 24 || (text.length >= 16 && /[a-z]/.test(text) && /[0-9]/.test(text));
}

export function resolveServerToken(input: ServerTokenInput): { token: string; origin: TokenOrigin } {
	if (input.tokenEnv !== undefined && input.tokenFile !== undefined) {
		refuse('give either --token-env or --token-file, not both', 'Keep the one you use.');
	}
	if (input.tokenFile !== undefined) {
		const file = TaskConfigLoader.expandTilde(input.tokenFile);
		if (!path.isAbsolute(file)) {
			refuse(
				`the token file ${input.tokenFile} is not an absolute path`,
				'Write the absolute path of the file, or one starting with ~/'
			);
		}
		let text: string;
		try {
			const mode = input.mode?.(file) ?? fs.statSync(file).mode;
			if ((input.platform ?? process.platform) !== 'win32' && (mode & 0o077) !== 0) {
				refuse(
					`the token file ${file} is readable by other users (mode ${(mode & 0o777).toString(8)})`,
					`Restrict it to your user: chmod 600 ${file}`
				);
			}
			text = fs.readFileSync(file, 'utf8');
		} catch (error) {
			if (error instanceof TaskServerStartError) throw error;
			return refuse(
				`the token file ${file} cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error)})`,
				`Write the token alone in ${file}, readable by you only. ${HOW_TO_MAKE_ONE}`
			);
		}
		const value = text.trim();
		if (value === '')
			refuse(`the token file ${file} is empty`, `Write the token alone in ${file}. ${HOW_TO_MAKE_ONE}`);
		return { token: checked(value, `the file ${file}`), origin: { kind: 'file', path: file } };
	}
	const name = input.tokenEnv ?? DEFAULT_TOKEN_ENV;
	const value = ENV_NAME.test(name) ? (input.env[name] ?? '').trim() : '';
	if (value === '') {
		if (looksLikeToken(name)) {
			refuse(
				'--token-env looks like a token: it takes the NAME of an environment variable, never the token itself',
				`Put the token in a variable (export ${DEFAULT_TOKEN_ENV}=<token>) and write: --token-env ${DEFAULT_TOKEN_ENV}. The NAME of an environment variable holds it, not the command line.`
			);
		}
		if (!ENV_NAME.test(name)) {
			refuse(
				`"${name}" is not an environment variable name (letters, digits and underscores, not starting with a digit)`,
				`It is the NAME of the variable that holds the token, for example --token-env ${DEFAULT_TOKEN_ENV}`
			);
		}
		refuse(
			`no token: the environment variable ${name} is not set`,
			`${HOW_TO_MAKE_ONE} Then: export ${name}=<token> (Windows: setx ${name} <token>, then open a new terminal), or keep it in a file and use --token-file <absolute path>.`
		);
	}
	return { token: checked(value, `the environment variable ${name}`), origin: { kind: 'env', name } };
}
