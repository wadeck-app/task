// The one HTTP client of the gitlab strategy: Node `fetch`, no vendor CLI (no glab), no SDK. Everything the strategy needs from the
// network is here so it is decided once: the token header, the read cache (memory, with ETag revalidation when the server sends
// one: UNVERIFIED that GitLab does), `Link` pagination, the rate-limit state (typed errors with a retry instant, never a busy
// retry), the typed failures with their hints, the stale fallback, a concurrency limit, and the guarantee that the token appears
// in no message and no log line. `fetch` and the clock are injectable: tests drive it against a fake server and a fake clock.
//
// NOT VERIFIED AGAINST A REAL GITLAB. Sources: docs.gitlab.com/api/rest (pagination, status codes), api/rest/authentication
// (`PRIVATE-TOKEN`), administration/settings/user_and_ip_rate_limits (`RateLimit-*`, `Retry-After`).
import {
	BackendAuthError,
	BackendDataError,
	BackendLimitError,
	BackendTimeoutError,
	BackendUnreachableError,
	RateLimitedError,
} from '@wadeck-app/task-core';

import type { ReadNotice } from '../kinds.js';

export interface GitLabClientOptions {
	/** No trailing slash: `https://gitlab.com/api/v4`, `https://HOST/api/v4`. */
	baseUrl: string;
	token: string;
	/** The project as written in the config, for the fix a message gives. */
	project: string;
	/** Where the token comes from, in words, for the fix of a refused token (`the environment variable GITLAB_TOKEN ...`). */
	tokenHint: string;
	timeoutMs: number;
	/** How long a read is served without asking GitLab; 0 = never. */
	cacheTtlMs: number;
	/** Pages a paginated read may walk before it fails loudly. Default 50. */
	maxPages?: number;
	/** Requests in flight at once. Default 6. */
	maxConcurrent?: number;
	now?: () => number;
	fetch?: typeof fetch;
	onNotice?: (notice: ReadNotice) => void;
	/** One line per request, without any header: what was asked, the status, the time, the quota left. */
	debug?: (line: string) => void;
	/** Least time between the start of two writes. Default 1000. */
	writeSpacingMs?: number;
	/** Longest `Retry-After` of a 429 that a write waits out; a longer one is a RateLimitedError at once. Default 15000. */
	maxRetryWaitMs?: number;
	/** Injectable wait (tests). */
	sleep?: (ms: number) => Promise<void>;
}

export interface GetOptions {
	query?: Record<string, string | number>;
	/** false: neither read nor write the cache. Default true. */
	cache?: boolean;
	/** A 404 is an answer (`status: 404`, no body) instead of an error. */
	allowNotFound?: boolean;
	/** true: skip the "served without asking" shortcut of the TTL and ask again (a re-read before a write). */
	revalidate?: boolean;
}

export interface ClientResponse<T> {
	status: number;
	/** Absent for an allowed 404. */
	body: T;
	/** Served from the cache (inside the TTL, or because GitLab could not be asked). */
	fromCache: boolean;
	/** Served from the cache BECAUSE GitLab could not be asked (offline, rate limited). */
	stale: boolean;
	/** When the server last confirmed this answer. */
	cachedAt: string;
	etag?: string;
	/** The next page: the `rel="next"` link, verbatim (or built from `x-next-page`). */
	next?: string;
}

export interface RateLimitState {
	limit: number;
	remaining: number;
	/** Epoch seconds. */
	resetAt: number;
}

/** GitLab answered with a status the client has no special meaning for (404 not expected, 409, 422...). */
export class GitLabHttpError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		readonly detail: string,
		message: string,
		/** The texts of the validation errors (`{"message": {"title": ["can't be blank"]}}` gives `title can't be blank`). */
		readonly errors: readonly string[] = []
	) {
		super(message);
		this.name = 'GitLabHttpError';
	}
}

/** GitLab answered 5xx: the request may or may not have been applied (for a write, read the issue again before saying anything). */
export class GitLabServerFailure extends BackendUnreachableError {
	constructor(
		host: string,
		readonly status: number,
		reason: string
	) {
		super('gitlab', host, reason);
	}
}

