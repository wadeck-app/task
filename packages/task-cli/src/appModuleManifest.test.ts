import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appModuleManifestCandidates, resolveAppModuleManifest } from './appModuleManifest.js';

let root: string;
// Mimics both layouts: <root>/packages/task-cli/<base> is where the code runs.
let base: string;

function writeManifest(file: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, '{}');
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-manifest-'));
	base = path.join(root, 'packages', 'task-cli', 'dist');
	fs.mkdirSync(base, { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveAppModuleManifest', () => {
	it('lists the bundle layout first, then the dev layout', () => {
		expect(appModuleManifestCandidates(base)).toEqual([
			path.join(base, 'app-module', 'manifest.json'),
			path.join(root, 'packages', 'app-module-task', 'dist-module', 'manifest.json'),
		]);
	});

	it('prefers the manifest shipped next to the bundle', () => {
		const [bundle, dev] = appModuleManifestCandidates(base) as [string, string];
		writeManifest(bundle);
		writeManifest(dev);
		expect(resolveAppModuleManifest(base)).toBe(bundle);
	});

	it('falls back to the dev layout', () => {
		const [, dev] = appModuleManifestCandidates(base) as [string, string];
		writeManifest(dev);
		expect(resolveAppModuleManifest(base)).toBe(dev);
	});

	it('fails loudly, naming both paths and the fix, when neither exists', () => {
		const [bundle, dev] = appModuleManifestCandidates(base) as [string, string];
		expect(() => resolveAppModuleManifest(base)).toThrow(bundle);
		expect(() => resolveAppModuleManifest(base)).toThrow(dev);
		expect(() => resolveAppModuleManifest(base)).toThrow(/npm run bundle/);
	});
});
