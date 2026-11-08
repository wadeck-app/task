// The built-in transport `plain-http` (plugins.plain-http.default, alias plain-http): REGISTERED, options validated, not
// implemented. The real client arrives with the remote strategy (stage 4 of the storage design); until then opening it fails
// loudly, so a config naming it cannot be mistaken for a working one.
import { PluginNotImplementedError } from '../kinds.js';
import type { TransportPlugin } from '../kinds.js';

const KNOWN_OPTIONS = ['url', 'tokenEnv', 'timeoutSeconds'] as const;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function describeFound(value: unknown): string {
	return JSON.stringify(value) ?? String(value);
}

export const plainHttpPlugin: TransportPlugin = {
	extensionPoint: 'transport',

	validate(options) {
		for (const key of Object.keys(options)) {
			if (!(KNOWN_OPTIONS as readonly string[]).includes(key)) {
				return `${key}: unknown option for transport "plain-http" (known: ${KNOWN_OPTIONS.join(', ')})`;
			}
		}
		const { url, tokenEnv, timeoutSeconds } = options;
		if (url === undefined || url === '') {
			return 'url: required (the address of the task server, for example http://nas.lan:7788)';
		}
		if (typeof url !== 'string') return `url: must be a string, found ${describeFound(url)}`;
		let parsed: URL | undefined;
		try {
			parsed = new URL(url);
		} catch {
			parsed = undefined;
		}
		if (parsed === undefined || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
			return `url: "${url}" is not an http:// or https:// address`;
		}
		if (parsed.username !== '' || parsed.password !== '') {
			return 'url: must not contain credentials; the token is read from the environment variable named by tokenEnv';
		}
		if (tokenEnv === undefined || tokenEnv === '') {
			return 'tokenEnv: required (the NAME of the environment variable that holds the token, not the token)';
		}
		if (typeof tokenEnv !== 'string' || !ENV_NAME.test(tokenEnv)) {
			return `tokenEnv: ${describeFound(tokenEnv)} is not an environment variable name (letters, digits and underscores, not starting with a digit); it must be the NAME of the variable, never the token`;
		}
		if (timeoutSeconds !== undefined && (typeof timeoutSeconds !== 'number' || !(timeoutSeconds > 0))) {
			return `timeoutSeconds: must be a positive number of seconds, found ${describeFound(timeoutSeconds)}`;
		}
		return undefined;
	},

	describe() {
		return {
			summary: 'Plain HTTP(S) to a task server (not implemented yet: arrives with the remote strategy, stage 4).',
			options: {
				url: 'Address of the server, http:// or https://, no credentials in it (required)',
				tokenEnv: 'NAME of the environment variable that holds the bearer token (required)',
				timeoutSeconds: 'Per-request time limit in seconds (default 10)',
			},
			snippet:
				'transport:\n    type: plain-http\n    options:\n        url: http://nas.lan:7788\n        tokenEnv: TASK_REMOTE_TOKEN',
		};
	},

	create() {
		return Promise.reject(
			new PluginNotImplementedError(
				'plugins.plain-http.default',
				'stage 4 of the storage design',
				'Use "strategy: { type: local }" (or remove the strategy section) until the remote strategy ships.'
			)
		);
	},
};
