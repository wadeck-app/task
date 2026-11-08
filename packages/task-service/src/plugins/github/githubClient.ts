// The one HTTP client of the github strategy: reads only, Node `fetch`, no vendor CLI, no octokit. Everything the strategy needs
// from the network is here so it is decided once: the token header, ETag revalidation and the read-through cache, `Link` pagination,
// the rate-limit state (typed errors with a retry instant, never a busy retry), the typed failures with their hints, the stale
// fallback, a concurrency limit, and the guarantee that the token appears in no message, no log line and no cache file.
// `fetch` and the clock are injectable: tests drive it against a fake server and a fake clock.
import {
	BackendAuthError,
	BackendDataError,
	BackendLimitError,
	BackendTimeoutError,
	BackendUnreachableError,
	RateLimitedError,
} from '@wadeck-app/task-core';

import type { ReadNotice } from '../kinds.js';
import type { CacheEntry, ResponseCache } from './responseCache.js';

export interface GitHubClientOptions {
	/** No trailing slash: `https://api.github.com`, `https://HOST/api/v3`. */
	baseUrl: string;
	token: string;
	/** `owner/name`, for the fix a message gives. */
	repo: string;
	/** Where the token comes from, in words, for the fix of a refused token (`the environment variable GITHUB_TOKEN ...`). */
	tokenHint: string;
	timeoutMs: number;
	/** How long a cached answer is served without asking GitHub; 0 = always revalidate. */
	cacheTtlMs: number;
	cache: ResponseCache;
	/** Pages a paginated read may walk before it fails loudly. Default 50. */
	maxPages?: number;
	/** Requests in flight at once. Default 6 (GitHub allows 100; a CLI has no use for more). */
	maxConcurrent?: number;
	now?: () => number;
	fetch?: typeof fetch;
	onNotice?: (notice: ReadNotice) => void;
	/** One line per request, without any header: what was asked, the status, the time, the quota left. */
	debug?: (line: string) => void;
}

export interface GetOptions {
	query?: Record<string, string | number>;
	/** false: neither read nor write the cache (search results lag, so they are never cached). Default true. */
	cache?: boolean;
	/** A 404 is an answer (`status: 404`, no body) instead of an error. */
	allowNotFound?: boolean;
}

export interface ClientResponse<T> {
	status: number;
	/** Absent for an allowed 404. */
	body: T;
	/** Served from the cache (inside the TTL, or because GitHub could not be asked). */
	fromCache: boolean;
	/** Served from the cache BECAUSE GitHub could not be asked (offline, rate limited). */
	stale: boolean;
	/** When the server last confirmed this answer. */
	cachedAt: string;
	etag?: string;
	/** The `rel="next"` link, verbatim. */
	next?: string;
}

export interface RateLimitState {
	limit: number;
	remaining: number;
	/** Epoch seconds. */
	resetAt: number;
}

/** GitHub answered with a status the client has no special meaning for (404 not expected, 410, 422...). */
export class GitHubHttpError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		readonly detail: string,
		message: string
	) {
		super(message);
		this.name = 'GitHubHttpError';
	}
}

/** Hides the token, and any `Bearer` credential, in a text. */
export function redactToken(text: string, token: string): string {
	return token === '' ? text : text.split(token).join('***');
}

const API_VERSION = '2022-11-28';
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

interface Raw {
	status: number;
	headers: Headers;
	body: unknown;
}

export class GitHubClient {
	private readonly now: () => number;
	private readonly doFetch: typeof fetch;
	private readonly host: string;
	private readonly origin: string;
	private readonly rates = new Map<string, RateLimitState>();
	private tokenExpiration: string | undefined;
	private inFlight = 0;
	private readonly waiting: Array<() => void> = [];

	constructor(private readonly options: GitHubClientOptions) {
		this.now = options.now ?? Date.now;
		this.doFetch = options.fetch ?? fetch;
		const base = new URL(options.baseUrl);
		this.host = base.host;
		this.origin = base.origin;
	}

	/** What the last answer of a bucket (`core`, `search`) said about the quota; undefined before any answer. */
	rateLimit(resource: string): RateLimitState | undefined {
		const state = this.rates.get(resource);
		return state === undefined ? undefined : { ...state };
	}

	/** Value of `github-authentication-token-expiration` of the last answer, when GitHub sent one. */
	tokenExpiresAt(): string | undefined {
		return this.tokenExpiration;
	}

	private redact(text: string): string {
		return redactToken(text, this.options.token);
	}

