// Where the token of a forge strategy comes from: the NAME of an environment variable, or the path of a file (design 2.1: the
// config never holds the token). A missing or unusable token is an error that names the project, the config file, the key and what
// to do; there is no anonymous fallback and no vendor CLI. The value never leaves this file except as the return value.
// Identical for github and gitlab: the forge supplies its name and how to get a token.
import * as fs from 'node:fs';
import * as path from 'node:path';

import { BackendAuthError, TaskConfigLoader } from '@wadeck-app/task-core';
import type { BackendKind } from '@wadeck-app/task-core';

/** Where the token is read from: the NAME of a variable, or an absolute path (or `~/...`). */
export type TokenSource = { kind: 'env'; name: string } | { kind: 'file'; path: string };

export interface TokenWhere {
	/** The project's config file the strategy is written in. */
	source: string;
	/** The name of the task project. */
	project: string;
	platform?: NodeJS.Platform;
	/** Permission bits of the file; default: what the file system reports (tests inject it). */
	mode?: (file: string) => number;
}

export interface ForgeTokenRules {
	backendKind: BackendKind;
	/** The forge as a person writes it (`GitHub`). */
	forgeName: string;
	/** What to do about a token that cannot be used; `set` is the step of this situation, put inside the sentence. */
	howToGetOne: (set: string) => string;
}

/** The token, trimmed. Throws BackendAuthError (reason `missing`) naming where it should have been and how to provide it. */
export function resolveForgeToken(
	source: TokenSource,
	env: NodeJS.ProcessEnv,
	where: TokenWhere,
	rules: ForgeTokenRules
): string {
	const { backendKind, forgeName, howToGetOne } = rules;
	const label = `project "${where.project}", ${where.source}`;
	if (source.kind === 'env') {
		const value = (env[source.name] ?? '').trim();
		if (value === '') {
			throw new BackendAuthError(
				backendKind,
				'missing',
				`No ${forgeName} token: the environment variable ${source.name} is not set (strategy.options.tokenEnv of ${label})`,
				howToGetOne(
					`Put it in ${source.name}: export ${source.name}=<token> (Windows: setx ${source.name} <token>, then open a new terminal).`
				)
			);
		}
		return checked(value, `the environment variable ${source.name}`, rules);
	}
	const file = TaskConfigLoader.expandTilde(source.path);
	const fix = howToGetOne(`Write it alone in ${file}, readable by you only.`);
	if (!path.isAbsolute(file)) {
		throw new BackendAuthError(
			backendKind,
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
				backendKind,
				'missing',
				`The token file ${file} is readable by other users (mode ${(mode & 0o777).toString(8)}) (strategy.options.tokenFile of ${label})`,
				`chmod 600 ${file}`
			);
		}
		text = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if (error instanceof BackendAuthError) throw error;
		throw new BackendAuthError(
			backendKind,
			'missing',
			`The token file ${file} cannot be read (strategy.options.tokenFile of ${label}): ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
			fix
		);
	}
	const value = text.trim();
	if (value === '') {
		throw new BackendAuthError(
			backendKind,
			'missing',
			`The token file ${file} is empty (strategy.options.tokenFile of ${label})`,
			fix
		);
	}
	return checked(value, `the file ${file}`, rules);
}

function checked(value: string, from: string, rules: ForgeTokenRules): string {
	if (/\s/.test(value)) {
		throw new BackendAuthError(
			rules.backendKind,
			'missing',
			`${from} holds something that is not a token (it contains spaces or line breaks)`,
			rules.howToGetOne('Put only the token in it.')
		);
	}
	return value;
}
