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
	 * LIST lacks a new issue for about 4 s --, `dependencies` -- the dependency counts of an issue lag 1 to 2 s -- and `subIssues` --
	 * the sub-issue counts of a parent lag the same way. The reads add what they know is missing; the memory is shared by the processes
	 * of the project.
	 */
	remember(kind: RecentKind, number: number, at: string): void;
	/** The numbers remembered under `kind` at or after `since` (ISO), oldest first. */
	recent(kind: RecentKind, since: string): number[];
}

export const RECENT_KINDS = ['created', 'dependencies', 'subIssues'] as const;
export type RecentKind = (typeof RECENT_KINDS)[number];

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
/** An entry is deleted when its last confirmation is older than this (30 days): the cache is a copy, so nothing is lost. */
export const CACHE_ENTRY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** The name of a cache entry file: 40 hex characters (sha256 of the URL). Nothing else in the folder is an entry. */
const ENTRY_FILE = /^[0-9a-f]{40}\.json$/;
/** The file that remembers the issues task changed lately (what GitHub shows late). */
export const RECENT_FILE = '.recent.json';

/**
 * Keeps entries as files in `dir` (`<sha256 of the url>.json`), so the next command of the CLI revalidates instead of downloading.
 * The folder is created at the first write; a read of a fresh project creates nothing. An unreadable or foreign file is a miss
 * (the cache is a copy, never the truth), a failed write is reported to `onWriteError` and does not fail the read.
 */
export class DiskResponseCache implements ResponseCache {
	private readonly memory = new MemoryResponseCache();
	private readonly now: () => number;
	private readonly remove: (file: string) => void;
	private readonly onPurgeError: (error: unknown, file: string) => void;
	private purged = false;

	constructor(
		private readonly dir: string,
		private readonly writeFile: (file: string, content: string) => void,
		private readonly onWriteError: (error: unknown, file: string) => void,
		options: {
			/** The clock (ms), for the age of an entry. Default: `Date.now`. */
			now?: () => number;
			/** Deletes one file. Default: `fs.unlinkSync`. */
			remove?: (file: string) => void;
			/** Told about a purge that failed (listing or deleting); default: `onWriteError`, so a failure is never silent. */
			onPurgeError?: (error: unknown, file: string) => void;
		} = {}
	) {
		this.now = options.now ?? Date.now;
		this.remove = options.remove ?? (file => fs.unlinkSync(file));
		this.onPurgeError = options.onPurgeError ?? onWriteError;
	}

	/**
	 * Once per process, at the first access of the disk cache: deletes the entries (`<40 hex>.json` files, nothing else) whose last
	 * confirmation is older than {@link CACHE_ENTRY_MAX_AGE_MS} (file time when the entry cannot be read), so the answers of a
	 * private repository do not stay on disk forever. One directory listing; a missing folder is a fresh project. A failure is
	 * reported to `onPurgeError` and never fails the read.
	 */
	private purgeOnce(): void {
		if (this.purged) return;
		this.purged = true;
		let names: string[];
		try {
			names = fs.readdirSync(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onPurgeError(error, this.dir);
			return;
		}
		const limit = this.now() - CACHE_ENTRY_MAX_AGE_MS;
		for (const name of names) {
			if (!ENTRY_FILE.test(name)) continue;
			const file = path.join(this.dir, name);
			try {
				const stat = fs.statSync(file);
				if (!stat.isFile()) continue;
				if (this.confirmedAt(file, stat.mtimeMs) < limit) this.remove(file);
			} catch (error) {
				// Gone meanwhile (another process purged it): nothing to report.
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onPurgeError(error, file);
			}
		}
	}

	/** The last confirmation of an entry file (ms): its `cachedAt`, else the file time. */
	private confirmedAt(file: string, mtimeMs: number): number {
		try {
			const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { cachedAt?: unknown } | null;
			const at = typeof parsed?.cachedAt === 'string' ? Date.parse(parsed.cachedAt) : Number.NaN;
			return Number.isNaN(at) ? mtimeMs : at;
		} catch {
			return mtimeMs;
		}
	}

	private fileFor(url: string): string {
		return path.join(this.dir, `${crypto.createHash('sha256').update(url).digest('hex').slice(0, 40)}.json`);
	}

	get(url: string): CacheEntry | undefined {
		this.purgeOnce();
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
		this.purgeOnce();
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
		this.purgeOnce();
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
					(RECENT_KINDS as readonly unknown[]).includes((entry as Recent).k) &&
					Number.isInteger((entry as Recent).n) &&
					typeof (entry as Recent).at === 'string'
			);
		} catch {
			return [];
		}
	}

	remember(kind: RecentKind, number: number, at: string): void {
		this.purgeOnce();
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
		this.purgeOnce();
		return sinceOf(this.readRecent(), kind, since);
	}

	expiredAt(): string | undefined {
		this.purgeOnce();
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