/** Hides the token in a text. */
export function redactToken(text: string, token: string): string {
	return token === '' ? text : text.split(token).join('***');
}

const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

interface Entry {
	url: string;
	etag?: string;
	cachedAt: string;
	body: unknown;
	next?: string;
}

interface Raw {
	status: number;
	headers: Headers;
	body: unknown;
}

export class GitLabClient {
	private readonly now: () => number;
	private readonly doFetch: typeof fetch;
	private readonly host: string;
	private readonly origin: string;
	private rate: RateLimitState | undefined;
	private inFlight = 0;
	private readonly waiting: Array<() => void> = [];
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly entries = new Map<string, Entry>();
	/** ISO instant of the last write: every answer read at or before it must be asked again. */
	private expiredAt: string | undefined;
	/** The writes wait for each other: this is the end of the last one queued. */
	private writeChain: Promise<unknown> = Promise.resolve();
	private lastWriteStartedAt: number | undefined;

	constructor(private readonly options: GitLabClientOptions) {
		this.sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
		this.now = options.now ?? Date.now;
		this.doFetch = options.fetch ?? fetch;
		const base = new URL(options.baseUrl);
		this.host = base.host;
		this.origin = base.origin;
	}

	/** What the last answer said about the quota; undefined before any answer (or when the instance sends no `RateLimit-*` header). */
	rateLimit(): RateLimitState | undefined {
		return this.rate === undefined ? undefined : { ...this.rate };
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

	/** One read of an absolute URL: a `Link` target. Only addresses under the base address are followed. */
	async getUrl<T>(url: string, options: GetOptions = {}): Promise<ClientResponse<T>> {
		this.requireOwnAddress(url);
		return this.request<T>(url, options);
	}

	/**
	 * Every item of a paginated list: follows the `Link: rel="next"` header verbatim (GitLab: "use only the supplied link") to the
	 * end. More pages than `maxPages` is a BackendLimitError. `stale` is true when any page came from the cache because GitLab could
	 * not be asked; `cachedAt` is then the oldest of those.
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
					'gitlab',
					'pages per read',
					maxPages,
					`${this.shortPath(next)} has more than ${maxPages} pages; raise strategy.options.maxPages in the project config (each page holds up to 100 items), or narrow what is read.`
				);
			}
			this.requireOwnAddress(next);
			const page: ClientResponse<T[]> = await this.request(next, options);
			pages += 1;
			items.push(...page.body);
			if (page.stale) {
				stale = true;
				if (oldest === undefined || page.cachedAt < oldest) oldest = page.cachedAt;
			}
			next = page.next;
		}
		return { items, stale, ...(oldest === undefined ? {} : { cachedAt: oldest }) };
	}

	/**
	 * One write (POST, PUT, DELETE) of a path under the base address. Writes go one at a time and at least `writeSpacingMs` apart; a
	 * 429 with a short `Retry-After` is waited out (the request was refused before it did anything, so sending it again is safe), a
	 * long one is a RateLimitedError. A 5xx or a lost connection is NOT retried: the write may have been applied, the caller reads
	 * the issue again to know. The read cache is expired afterwards.
	 */
	async write<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<ClientResponse<T>> {
		return this.serialized(() => this.writeNow<T>(method, this.urlOf(path), body));
	}

	private serialized<T>(task: () => Promise<T>): Promise<T> {
		const run = this.writeChain.then(async () => {
			const spacing = this.options.writeSpacingMs ?? 1000;
			if (this.lastWriteStartedAt !== undefined && spacing > 0) {
				const wait = spacing - (this.now() - this.lastWriteStartedAt);
				if (wait > 0) await this.sleep(wait);
			}
			this.lastWriteStartedAt = this.now();
			return task();
		});
		// The next write waits for this one whatever its outcome.
		this.writeChain = run.catch(() => undefined);
		return run;
	}

	private async writeNow<T>(method: string, url: string, body: unknown): Promise<ClientResponse<T>> {
		const stamp = new Date(this.now()).toISOString();
		const maxWait = this.options.maxRetryWaitMs ?? 15_000;
		try {
			for (let attempt = 0; ; attempt++) {
				try {
					const raw = await this.send(url, undefined, false, { method, body });
					return { status: raw.status, body: raw.body as T, fromCache: false, stale: false, cachedAt: stamp };
				} catch (error) {
					const wait =
						error instanceof RateLimitedError && error.scope === 'secondary' && error.retryAt !== undefined
							? error.retryAt.getTime() - this.now()
							: undefined;
					if (wait === undefined || attempt >= 2 || wait > maxWait) throw error;
					this.options.debug?.(
						`${method} ${this.shortPath(url)} -> 429, waiting ${Math.ceil(wait / 1000)} s before sending it again`
					);
					await this.sleep(Math.max(wait, 0));
					// The 429 carried `RateLimit-Remaining: 0` and a reset instant that may be a moment later than `Retry-After`; having
					// waited as the server asked, the retry must reach the server, not be refused here on that stale state.
					this.rate = undefined;
				}
			}
		} finally {
			// Whatever happened, what the cache holds may be out of date now.
			this.expiredAt = new Date(this.now()).toISOString();
		}
	}

	private requireOwnAddress(url: string): void {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new BackendDataError(
				'gitlab',
				'pagination',
				`GitLab sent a link that is not an address: ${this.redact(url)}`,
				'Retry; if it persists the service is misbehaving'
			);
		}
		const basePath = new URL(this.options.baseUrl).pathname.replace(/\/$/, '');
		if (parsed.origin !== this.origin || !parsed.pathname.startsWith(`${basePath}/`)) {
			throw new BackendDataError(
				'gitlab',
				'pagination',
				`GitLab sent a link to ${parsed.host}, which is not the configured address ${this.options.baseUrl}; it was not followed`,
				'Check strategy.options.baseUrl in the project config (the token is only ever sent there)'
			);
		}
	}

