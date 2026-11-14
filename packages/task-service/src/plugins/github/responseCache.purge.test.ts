import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CACHE_ENTRY_MAX_AGE_MS, DiskResponseCache, EXPIRED_MARKER, RECENT_FILE } from './responseCache.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-12-01T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const nameOf = (url: string): string => `${crypto.createHash('sha256').update(url).digest('hex').slice(0, 40)}.json`;

let dir: string;
let cacheDir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-'));
	cacheDir = path.join(dir, 'cache');
	fs.mkdirSync(cacheDir);
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const writeEntry = (url: string, cachedAt: string): string => {
	const file = path.join(cacheDir, nameOf(url));
	fs.writeFileSync(file, JSON.stringify({ url, etag: '"1"', cachedAt, body: [1] }));
	return file;
};

const make = (errors: Array<{ error: unknown; file: string }> = []): DiskResponseCache =>
	new DiskResponseCache(
		cacheDir,
		(file, text) => fs.writeFileSync(file, text),
		(error, file) => errors.push({ error, file }),
		{ now: () => NOW }
	);

describe('DiskResponseCache: entries older than 30 days are purged at the first access', () => {
	it('the age is 30 days', () => {
		expect(CACHE_ENTRY_MAX_AGE_MS).toBe(30 * DAY_MS);
	});

	it('deletes an entry confirmed more than 30 days ago and keeps a recent one', () => {
		const old = writeEntry('http://x/old', iso(NOW - 31 * DAY_MS));
		const recent = writeEntry('http://x/recent', iso(NOW - 29 * DAY_MS));

		expect(make().get('http://x/recent')?.url).toBe('http://x/recent');

		expect(fs.existsSync(old)).toBe(false);
		expect(fs.existsSync(recent)).toBe(true);
	});

	it('runs once per process: an entry that becomes old later is not looked at again', () => {
		const cache = make();
		cache.get('http://x/none');
		const late = writeEntry('http://x/late', iso(NOW - 40 * DAY_MS));

		cache.get('http://x/other');
		cache.put({ url: 'http://x/y', etag: '"2"', cachedAt: iso(NOW), body: 1 });

		expect(fs.existsSync(late)).toBe(true);
	});

	it('a put as first access purges too', () => {
		const old = writeEntry('http://x/old', iso(NOW - 31 * DAY_MS));

		make().put({ url: 'http://x/new', etag: '"2"', cachedAt: iso(NOW), body: 1 });

		expect(fs.existsSync(old)).toBe(false);
		expect(fs.existsSync(path.join(cacheDir, nameOf('http://x/new')))).toBe(true);
	});

	it('never touches the marker, the recent file or a file that is not a cache entry', () => {
		const ancient = new Date(NOW - 400 * DAY_MS);
		const others = [EXPIRED_MARKER, RECENT_FILE, 'notes.txt', 'readme.json', `${'a'.repeat(40)}.json.bak`].map(
			name => {
				const file = path.join(cacheDir, name);
				fs.writeFileSync(file, iso(NOW - 400 * DAY_MS));
				fs.utimesSync(file, ancient, ancient);
				return file;
			}
		);
		fs.mkdirSync(path.join(cacheDir, `${'b'.repeat(40)}.json`));

		make().get('http://x/y');

		for (const file of others) expect(fs.existsSync(file)).toBe(true);
		expect(fs.existsSync(path.join(cacheDir, `${'b'.repeat(40)}.json`))).toBe(true);
	});

	it('an unreadable entry is aged by its file time', () => {
		const oldFile = path.join(cacheDir, nameOf('http://x/corrupt-old'));
		const freshFile = path.join(cacheDir, nameOf('http://x/corrupt-fresh'));
		fs.writeFileSync(oldFile, '{not json');
		fs.writeFileSync(freshFile, '{not json');
		const ancient = new Date(NOW - 31 * DAY_MS);
		fs.utimesSync(oldFile, ancient, ancient);
		fs.utimesSync(freshFile, new Date(NOW), new Date(NOW));

		make().get('http://x/y');

		expect(fs.existsSync(oldFile)).toBe(false);
		expect(fs.existsSync(freshFile)).toBe(true);
	});

	it('a project with no cache folder is not an error and creates nothing', () => {
		fs.rmSync(cacheDir, { recursive: true });
		const errors: Array<{ error: unknown; file: string }> = [];

		expect(make(errors).get('http://x/y')).toBeUndefined();

		expect(errors).toEqual([]);
		expect(fs.existsSync(cacheDir)).toBe(false);
	});

	it('a failure to delete is reported with the file, and the read still works', () => {
		const stuck = writeEntry('http://x/stuck', iso(NOW - 31 * DAY_MS));
		writeEntry('http://x/ok', iso(NOW));
		const reported: Array<{ error: unknown; file: string }> = [];
		const cache = new DiskResponseCache(
			cacheDir,
			(file, text) => fs.writeFileSync(file, text),
			() => undefined,
			{
				now: () => NOW,
				remove: () => {
					throw new Error('EPERM: locked');
				},
				onPurgeError: (error, file) => reported.push({ error, file }),
			}
		);

		expect(cache.get('http://x/ok')?.url).toBe('http://x/ok');

		expect(reported).toHaveLength(1);
		expect(reported[0]!.file).toBe(stuck);
		expect((reported[0]!.error as Error).message).toContain('EPERM');
	});

	it('without onPurgeError a failure goes to onWriteError, never nowhere', () => {
		writeEntry('http://x/stuck', iso(NOW - 31 * DAY_MS));
		const errors: Array<{ error: unknown; file: string }> = [];
		const cache = new DiskResponseCache(
			cacheDir,
			(file, text) => fs.writeFileSync(file, text),
			(error, file) => errors.push({ error, file }),
			{
				now: () => NOW,
				remove: () => {
					throw new Error('EPERM: locked');
				},
			}
		);

		cache.get('http://x/ok');

		expect(errors).toHaveLength(1);
	});
});