	private urlOf(path: string, query?: Record<string, string | number>): string {
		const url = new URL(`${this.options.baseUrl}${path}`);
		if (query !== undefined) {
			for (const key of Object.keys(query).sort()) url.searchParams.set(key, String(query[key]));
		}
		return url.toString();
	}

	/** The path of an absolute URL relative to the base address, for messages and logs. */
	private shortPath(url: string): string {
		const parsed = new URL(url);
		const base = new URL(this.options.baseUrl).pathname.replace(/\/$/, '');
		return `${parsed.pathname.startsWith(base) ? parsed.pathname.slice(base.length) : parsed.pathname}${parsed.search}`;
	}

	/** One read of a path under the base address. */
	async get<T>(path: string, options: GetOptions = {}): Promise<ClientResponse<T>> {
		return this.request<T>(this.urlOf(path, options.query), options);
	}

	/** One read of an absolute URL: a `Link` target or a cursor. Only addresses under the base address are followed. */
	async getUrl<T>(url: string, options: GetOptions = {}): Promise<ClientResponse<T>> {
		this.requireOwnAddress(url);
		return this.request<T>(url, options);
	}

	/**
	 * Every item of a paginated list: follows `rel="next"` verbatim to the end. More pages than `maxPages` is a BackendLimitError.
	 * `stale` is true when any page came from the cache because GitHub could not be asked; `cachedAt` is then the oldest of those.
	 */
	async getAll<T>(
		path: string,
		options: GetOptions & { maxPages?: number } = {}
	): Promise<{ items: T[]; stale: boolean; cachedAt?: string }> {
		const maxPages = options.maxPages ?? this.options.maxPages ?? 50;
		const items: T[] = [];
		let stale = false;
		let oldest: string | undefined;
		let next: string | undefined = this.urlOf(path, options.query);
		let pages = 0;
		while (next !== undefined) {
			if (pages >= maxPages) {
				throw new BackendLimitError(
					'github',
					'pages per read',
					maxPages,
					`${this.shortPath(next)} has more than ${maxPages} pages; raise strategy.options.maxPages in the project config (each page holds up to 100 items), or narrow what is read.`
				);
			}
			this.requireOwnAddress(next);
			const page: ClientResponse<T[] | { items: T[] }> = await this.request(next, options);
			pages += 1;
			items.push(...(Array.isArray(page.body) ? page.body : page.body.items));
			if (page.stale) {
				stale = true;
				if (oldest === undefined || page.cachedAt < oldest) oldest = page.cachedAt;
			}
			next = page.next;
		}
		return { items, stale, ...(oldest === undefined ? {} : { cachedAt: oldest }) };
	}

