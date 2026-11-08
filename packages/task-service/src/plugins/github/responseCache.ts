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
}

/** Keeps entries for the life of the process: what a command that reads the same URL twice needs. */
export class MemoryResponseCache implements ResponseCache {
	private readonly entries = new Map<string, CacheEntry>();

	get(url: string): CacheEntry | undefined {
		return this.entries.get(url);
	}

	put(entry: CacheEntry): void {
		this.entries.set(entry.url, entry);
	}
}

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
}
