// Where the token of the gitlab strategy comes from: the NAME of an environment variable, or the path of a file (design 2.1: the
// config never holds the token). The reading is shared with github (`forge-common/forgeToken.ts`); this file says what GitLab needs.
import { resolveForgeToken } from '../forge-common/forgeToken.js';
import type { TokenWhere as CommonWhere } from '../forge-common/forgeToken.js';
import type { TokenSource } from './gitlabOptions.js';

export interface TokenWhere extends CommonWhere {
	/** The GitLab project as written in the config (path or id), for the fix. */
	gitlabProject: string;
}

/** The token, trimmed. Throws BackendAuthError (reason `missing`) naming where it should have been and how to provide it. */
export function resolveToken(source: TokenSource, env: NodeJS.ProcessEnv, where: TokenWhere): string {
	return resolveForgeToken(source, env, where, {
		backendKind: 'gitlab',
		forgeName: 'GitLab',
		howToGetOne: set =>
			`Create an access token (GitLab > Preferences > Access tokens, or the project's Settings > Access tokens) for ${where.gitlabProject} with the scope api (read_api is enough to read only). ${set} Then run: task strategy check`,
	});
}
