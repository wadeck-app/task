import { vi } from 'vitest';

export interface FetchCall {
	/** The requested address, resolved against a fake origin so `searchParams` works. */
	url: URL;
	signal: AbortSignal | undefined;
	method: string;
	/** The request body as text. */
	body: string | undefined;
	/** Request headers, names lower-cased. */
	headers: Record<string, string>;
}

export interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Replaces the global fetch. Like the real one it rejects with an AbortError as soon as the request's signal aborts,
 * whatever the responder does, so a test can tell a cancelled request from a finished one.
 */
export function stubFetch(responder: (call: FetchCall) => Promise<Response> | Response): {
	calls: FetchCall[];
	fn: ReturnType<typeof vi.fn>;
} {
	const calls: FetchCall[] = [];
	const fn = vi.fn((input: unknown, init?: RequestInit) => {
		const call: FetchCall = {
			url: new URL(String(input), 'http://localhost'),
			signal: init?.signal ?? undefined,
			method: init?.method ?? 'GET',
			body: typeof init?.body === 'string' ? init.body : undefined,
			headers: Object.fromEntries(
				Object.entries((init?.headers as Record<string, string> | undefined) ?? {}).map(([k, v]) => [
					k.toLowerCase(),
					v,
				])
			),
		};
		calls.push(call);
		return new Promise<Response>((resolve, reject) => {
			const abort = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'));
			if (call.signal?.aborted) {
				abort();
				return;
			}
			call.signal?.addEventListener('abort', abort);
			Promise.resolve(responder(call)).then(resolve, reject);
		});
	});
	vi.stubGlobal('fetch', fn);
	return { calls, fn };
}

type Listener = (event: { data?: string }) => void;

/** A controllable EventSource: tests open it, send events and break it by hand. */
export class FakeEventSource {
	static instances: FakeEventSource[] = [];
	readonly url: string;
	closed = false;
	private listeners = new Map<string, Listener[]>();

	constructor(url: string | URL) {
		this.url = String(url);
		FakeEventSource.instances.push(this);
	}

	static reset(): void {
		FakeEventSource.instances = [];
	}

	static last(): FakeEventSource {
		const last = FakeEventSource.instances[FakeEventSource.instances.length - 1];
		if (!last) {
			throw new Error('No EventSource was created');
		}
		return last;
	}

	addEventListener(type: string, listener: Listener): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	removeEventListener(type: string, listener: Listener): void {
		this.listeners.set(
			type,
			(this.listeners.get(type) ?? []).filter(l => l !== listener)
		);
	}

	close(): void {
		this.closed = true;
	}

	emit(type: string, data?: string): void {
		if (this.closed) {
			return;
		}
		for (const listener of this.listeners.get(type) ?? []) {
			listener({ data });
		}
	}
}
