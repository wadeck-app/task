// Where the token of the github strategy comes from: the NAME of an environment variable, or the path of a file (design 2.1: the
// config never holds the token). A missing or unusable token is an error that names the project, the config file, the key and what
// to do; there is no anonymous fallback and no vendor CLI. The value never leaves this file except as the return value.
import * as fs from 'node:fs';
import * as path from 'node:path';

import { BackendAuthError, TaskConfigLoader } from '@wadeck-app/task-core';

import type { TokenSource } from './githubOptions.js';

export interface TokenWhere {
	/** The project's config file the strategy is written in. */
	source: string;
	project: string;
	repo: string;
	platform?: NodeJS.Platform;
	/** Permission bits of the file; default: what the file system reports (tests inject it). */
	mode?: (file: string) => number;
}

/** What to do about a token that cannot be used, shared by the messages below. */
function howToGetOne(where: TokenWhere, set: string): string {
	return `Create a fine-grained token (GitHub > Settings > Developer settings > Fine-grained tokens) for ${where.repo} with the permissions Issues: Read and Metadata: Read. ${set} Then run: task strategy check`;
}

/** The token, trimmed. Throws BackendAuthError (reason `missing`) naming where it should have been and how to provide it. */
export function resolveToken(source: TokenSource, env: NodeJS.ProcessEnv, where: TokenWhere): string {
	const label = `project "${where.project}", ${where.source}`;
	if (source.kind === 'env') {
		const value = (env[source.name] ?? '').trim();
		if (value === '') {
			throw new BackendAuthError(
				'github',
				'missing',
				`No GitHub token: the environment variable ${source.name} is not set (strategy.options.tokenEnv of ${label})`,
				howToGetOne(
					where,
					`Put it in ${source.name}: export ${source.name}=<token> (Windows: setx ${source.name} <token>, then open a new terminal).`
				)
			);
		}
		return checked(value, `the environment variable ${source.name}`, where);
	}
	const file = TaskConfigLoader.expandTilde(source.path);
	const fix = howToGetOne(where, `Write it alone in ${file}, readable by you only.`);
	if (!path.isAbsolute(file)) {
		throw new BackendAuthError(
			'github',
			'missing',
			`The token file ${source.path} is not an absolute path (strategy.options.tokenFile of ${label})`,
			'Write the absolute path of the file, or one starting with ~/'
		);
	}
	let text: string;
	try {
		const mode = where.mode?.(file) ?? fs.statSync(file).mode;
		if ((where.platform ?? process.platform) !== 'win32' && (mode & 0o077) !== 0) {
			throw new BackendAuthError(
				'github',
				'missing',
				`The token file ${file} is readable by other users (mode ${(mode & 0o777).toString(8)}) (strategy.options.tokenFile of ${label})`,
				`chmod 600 ${file}`
			);
		}
		text = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if (error instanceof BackendAuthError) throw error;
		throw new BackendAuthError(
			'github',
			'missing',
			`The token file ${file} cannot be read (strategy.options.tokenFile of ${label}): ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
			fix
		);
	}
	const value = text.trim();
	if (value === '') {
		throw new BackendAuthError(
			'github',
			'missing',
			`The token file ${file} is empty (strategy.options.tokenFile of ${label})`,
			fix
		);
	}
	return checked(value, `the file ${file}`, where);
}

function checked(value: string, from: string, where: TokenWhere): string {
	if (/\s/.test(value)) {
		throw new BackendAuthError(
			'github',
			'missing',
			`${from} holds something that is not a token (it contains spaces or line breaks)`,
			howToGetOne(where, 'Put only the token in it.')
		);
	}
	return value;
}