	private async request<T>(url: string, options: GetOptions): Promise<ClientResponse<T>> {
		const useCache = options.cache !== false;
		const entry = useCache ? this.entries.get(url) : undefined;
		const stamp = new Date(this.now()).toISOString();
		if (
			entry !== undefined &&
			options.revalidate !== true &&
			this.options.cacheTtlMs > 0 &&
			this.now() - Date.parse(entry.cachedAt) < this.options.cacheTtlMs &&
			// A write expired everything read before it: ask again.
			!this.expiredByWrite(entry)
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
				throw new GitLabHttpError(
					304,
					this.shortPath(url),
					'Not Modified',
					`GitLab answered 304 for GET ${this.shortPath(url)} which was not conditional`
				);
			}
			const renewed: Entry = { ...entry, cachedAt: stamp };
			this.entries.set(url, renewed);
			return this.fromEntry<T>(renewed, false);
		}
		if (raw.status === 404 && options.allowNotFound === true) {
			return { status: 404, body: undefined as T, fromCache: false, stale: false, cachedAt: stamp };
		}
		const etag = raw.headers.get('etag') ?? undefined;
		const next = this.nextLink(raw.headers, url);
		if (useCache && this.options.cacheTtlMs > 0) {
			this.entries.set(url, {
				url,
				...(etag === undefined ? {} : { etag }),
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

	private fromEntry<T>(entry: Entry, stale: boolean): ClientResponse<T> {
		return {
			status: 200,
			body: entry.body as T,
			fromCache: true,
			stale,
			cachedAt: entry.cachedAt,
			...(entry.etag === undefined ? {} : { etag: entry.etag }),
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

	/** The next page: `Link: <url>; rel="next"`, else (header absent) the `x-next-page` number applied to the current URL. */
	private nextLink(headers: Headers, current: string): string | undefined {
		const link = headers.get('link');
		if (link !== null) {
			for (const part of link.split(',')) {
				const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
				if (match !== null) return match[1];
			}
		}
		const nextPage = headers.get('x-next-page');
		if (nextPage !== null && /^\d+$/.test(nextPage)) {
			const next = new URL(current);
			next.searchParams.set('page', nextPage);
			return next.toString();
		}
		return undefined;
	}

	private recordRate(headers: Headers): void {
		const limit = Number(headers.get('ratelimit-limit'));
		const remaining = headers.get('ratelimit-remaining');
		const reset = Number(headers.get('ratelimit-reset'));
		if (remaining !== null && Number.isFinite(limit) && Number.isFinite(reset) && reset > 0) {
			this.rate = { limit, remaining: Number(remaining), resetAt: reset };
		}
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

	private expiredByWrite(entry: Entry): boolean {
		return this.expiredAt !== undefined && entry.cachedAt <= this.expiredAt;
	}

	private async send(
		url: string,
		etag: string | undefined,
		allowNotFound: boolean,
		write?: { method: string; body: unknown }
	): Promise<Raw> {
		const known = this.rate;
		if (known !== undefined && known.remaining <= 0 && this.now() < known.resetAt * 1000) {
			// No request while the quota is known to be empty: a retry loop would only make it worse.
			throw new RateLimitedError('gitlab', 'primary', new Date(known.resetAt * 1000));
		}
		await this.acquire();
		try {
			return await this.sendNow(url, etag, allowNotFound, write);
		} finally {
			this.release();
		}
	}

	private async sendNow(
		url: string,
		etag: string | undefined,
		allowNotFound: boolean,
		write?: { method: string; body: unknown }
	): Promise<Raw> {
		const method = write?.method ?? 'GET';
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
					method,
					...(write?.body === undefined ? {} : { body: JSON.stringify(write.body) }),
					redirect: 'manual',
					signal: controller.signal,
					headers: {
						// docs.gitlab.com/api/rest/authentication: `PRIVATE-TOKEN` is the recommended header.
						'private-token': this.options.token,
						accept: 'application/json',
						'user-agent': 'task-cli (gitlab strategy)',
						...(etag === undefined ? {} : { 'if-none-match': etag }),
						...(write?.body === undefined ? {} : { 'content-type': 'application/json' }),
					},
				});
				const location = response.headers.get('location');
				if (!REDIRECT_STATUSES.has(response.status) || location === null) break;
				// A renamed or moved project answers a redirect to its new address: followed, but only within the configured address.
				if (hops >= 3) break;
				current = new URL(location, current).toString();
				this.requireOwnAddress(current);
			}
		} catch (error) {
			clearTimeout(timer);
			if (timedOut) throw new BackendTimeoutError('gitlab', this.host, this.options.timeoutMs);
			if (error instanceof BackendDataError) throw error;
			const cause = (error as { cause?: { code?: string; message?: string } }).cause;
			const reason = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
			throw new BackendUnreachableError('gitlab', this.host, this.redact(String(reason)));
		}
		this.recordRate(response.headers);
		let text: string;
		try {
			// The time limit covers the body too: a server that sends the headers and stalls must not hang the command.
			text = await response.text();
		} catch (error) {
			if (timedOut) throw new BackendTimeoutError('gitlab', this.host, this.options.timeoutMs);
			throw new BackendUnreachableError(
				'gitlab',
				this.host,
				this.redact(error instanceof Error ? error.message : String(error))
			);
		} finally {
			clearTimeout(timer);
		}
		const remaining = response.headers.get('ratelimit-remaining');
		this.options.debug?.(
			`${method} ${this.shortPath(current)} -> ${response.status} (${Math.round(performance.now() - started)} ms${
				remaining === null ? '' : `, rate limit remaining ${remaining}`
			})`
		);
		return this.classify(current, response, text, allowNotFound, method);
	}

	/**
	 * The texts of an error body. GitLab sends `{"message": "404 Project Not Found"}`, `{"message": {"title": ["can't be blank"]}}`
	 * (validation: field -> messages) or `{"error": "..."}` (OAuth style); all three are read, none is trusted to be there.
	 */
	private errorTexts(body: unknown): { message: string; errors: string[] } {
		if (typeof body !== 'object' || body === null) return { message: '', errors: [] };
		const record = body as { message?: unknown; error?: unknown; error_description?: unknown };
		if (typeof record.message === 'string') return { message: this.redact(record.message), errors: [] };
		if (typeof record.message === 'object' && record.message !== null) {
			const errors: string[] = [];
			for (const [field, value] of Object.entries(record.message as Record<string, unknown>)) {
				const texts = Array.isArray(value) ? value : [value];
				for (const text of texts) {
					errors.push(this.redact(`${field} ${typeof text === 'string' ? text : JSON.stringify(text)}`));
				}
			}
			return { message: errors.join('; '), errors };
		}
		if (typeof record.error === 'string') {
			const description = typeof record.error_description === 'string' ? `: ${record.error_description}` : '';
			return { message: this.redact(`${record.error}${description}`), errors: [] };
		}
		return { message: '', errors: [] };
	}

	private classify(url: string, response: Response, text: string, allowNotFound: boolean, method: string): Raw {
		const path = this.shortPath(url);
		const status = response.status;
		const headers = response.headers;
		const writing = method !== 'GET';
		const scope = writing ? 'api' : 'read_api (or api)';
		let body: unknown;
		let parsed = true;
		if (text !== '') {
			try {
				body = JSON.parse(text);
			} catch {
				parsed = false;
			}
		}
		if (status === 304 || (status === 404 && allowNotFound)) return { status, headers, body: undefined };
		if (status >= 200 && status < 300) {
			if (!parsed) {
				throw new GitLabHttpError(
					status,
					path,
					'not JSON',
					this.redact(`GitLab answered ${status} for ${method} ${path} with something that is not JSON`)
				);
			}
			return { status, headers, body };
		}
		// A plain-text body (the 429 of the rate limiter: "Retry later") is the message itself.
		const found = parsed ? this.errorTexts(body) : { message: this.redact(text.slice(0, 200)), errors: [] };
		const detail = found.message;
		if (status === 401) {
			throw new BackendAuthError(
				'gitlab',
				'unauthenticated',
				`GitLab refused the token (401${detail === '' ? '' : ` ${detail}`})`,
				`Create or renew an access token with the scope ${scope} for ${this.options.project} (GitLab > Preferences > Access tokens, or the project's Settings > Access tokens), and put it in ${this.options.tokenHint}. An expired or revoked token gives this answer; task strategy check shows the expiry date.`
			);
		}
		if (status === 429) {
			const retryAfter = headers.get('retry-after');
			const seconds = retryAfter !== null && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) : undefined;
			throw new RateLimitedError(
				'gitlab',
				'secondary',
				seconds === undefined ? undefined : new Date(this.now() + seconds * 1000)
			);
		}
		if (status === 403) {
			const challenge = headers.get('www-authenticate') ?? '';
			if (/insufficient_scope/.test(challenge)) {
				throw new BackendAuthError(
					'gitlab',
					'forbidden',
					`GitLab refused the request: the token has not the scope this call needs (403 insufficient_scope)`,
					`Give the token the scope ${scope} (it is read from ${this.options.tokenHint}); a token with read_api can only read.`
				);
			}
			throw new BackendAuthError(
				'gitlab',
				'forbidden',
				`GitLab refused the request (403${detail === '' ? '' : ` ${detail}`})`,
				`The user of the token needs a role on ${this.options.project} that allows this (deleting an issue needs Planner or Owner, or being its author since GitLab 18.10), issues must be enabled in the project's settings, and the token needs the scope ${scope}. It is read from ${this.options.tokenHint}.`
			);
		}
		if (status >= 500) {
			throw new GitLabServerFailure(
				this.host,
				status,
				`answered HTTP ${status}${detail === '' ? '' : `: ${detail}`}`
			);
		}
		throw new GitLabHttpError(
			status,
			path,
			detail,
			`GitLab answered ${status} for ${method} ${path}${detail === '' ? '' : `: ${detail}`}`,
			found.errors
		);
	}
}
