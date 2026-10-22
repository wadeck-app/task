import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneStagedModules, stageAppModule, stagedModulesRoot } from './appModuleStaging.js';

let root: string;
let configDir: string;
let sourceDir: string;

function writeModule(dir: string, version: string, extra = 'backend v1'): string {
	fs.mkdirSync(path.join(dir, 'views'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version }));
	fs.writeFileSync(path.join(dir, 'backend.js'), extra);
	fs.writeFileSync(path.join(dir, 'views', 'tasks.json'), '{}');
	return path.join(dir, 'manifest.json');
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-staging-'));
	configDir = path.join(root, 'config');
	sourceDir = path.join(root, 'npm', 'app-module');
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('stageAppModule', () => {
	it('copies the whole module to <config dir>/app-module/<version>/ and returns the staged manifest', () => {
		const source = writeModule(sourceDir, '2026.10.18-131-abc');
		const staged = stageAppModule(source, configDir);
		const target = path.join(configDir, 'app-module', '2026.10.18-131-abc');
		expect(staged).toEqual({ manifestPath: path.join(target, 'manifest.json'), stamp: '2026.10.18-131-abc' });
		expect(fs.readFileSync(path.join(target, 'backend.js'), 'utf8')).toBe('backend v1');
		expect(fs.existsSync(path.join(target, 'views', 'tasks.json'))).toBe(true);
	});

	it('survives the removal of the npm folder (the point of staging)', () => {
		const source = writeModule(sourceDir, '1.0.0');
		const { manifestPath } = stageAppModule(source, configDir);
		fs.rmSync(path.join(root, 'npm'), { recursive: true, force: true });
		expect(fs.existsSync(manifestPath)).toBe(true);
	});

	it('is idempotent: a complete staged copy is kept as it is', () => {
		const source = writeModule(sourceDir, '1.0.0');
		const first = stageAppModule(source, configDir);
		fs.writeFileSync(path.join(path.dirname(first.manifestPath), 'marker.txt'), 'kept');
		const second = stageAppModule(source, configDir);
		expect(second).toEqual(first);
		expect(fs.existsSync(path.join(path.dirname(first.manifestPath), 'marker.txt'))).toBe(true);
	});

	it('replaces an incomplete target (no manifest) and leaves no .partial folder behind', () => {
		const source = writeModule(sourceDir, '1.0.0');
		const target = path.join(configDir, 'app-module', '1.0.0');
		fs.mkdirSync(target, { recursive: true });
		fs.writeFileSync(path.join(target, 'junk.txt'), 'x');
		stageAppModule(source, configDir);
		expect(fs.existsSync(path.join(target, 'junk.txt'))).toBe(false);
		expect(fs.existsSync(path.join(target, 'manifest.json'))).toBe(true);
		expect(fs.readdirSync(path.join(configDir, 'app-module'))).toEqual(['1.0.0']);
	});

	it('fails loudly, naming the manifest, when the source manifest does not exist', () => {
		const missing = path.join(sourceDir, 'manifest.json');
		expect(() => stageAppModule(missing, configDir)).toThrow(missing);
	});

	it('fails loudly when the manifest has no version (nothing to name the copy by)', () => {
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(path.join(sourceDir, 'manifest.json'), '{}');
		expect(() => stageAppModule(path.join(sourceDir, 'manifest.json'), configDir)).toThrow(/version/);
	});

	it.each(['../evil', 'a/b', '.hidden', 'a b'])('refuses the version "%s" as a folder name', version => {
		const source = writeModule(sourceDir, version);
		expect(() => stageAppModule(source, configDir)).toThrow(/not a usable version/);
		expect(fs.existsSync(stagedModulesRoot(configDir))).toBe(false);
	});

	it('names source and destination when the copy fails', () => {
		const source = writeModule(sourceDir, '1.0.0');
		// A FILE where the config dir should be: the copy cannot be created.
		fs.writeFileSync(configDir, 'not a directory');
		let message = '';
		try {
			stageAppModule(source, configDir);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain(sourceDir);
		expect(message).toContain(path.join(configDir, 'app-module', '1.0.0'));
		expect(message).toContain('task cli register');
	});
});

describe('pruneStagedModules', () => {
	it('removes every staged version but the kept one and returns how many went', () => {
		for (const version of ['1.0.0', '1.1.0', '2.0.0']) {
			stageAppModule(writeModule(path.join(root, `src-${version}`), version), configDir);
		}
		expect(pruneStagedModules(configDir, '2.0.0')).toBe(2);
		expect(fs.readdirSync(stagedModulesRoot(configDir))).toEqual(['2.0.0']);
	});

	it('is 0 when nothing was ever staged', () => {
		expect(pruneStagedModules(configDir, '1.0.0')).toBe(0);
	});
});