	private requireOwnAddress(url: string): void {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new BackendDataError(
				'github',
				'pagination',
				`GitHub sent a link that is not an address: ${this.redact(url)}`,
				'Retry; if it persists the service is misbehaving'
			);
		}
		const basePath = new URL(this.options.baseUrl).pathname.replace(/\/$/, '');
		if (parsed.origin !== this.origin || !parsed.pathname.startsWith(`${basePath}/`)) {
			throw new BackendDataError(
				'github',
				'pagination',
				`GitHub sent a link to ${parsed.host}, which is not the configured address ${this.options.baseUrl}; it was not followed`,
				'Check strategy.options.baseUrl in the project config (the token is only ever sent there)'
			);
		}
	}

	private async request<T>(url: string, options: GetOptions): Promise<ClientResponse<T>> {
		const useCache = options.cache !== false;
		const entry = useCache ? this.options.cache.get(url) : undefined;
		const stamp = new Date(this.now()).toISOString();
		if (
			entry !== undefined &&
			this.options.cacheTtlMs > 0 &&
			this.now() - Date.parse(entry.cachedAt) < this.options.cacheTtlMs
		) {
			this.options.debug?.(`GET ${this.shortPath(url)} -> cache (read ${entry.cachedAt})`);
			return this.fromEntry<T>(entry, false);
		}
		let raw: Raw;
		try {
			raw = await this.send(url, entry?.etag, options.allowNotFound === true);
		} catch (error) {
			if (entry !== undefined && this.canServeStale(error)) {
				this.options.onNotice?.({
					kind: 'stale',
					text: `${this.redact((error as Error).message)}; showing what was read on ${entry.cachedAt} (${this.shortPath(url)})`,
					cachedAt: entry.cachedAt,
				});
				return this.fromEntry<T>(entry, true);
			}
			throw error;
		}
		if (raw.status === 304) {
			if (entry === undefined) {
				throw new GitHubHttpError(
					304,
					this.shortPath(url),
					'Not Modified',
					`GitHub answered 304 for GET ${this.shortPath(url)} which was not conditional`
				);
			}
			const renewed: CacheEntry = { ...entry, cachedAt: stamp };
			this.options.cache.put(renewed);
			return this.fromEntry<T>(renewed, false);
		}
		if (raw.status === 404 && options.allowNotFound === true) {
			return { status: 404, body: undefined as T, fromCache: false, stale: false, cachedAt: stamp };
		}
		const etag = raw.headers.get('etag') ?? undefined;
		const next = this.nextLink(raw.headers.get('link'));
		if (useCache && etag !== undefined) {
			this.options.cache.put({
				url,
				etag,
				cachedAt: stamp,
				body: raw.body,
				...(next === undefined ? {} : { next }),
			});
		}
		return {
			status: raw.status,
			body: raw.body as T,
			fromCache: false,
			stale: false,
			cachedAt: stamp,
			...(etag === undefined ? {} : { etag }),
			...(next === undefined ? {} : { next }),
		};
	}

	private fromEntry<T>(entry: CacheEntry, stale: boolean): ClientResponse<T> {
		return {
			status: 200,
			body: entry.body as T,
			fromCache: true,
			stale,
			cachedAt: entry.cachedAt,
			etag: entry.etag,
			...(entry.next === undefined ? {} : { next: entry.next }),
		};
	}

	/** Failures after which the last answer is still worth showing; a refused token or a bad request is not one of them. */
	private canServeStale(error: unknown): boolean {
		return (
			error instanceof BackendUnreachableError ||
			error instanceof BackendTimeoutError ||
			error instanceof RateLimitedError
		);
	}

	private nextLink(header: string | null): string | undefined {
		if (header === null) return undefined;
		for (const part of header.split(',')) {
			const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
			if (match !== null) return match[1];
		}
		return undefined;
	}

	private resourceOf(url: string): string {
		return new URL(url).pathname
			.replace(new URL(this.options.baseUrl).pathname.replace(/\/$/, ''), '')
			.startsWith('/search')
			? 'search'
			: 'core';
	}

	private recordRate(headers: Headers): void {
		const limit = Number(headers.get('x-ratelimit-limit'));
		const remaining = headers.get('x-ratelimit-remaining');
		const reset = Number(headers.get('x-ratelimit-reset'));
		if (remaining !== null && Number.isFinite(limit) && Number.isFinite(reset)) {
			this.rates.set(headers.get('x-ratelimit-resource') ?? 'core', {
				limit,
				remaining: Number(remaining),
				resetAt: reset,
			});
		}
		this.tokenExpiration = headers.get('github-authentication-token-expiration') ?? this.tokenExpiration;
	}

	private async acquire(): Promise<void> {
		const max = this.options.maxConcurrent ?? 6;
		if (this.inFlight < max) {
			this.inFlight += 1;
			return;
		}
		await new Promise<void>(resolve => this.waiting.push(resolve));
	}

	private release(): void {
		const next = this.waiting.shift();
		if (next === undefined) this.inFlight -= 1;
		else next();
	}

	private async send(url: string, etag: string | undefined, allowNotFound: boolean): Promise<Raw> {
		const resource = this.resourceOf(url);
		const known = this.rates.get(resource);
		if (known !== undefined && known.remaining <= 0 && this.now() < known.resetAt * 1000) {
			// No request while the quota is known to be empty: a retry loop would only burn the secondary limit.
			throw new RateLimitedError(
				'github',
				resource === 'search' ? 'search' : 'primary',
				new Date(known.resetAt * 1000)
			);
		}
		await this.acquire();
		try {
			return await this.sendNow(url, etag, allowNotFound);
		} finally {
			this.release();
		}
	}

	private async sendNow(url: string, etag: string | undefined, allowNotFound: boolean): Promise<Raw> {
		const started = performance.now();
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.options.timeoutMs);
		let current = url;
		let response: Response | undefined;
		try {
			for (let hops = 0; ; hops++) {
				response = await this.doFetch(current, {
					method: 'GET',
					redirect: 'manual',
					signal: controller.signal,
					headers: {
						authorization: `Bearer ${this.options.token}`,
						accept: 'application/vnd.github+json',
						'x-github-api-version': API_VERSION,
						'user-agent': 'task-cli (github strategy)',
						...(etag === undefined ? {} : { 'if-none-match': etag }),
					},
				});
				const location = response.headers.get('location');
				if (!REDIRECT_STATUSES.has(response.status) || location === null) break;
				// A renamed or moved repository answers 301 to its new address: followed, but only within the configured address.
				if (hops >= 3) break;
				current = new URL(location, current).toString();
				this.requireOwnAddress(current);
			}
		} catch (error) {
			clearTimeout(timer);
			if (timedOut) throw new BackendTimeoutError('github', this.host, this.options.timeoutMs);
			if (error instanceof BackendDataError) throw error;
			const cause = (error as { cause?: { code?: string; message?: string } }).cause;
			const reason = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
			throw new BackendUnreachableError('github', this.host, this.redact(String(reason)));
		}
		this.recordRate(response.headers);
		let text: string;
		try {
			// The time limit covers the body too: a server that sends the headers and stalls must not hang the command.
			text = await response.text();
		} catch (error) {
			if (timedOut) throw new BackendTimeoutError('github', this.host, this.options.timeoutMs);
			throw new BackendUnreachableError(
				'github',
				this.host,
				this.redact(error instanceof Error ? error.message : String(error))
			);
		} finally {
			clearTimeout(timer);
		}
		const remaining = response.headers.get('x-ratelimit-remaining');
		this.options.debug?.(
			`GET ${this.shortPath(current)} -> ${response.status} (${Math.round(performance.now() - started)} ms${
				remaining === null ? '' : `, rate limit remaining ${remaining}`
			})`
		);
		return this.classify(current, response, text, allowNotFound);
	}

	private classify(url: string, response: Response, text: string, allowNotFound: boolean): Raw {
		const path = this.shortPath(url);
		const status = response.status;
		const headers = response.headers;
		let body: unknown;
		let message = '';
		if (text !== '') {
			try {
				body = JSON.parse(text);
				message =
					typeof (body as { message?: unknown })?.message === 'string'
						? (body as { message: string }).message
						: '';
			} catch {
				body = undefined;
				message = text.slice(0, 200);
			}
		}
		if (status === 304 || (status === 404 && allowNotFound)) return { status, headers, body: undefined };
		if (status >= 200 && status < 300) {
			if (body === undefined && text !== '') {
				throw new GitHubHttpError(
					status,
					path,
					'not JSON',
					this.redact(`GitHub answered ${status} for GET ${path} with something that is not JSON`)
				);
			}
			return { status, headers, body };
		}
		const detail = this.redact(message);
		if (status === 401) {
			throw new BackendAuthError(
				'github',
				'unauthenticated',
				`GitHub refused the token (401${detail === '' ? '' : ` ${detail}`})`,
				`Create or renew a fine-grained token with Issues: Read and Metadata: Read on ${this.options.repo}, and put it in ${this.options.tokenHint}. An expired or revoked token gives this answer; task strategy check shows the expiry date.`
			);
		}
		if (status === 403 || status === 429) {
			const resource = headers.get('x-ratelimit-resource') ?? 'core';
			const remaining = headers.get('x-ratelimit-remaining');
			const retryAfter = headers.get('retry-after');
			const reset = headers.get('x-ratelimit-reset');
			if (remaining === '0' && reset !== null) {
				throw new RateLimitedError(
					'github',
					resource === 'search' ? 'search' : 'primary',
					new Date(Number(reset) * 1000)
				);
			}
			if (retryAfter !== null && Number.isFinite(Number(retryAfter))) {
				throw new RateLimitedError('github', 'secondary', new Date(this.now() + Number(retryAfter) * 1000));
			}
			if (status === 429 || /rate limit/i.test(message)) {
				throw new RateLimitedError('github', 'secondary', undefined);
			}
			const needed = headers.get('x-accepted-github-permissions');
			throw new BackendAuthError(
				'github',
				'forbidden',
				`GitHub refused the request (403${detail === '' ? '' : ` ${detail}`})`,
				`The token needs ${needed === null ? 'Issues: Read and Metadata: Read' : `these permissions (${needed})`} on ${this.options.repo}; edit the token in GitHub (Settings > Developer settings > Fine-grained tokens), or use one that has them. It is read from ${this.options.tokenHint}.`
			);
		}
		if (status >= 500) {
			throw new BackendUnreachableError(
				'github',
				this.host,
				`answered HTTP ${status}${detail === '' ? '' : `: ${detail}`}`
			);
		}
		throw new GitHubHttpError(
			status,
			path,
			detail,
			`GitHub answered ${status} for GET ${path}${detail === '' ? '' : `: ${detail}`}`
		);
	}
}
