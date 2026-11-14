// Where the token of the github strategy comes from: the NAME of an environment variable, or the path of a file (design 2.1: the
// config never holds the token). The reading is shared with gitlab (`forge-common/forgeToken.ts`); this file says what GitHub needs.
import { resolveForgeToken } from '../forge-common/forgeToken.js';
import type { TokenWhere as CommonWhere } from '../forge-common/forgeToken.js';
import type { TokenSource } from './githubOptions.js';

export interface TokenWhere extends CommonWhere {
	repo: string;
}

/** The token, trimmed. Throws BackendAuthError (reason `missing`) naming where it should have been and how to provide it. */
export function resolveToken(source: TokenSource, env: NodeJS.ProcessEnv, where: TokenWhere): string {
	return resolveForgeToken(source, env, where, {
		backendKind: 'github',
		forgeName: 'GitHub',
		howToGetOne: set =>
			`Create a fine-grained token (GitHub > Settings > Developer settings > Fine-grained tokens) for ${where.repo} with the permissions Issues: Read and Metadata: Read. ${set} Then run: task strategy check`,
	});
}
