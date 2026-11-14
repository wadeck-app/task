// The small mechanisms the HTTP clients of github and gitlab share: token redaction, the limit on requests in flight, the queue that
// spaces writes, the address helpers and the refusal of a link that leaves the configured address. Rate limits, caches and the
// typed failures differ between the forges and stay in each client.
import { BackendDataError } from '@wadeck-app/task-core';
import type { BackendKind } from '@wadeck-app/task-core';

/** Hides the token in a text. */
export function redactToken(text: string, token: string): string {
	return token === '' ? text : text.split(token).join('***');
}

export const realSleep = (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms));

/** At most `max` holders at a time; the others wait their turn in arrival order. */
export class SlotLimiter {
	private inFlight = 0;
	private readonly waiting: Array<() => void> = [];

	constructor(private readonly max: number) {}

	async acquire(): Promise<void> {
		if (this.inFlight < this.max) {
			this.inFlight += 1;
			return;
		}
		await new Promise<void>(resolve => this.waiting.push(resolve));
	}

	release(): void {
		const next = this.waiting.shift();
		if (next === undefined) this.inFlight -= 1;
		else next();
	}
}

/** The writes wait for each other (one in flight) and start at least `spacingMs` apart, whatever the outcome of the one before. */
export class WriteSerializer {
	/** The end of the last write queued. */
	private chain: Promise<unknown> = Promise.resolve();
	private lastStartedAt: number | undefined;

	constructor(
		private readonly spacingMs: number,
		private readonly now: () => number,
		private readonly sleep: (ms: number) => Promise<void>
	) {}

	run<T>(task: () => Promise<T>): Promise<T> {
		const run = this.chain.then(async () => {
			if (this.lastStartedAt !== undefined && this.spacingMs > 0) {
				const wait = this.spacingMs - (this.now() - this.lastStartedAt);
				if (wait > 0) await this.sleep(wait);
			}
			this.lastStartedAt = this.now();
			return task();
		});
		// The next write waits for this one whatever its outcome.
		this.chain = run.catch(() => undefined);
		return run;
	}
}

/** `baseUrl + path` with the query keys in a fixed order. */
export function urlWithQuery(baseUrl: string, path: string, query?: Record<string, string | number>): string {
	const url = new URL(`${baseUrl}${path}`);
	if (query !== undefined) {
		for (const key of Object.keys(query).sort()) url.searchParams.set(key, String(query[key]));
	}
	return url.toString();
}

/** The path of an absolute URL relative to the base address, for messages and logs. */
export function shortPathOf(url: string, baseUrl: string): string {
	const parsed = new URL(url);
	const base = new URL(baseUrl).pathname.replace(/\/$/, '');
	return `${parsed.pathname.startsWith(base) ? parsed.pathname.slice(base.length) : parsed.pathname}${parsed.search}`;
}

/** A link the forge sent (`Link` header, cursor) is followed only inside the configured address: the token is only ever sent there. */
export function requireOwnAddress(
	url: string,
	own: {
		baseUrl: string;
		origin: string;
		backendKind: BackendKind;
		forgeName: string;
		redact: (text: string) => string;
	}
): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new BackendDataError(
			own.backendKind,
			'pagination',
			`${own.forgeName} sent a link that is not an address: ${own.redact(url)}`,
			'Retry; if it persists the service is misbehaving'
		);
	}
	const basePath = new URL(own.baseUrl).pathname.replace(/\/$/, '');
	if (parsed.origin !== own.origin || !parsed.pathname.startsWith(`${basePath}/`)) {
		throw new BackendDataError(
			own.backendKind,
			'pagination',
			`${own.forgeName} sent a link to ${parsed.host}, which is not the configured address ${own.baseUrl}; it was not followed`,
			'Check strategy.options.baseUrl in the project config (the token is only ever sent there)'
		);
	}
}
