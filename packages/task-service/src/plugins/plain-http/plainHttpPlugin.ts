// The built-in transport `plain-http` (plugins.plain-http.default, alias plain-http): how bytes reach a task server (design 3.1).
// Address, bearer token, time limit, no redirect. It never parses protocol payloads; the remote backend does. Plain HTTP on purpose
// in v1 (trusted LAN): an `https://` address is accepted for a wrapper (reverse proxy, tunnel) that provides TLS, nothing here does.
import type { TransportPlugin } from '../kinds.js';
import { createPlainHttpTransport } from './plainHttpTransport.js';
import { resolveToken } from './transportToken.js';
import type { TokenSource } from './transportToken.js';

const KNOWN_OPTIONS = ['url', 'tokenEnv', 'tokenFile', 'timeoutSeconds'] as const;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const DEFAULT_TIMEOUT_SECONDS = 10;

function describeFound(value: unknown): string {
	return JSON.stringify(value) ?? String(value);
}

export interface PlainHttpSettings {
	/** Without a trailing slash. */
	baseUrl: string;
	token: TokenSource;
	timeoutSeconds: number;
}

/** The settings of valid options, or the first problem as a sentence that starts with the dotted key. */
export function parsePlainHttpOptions(
	options: Record<string, unknown>
): { settings: PlainHttpSettings } | { problem: string } {
	for (const key of Object.keys(options)) {
		if (!(KNOWN_OPTIONS as readonly string[]).includes(key)) {
			return {
				problem: `${key}: unknown option for transport "plain-http" (known: ${KNOWN_OPTIONS.join(', ')})`,
			};
		}
	}
	const { url, tokenEnv, tokenFile, timeoutSeconds } = options;
	if (url === undefined || url === '') {
		return { problem: 'url: required (the address of the task server, for example http://nas.lan:7788)' };
	}
	if (typeof url !== 'string') return { problem: `url: must be a string, found ${describeFound(url)}` };
	let parsed: URL | undefined;
	try {
		parsed = new URL(url);
	} catch {
		parsed = undefined;
	}
	if (parsed === undefined || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
		return { problem: `url: "${url}" is not an http:// or https:// address` };
	}
	if (parsed.username !== '' || parsed.password !== '') {
		return {
			problem:
				'url: must not contain credentials; the token is read from the environment variable named by tokenEnv (or the file named by tokenFile)',
		};
	}
	if (tokenEnv !== undefined && tokenFile !== undefined) {
		return { problem: 'tokenFile: give either tokenEnv or tokenFile, not both' };
	}
	let token: TokenSource;
	if (tokenFile !== undefined) {
		if (typeof tokenFile !== 'string' || tokenFile === '') {
			return { problem: `tokenFile: must be the path of a file, found ${describeFound(tokenFile)}` };
		}
		token = { kind: 'file', path: tokenFile };
	} else {
		if (tokenEnv === undefined || tokenEnv === '') {
			return {
				problem:
					'tokenEnv: required (the NAME of the environment variable that holds the token, not the token; or tokenFile: the path of a file that holds it)',
			};
		}
		if (typeof tokenEnv !== 'string' || !ENV_NAME.test(tokenEnv)) {
			return {
				problem: `tokenEnv: ${describeFound(tokenEnv)} is not an environment variable name (letters, digits and underscores, not starting with a digit); it must be the NAME of the variable, never the token`,
			};
		}
		token = { kind: 'env', name: tokenEnv };
	}
	if (timeoutSeconds !== undefined && (typeof timeoutSeconds !== 'number' || !(timeoutSeconds > 0))) {
		return {
			problem: `timeoutSeconds: must be a positive number of seconds, found ${describeFound(timeoutSeconds)}`,
		};
	}
	const basePath = parsed.pathname.replace(/\/+$/, '');
	return {
		settings: {
			baseUrl: `${parsed.origin}${basePath}`,
			token,
			timeoutSeconds: typeof timeoutSeconds === 'number' ? timeoutSeconds : DEFAULT_TIMEOUT_SECONDS,
		},
	};
}

export const plainHttpPlugin: TransportPlugin = {
	extensionPoint: 'transport',

	validate(options) {
		const parsed = parsePlainHttpOptions(options);
		return 'problem' in parsed ? parsed.problem : undefined;
	},

	describe() {
		return {
			summary:
				'Plain HTTP(S) to a task server (task serve): a bearer token, a time limit, no redirect. Plain HTTP is readable on the network: trusted LAN only (TLS and tunnels are deferred).',
			options: {
				url: 'Address of the server, http:// or https://, no credentials in it (required)',
				tokenEnv: 'NAME of the environment variable that holds the bearer token (required, or tokenFile)',
				tokenFile: 'path of a file that holds the token (instead of tokenEnv); POSIX: readable by you only',
				timeoutSeconds: `Time limit of one request in seconds (default ${DEFAULT_TIMEOUT_SECONDS})`,
			},
			snippet:
				'transport:\n    type: plain-http\n    options:\n        url: http://nas.lan:7788\n        tokenEnv: TASK_REMOTE_TOKEN',
		};
	},

	create(options, context) {
		const parsed = parsePlainHttpOptions(options);
		if ('problem' in parsed) return Promise.reject(new Error(parsed.problem));
		try {
			// The token is read now: a missing one fails the first use with its own message, never with a 401 from the server.
			const token = resolveToken(parsed.settings.token, context.env);
			return Promise.resolve(createPlainHttpTransport(parsed.settings, token, context));
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
	},
};
