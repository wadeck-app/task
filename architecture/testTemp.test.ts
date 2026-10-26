import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	MAX_TEMP_AGE_MS,
	OWN_TEMP_PREFIXES,
	isOwnTempName,
	sweepStaleTempDirs,
	trackTempDirs,
} from '../scripts/testTemp.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

function scratch(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'testtemp-arch-'));
}

function age(dir: string, ms: number): void {
	const when = new Date(Date.now() - ms);
	fs.utimesSync(dir, when, when);
}

describe('sweepStaleTempDirs', () => {
	it('removes only own-prefixed, real, old directories at the top level of the temp dir', () => {
		const tempDir = scratch();
		try {
			const old = path.join(tempDir, 'task-service-AbC123');
			const young = path.join(tempDir, 'task-cli-xdg-Zz9Yy8');
			const foreign = path.join(tempDir, 'other-tool-AbC123');
			const nearMiss = path.join(tempDir, 'task-service-open-AbC123x');
			const nested = path.join(tempDir, 'foreign-parent', 'task-service-Qq1Ww2');
			for (const dir of [old, young, foreign, nearMiss, nested]) fs.mkdirSync(dir, { recursive: true });
			// A file with an own name must stay (it is not a directory).
			const file = path.join(tempDir, 'task-store-FileAA');
			fs.writeFileSync(file, 'x');
			for (const dir of [old, foreign, nearMiss, nested, file]) age(dir, MAX_TEMP_AGE_MS + 60_000);
			age(young, 60_000);

			const result = sweepStaleTempDirs({ tempDir });

			expect(result.removed).toEqual([old]);
			expect(fs.existsSync(old)).toBe(false);
			for (const kept of [young, foreign, nearMiss, nested, file]) expect(fs.existsSync(kept), kept).toBe(true);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('does not follow a symlink named like an own directory', () => {
		const tempDir = scratch();
		const target = scratch();
		try {
			fs.writeFileSync(path.join(target, 'keep.txt'), 'x');
			const link = path.join(tempDir, 'task-service-LinkAA');
			try {
				fs.symlinkSync(target, link, 'junction');
			} catch (error) {
				throw new Error(`cannot create a link for the test: ${(error as Error).message}`);
			}
			const result = sweepStaleTempDirs({ tempDir, now: Date.now() + MAX_TEMP_AGE_MS * 10 });
			expect(result.removed).toEqual([]);
			expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
			fs.rmSync(target, { recursive: true, force: true });
		}
	});
});

describe('isOwnTempName', () => {
	it('needs the exact prefix plus six random characters', () => {
		expect(isOwnTempName('task-service-AbC123')).toBe(true);
		expect(isOwnTempName('task-service-open-AbC123')).toBe(true);
		expect(isOwnTempName('task-service-AbC12')).toBe(false);
		expect(isOwnTempName('task-service-AbC1234')).toBe(false);
		expect(isOwnTempName('task-ui-tools')).toBe(false);
	});
});

describe('trackTempDirs', () => {
	it('removes the own-prefixed directories created through mkdtempSync, leaves the others', () => {
		const tempDir = scratch();
		const tracker = trackTempDirs({ tempDir, processHooks: false });
		try {
			const own = fs.mkdtempSync(path.join(tempDir, 'task-store-'));
			fs.writeFileSync(path.join(own, 'f.txt'), 'x');
			const foreign = fs.mkdtempSync(path.join(tempDir, 'foreign-'));
			expect(tracker.pending()).toEqual([own]);
			tracker.release();
			expect(fs.existsSync(own)).toBe(false);
			expect(fs.existsSync(foreign)).toBe(true);
			expect(tracker.pending()).toEqual([]);
		} finally {
			tracker.uninstall();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('tolerates a directory the test already removed', () => {
		const tempDir = scratch();
		const tracker = trackTempDirs({ tempDir, processHooks: false });
		try {
			const own = fs.mkdtempSync(path.join(tempDir, 'task-store-'));
			fs.rmSync(own, { recursive: true });
			expect(() => tracker.release()).not.toThrow();
		} finally {
			tracker.uninstall();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe('OWN_TEMP_PREFIXES', () => {
	// A new test creator with an unlisted prefix would escape the tracker and the sweep: fail until it is listed.
	it('lists every literal mkdtemp prefix used under os.tmpdir() by the packages and the shared scripts', () => {
		const files: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (['node_modules', 'dist', 'dist-types', 'dist-module', 'dist-bundle'].includes(entry.name)) continue;
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (/\.(ts|tsx|mts|mjs)$/.test(entry.name)) files.push(full);
			}
		};
		walk(path.join(ROOT, 'packages'));
		const pattern =
			/mkdtemp(?:Sync)?\(\s*(?:path\.|nodePath\.)?join\(\s*(?:os\.)?tmpdir\(\)\s*,\s*(['"`])([^'"`$]+)\1/g;
		const missing: string[] = [];
		for (const file of files) {
			const text = fs.readFileSync(file, 'utf8');
			for (const match of text.matchAll(pattern)) {
				const prefix = match[2]!;
				if (!OWN_TEMP_PREFIXES.includes(prefix)) missing.push(`${path.relative(ROOT, file)}: '${prefix}'`);
			}
		}
		expect(missing, 'add these prefixes to OWN_TEMP_PREFIXES in scripts/testTemp.ts').toEqual([]);
	});
});
