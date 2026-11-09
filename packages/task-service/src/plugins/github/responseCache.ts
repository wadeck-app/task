// The read-through cache of the github strategy (design 2.1, "Caching"): the last 200 answer of each URL with its ETag, so a
// repeated read costs a conditional request (a 304 does not spend the quota) and a read that cannot reach GitHub can still show
// what was read before, labelled stale. Answers only: never a token, never a request header.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface CacheEntry {
	url: string;
	etag: string;
	/** ISO instant of the last time the server confirmed this answer (a 304 renews it). */
	cachedAt: string;
	body: unknown;
	/** The `rel="next"` link of the answer, when it had one. */
	next?: string;
}

export interface ResponseCache {
	get(url: string): CacheEntry | undefined;
	put(entry: CacheEntry): void;
	/** A write happened at `at` (ISO): every answer read at or before it must be revalidated before it is served again. The entries are kept (their ETags make the revalidation cheap, and they are the stale fallback). */
	expire(at: string): void;
	/** The instant of the last {@link expire}, in this process or another; undefined when there was none. */
	expiredAt(): string | undefined;
	/**
	 * Remembers that task changed issue `number` at `at` (ISO), for the things GitHub shows late (measured): `created` -- the issue
	 * LIST lacks a new issue for about 4 s -- and `dependencies` -- the dependency counts of an issue lag 1 to 2 s. The reads add what
	 * they know is missing; the memory is shared by the processes of the project.
	 */
	remember(kind: RecentKind, number: number, at: string): void;
	/** The numbers remembered under `kind` at or after `since` (ISO), oldest first. */
	recent(kind: RecentKind, since: string): number[];
}

export type RecentKind = 'created' | 'dependencies';

/** How long a creation is remembered: the list lags about 4 s (measured), this leaves a wide margin. */
export const CREATION_MEMORY_MS = 30_000;

interface Recent {
	k: RecentKind;
	n: number;
	at: string;
}

const sinceOf = (recent: readonly Recent[], kind: RecentKind, since: string): number[] => [
	...new Set(
		recent
			.filter(entry => entry.k === kind && entry.at >= since)
			.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.n - b.n))
			.map(entry => entry.n)
	),
];

/** Keeps entries for the life of the process: what a command that reads the same URL twice needs. */
export class MemoryResponseCache implements ResponseCache {
	private readonly entries = new Map<string, CacheEntry>();

	get(url: string): CacheEntry | undefined {
		return this.entries.get(url);
	}

	put(entry: CacheEntry): void {
		this.entries.set(entry.url, entry);
	}

	private mark: string | undefined;
	private readonly recentChanges: Recent[] = [];

	expire(at: string): void {
		this.mark = at;
	}

	expiredAt(): string | undefined {
		return this.mark;
	}

	remember(kind: RecentKind, number: number, at: string): void {
		this.recentChanges.push({ k: kind, n: number, at });
	}

	recent(kind: RecentKind, since: string): number[] {
		return sinceOf(this.recentChanges, kind, since);
	}
}

/** The marker file of the disk cache: the instant of the last write made through task (any process). */
export const EXPIRED_MARKER = '.expired-at';
/** The file that remembers the issues task changed lately (what GitHub shows late). */
export const RECENT_FILE = '.recent.json';

/**
 * Keeps entries as files in `dir` (`<sha256 of the url>.json`), so the next command of the CLI revalidates instead of downloading.
 * The folder is created at the first write; a read of a fresh project creates nothing. An unreadable or foreign file is a miss
 * (the cache is a copy, never the truth), a failed write is reported to `onWriteError` and does not fail the read.
 */
export class DiskResponseCache implements ResponseCache {
	private readonly memory = new MemoryResponseCache();

	constructor(
		private readonly dir: string,
		private readonly writeFile: (file: string, content: string) => void,
		private readonly onWriteError: (error: unknown, file: string) => void
	) {}

	private fileFor(url: string): string {
		return path.join(this.dir, `${crypto.createHash('sha256').update(url).digest('hex').slice(0, 40)}.json`);
	}

	get(url: string): CacheEntry | undefined {
		const known = this.memory.get(url);
		if (known !== undefined) return known;
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(this.fileFor(url), 'utf8'));
		} catch {
			return undefined;
		}
		const entry = parsed as Partial<CacheEntry> | null;
		if (
			entry === null ||
			typeof entry !== 'object' ||
			entry.url !== url ||
			typeof entry.etag !== 'string' ||
			typeof entry.cachedAt !== 'string' ||
			!('body' in entry)
		) {
			return undefined;
		}
		const valid = entry as CacheEntry;
		this.memory.put(valid);
		return valid;
	}

	put(entry: CacheEntry): void {
		this.memory.put(entry);
		const file = this.fileFor(entry.url);
		try {
			fs.mkdirSync(this.dir, { recursive: true });
			this.writeFile(file, JSON.stringify(entry));
		} catch (error) {
			this.onWriteError(error, file);
		}
	}

	/** Not read yet (`null`), or read: an instant, or nothing. */
	private mark: string | undefined | null = null;

	/** One small file for all entries: a write costs one file write, however much is cached, and another process sees it. */
	expire(at: string): void {
		this.mark = at;
		this.memory.expire(at);
		const file = path.join(this.dir, EXPIRED_MARKER);
		try {
			fs.mkdirSync(this.dir, { recursive: true });
			this.writeFile(file, at);
		} catch (error) {
			this.onWriteError(error, file);
		}
	}

	/** Read at each call: another process may have created a task since. A missing or unreadable file is no memory. */
	private readRecent(): Recent[] {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(path.join(this.dir, RECENT_FILE), 'utf8'));
			if (!Array.isArray(parsed)) return [];
			return parsed.filter(
				(entry): entry is Recent =>
					typeof entry === 'object' &&
					entry !== null &&
					((entry as Recent).k === 'created' || (entry as Recent).k === 'dependencies') &&
					Number.isInteger((entry as Recent).n) &&
					typeof (entry as Recent).at === 'string'
			);
		} catch {
			return [];
		}
	}

	remember(kind: RecentKind, number: number, at: string): void {
		const file = path.join(this.dir, RECENT_FILE);
		// Only what can still matter is kept, so the file stays a few lines long.
		const horizon = new Date(Date.parse(at) - 10 * CREATION_MEMORY_MS).toISOString();
		const kept = this.readRecent().filter(entry => entry.at >= horizon);
		try {
			fs.mkdirSync(this.dir, { recursive: true });
			this.writeFile(file, JSON.stringify([...kept, { k: kind, n: number, at }]));
		} catch (error) {
			this.onWriteError(error, file);
		}
	}

	recent(kind: RecentKind, since: string): number[] {
		return sinceOf(this.readRecent(), kind, since);
	}

	expiredAt(): string | undefined {
		if (this.mark === null) {
			try {
				const text = fs.readFileSync(path.join(this.dir, EXPIRED_MARKER), 'utf8').trim();
				this.mark = Number.isNaN(Date.parse(text)) ? undefined : text;
			} catch {
				this.mark = undefined;
			}
		}
		return this.mark;
	}
}
