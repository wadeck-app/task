// The instance of the plain-http transport: one request = one exchange, bounded by the time limit from the first byte sent to the last
// byte received (the body is read here, so a server that stalls after its headers also times out). Redirects are never followed (the
// bearer token must not go to another address). Network failures become the typed errors of the remote strategy.
import { PROTOCOL_HEADER, PROTOCOL_VERSION, RemoteTimeoutError, RemoteUnreachableError } from '@wadeck-app/task-core';

import type { TransportContext, TransportInstance } from '../kinds.js';
import type { PlainHttpSettings } from './plainHttpPlugin.js';

/** What a failed `fetch` says, as one phrase: the code and the message of its cause (undici hides them one level down). */
function describeNetworkFailure(error: unknown): string {
	const cause = (error as { cause?: unknown } | undefined)?.cause;
	const source = (cause instanceof Error ? cause : error) as Error & { code?: string };
	const code = source.code;
	const message = source.message;
	if (code !== undefined && !message.includes(code)) return `${code}: ${message}`;
	return message;
}

function tokenSentence(settings: PlainHttpSettings): string {
	return settings.token.kind === 'env'
		? `the environment variable ${settings.token.name} (tokenEnv)`
		: `the file ${settings.token.path} (tokenFile)`;
}

export function createPlainHttpTransport(
	settings: PlainHttpSettings,
	token: string,
	context: TransportContext
): TransportInstance {
	const doFetch = context.fetch ?? fetch;
	const timers = context.timers ?? { setTimeout, clearTimeout };
	const timeoutMs = settings.timeoutSeconds * 1000;
	const host = RemoteUnreachableError.hostOf(settings.baseUrl);
	const inFlight = new Set<AbortController>();
	let closed = false;

	const headers = (): Record<string, string> => ({
		Authorization: `Bearer ${token}`,
		[PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
		Accept: 'application/json',
	});

	return {
		baseUrl: settings.baseUrl,
		headers,

		async fetch(path, init = {}) {
			if (closed) throw new Error('the connection to the task server was closed; open the project again');
			const method = init.method ?? 'GET';
			const controller = new AbortController();
			inFlight.add(controller);
			let timedOut = false;
			const timer = timers.setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, timeoutMs);
			try {
				const response = await doFetch(`${settings.baseUrl}${path}`, {
					method,
					headers: { ...headers(), ...init.headers },
					...(init.body === undefined ? {} : { body: init.body }),
					redirect: 'manual',
					signal: controller.signal,
				});
				if (response.status >= 300 && response.status < 400) {
					const location = response.headers.get('location');
					await response.body?.cancel().catch(() => undefined);
					throw new RemoteUnreachableError(
						settings.baseUrl,
						`answered a redirect (HTTP ${response.status})${location === null ? '' : ` to ${location}`}; task never follows redirects, the token would be sent to the other address. Put the final address in the url option`
					);
				}
				// Read here, inside the time limit: a server that sends its headers and stalls must time out too.
				const body = await response.arrayBuffer();
				return new Response(body.byteLength === 0 ? null : body, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			} catch (error) {
				if (error instanceof RemoteUnreachableError) throw error;
				if (timedOut) throw new RemoteTimeoutError(host, timeoutMs, method === 'GET' ? 'read' : 'write');
				if (closed)
					throw new Error('the connection to the task server was closed while a request was in flight');
				throw new RemoteUnreachableError(settings.baseUrl, describeNetworkFailure(error));
			} finally {
				timers.clearTimeout(timer);
				inFlight.delete(controller);
			}
		},

		describe: () => [
			`url: ${settings.baseUrl}`,
			`timeout: ${settings.timeoutSeconds} s per request`,
			`token: ${tokenSentence(settings)}`,
		],

		dispose() {
			closed = true;
			for (const controller of inFlight) controller.abort();
			return Promise.resolve();
		},
	};
}
