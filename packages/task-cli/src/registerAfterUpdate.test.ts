import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAppModuleVersion, registerAfterUpdate } from './registerAfterUpdate.js';

let installDir: string;
let manifestPath: string;
const register = vi.fn();
let lines: string[];
const log = (line: string): void => {
	lines.push(line);
};

function writeManifest(content: string): void {
	fs.mkdirSync(path.join(installDir, 'app-module'), { recursive: true });
	fs.writeFileSync(manifestPath, content);
}

beforeEach(() => {
	installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'register-after-update-'));
	manifestPath = path.join(installDir, 'app-module', 'manifest.json');
	lines = [];
	register.mockResolvedValue(undefined);
});

afterEach(() => {
	fs.rmSync(installDir, { recursive: true, force: true });
});

describe('readAppModuleVersion', () => {
	it('returns the version written in the manifest', () => {
		writeManifest(JSON.stringify({ version: '2026.10.18-131-abc' }));
		expect(readAppModuleVersion(manifestPath)).toEqual({ version: '2026.10.18-131-abc' });
	});

	it('reports a missing manifest as absent, not as an error (an older install has no app-module)', () => {
		expect(readAppModuleVersion(manifestPath)).toEqual({ absent: true });
	});

	it('reports an unreadable manifest with the reason', () => {
		writeManifest('{not json');
		expect(readAppModuleVersion(manifestPath)).toMatchObject({ error: expect.stringContaining('manifest.json') });
	});

	it('reports a manifest without a version string', () => {
		writeManifest('{}');
		expect(readAppModuleVersion(manifestPath)).toMatchObject({ error: expect.stringContaining('version') });
	});
});

describe('registerAfterUpdate', () => {
	it('registers when the installed app-module version changed during the update', async () => {
		writeManifest(JSON.stringify({ version: '2' }));
		await registerAfterUpdate({ manifestPath, before: { version: '1' }, register, log });
		expect(register).toHaveBeenCalledTimes(1);
		expect(register.mock.calls[0]![0]).toBe(manifestPath);
	});

	it('prints what the registration reports as is', async () => {
		writeManifest(JSON.stringify({ version: '2' }));
		register.mockImplementation(
			async (_path: string, logEntry: (e: { source: string; message: string }) => void) => {
				logEntry({
					source: 'AppCoreRegistration',
					message: 'app-core: module "task" registered (app-core on port 4850)',
				});
			}
		);
		await registerAfterUpdate({ manifestPath, before: { version: '1' }, register, log });
		expect(lines).toEqual(['app-core: module "task" registered (app-core on port 4850)']);
	});

	it('registers when the install gained an app-module it did not have before', async () => {
		writeManifest(JSON.stringify({ version: '1' }));
		await registerAfterUpdate({ manifestPath, before: { absent: true }, register, log });
		expect(register).toHaveBeenCalledTimes(1);
	});

	it('does nothing, and says nothing, when the version did not change (already up to date)', async () => {
		writeManifest(JSON.stringify({ version: '1' }));
		await registerAfterUpdate({ manifestPath, before: { version: '1' }, register, log });
		expect(register).not.toHaveBeenCalled();
		expect(lines).toEqual([]);
	});

	it('says nothing when there is no app-module before or after', async () => {
		await registerAfterUpdate({ manifestPath, before: { absent: true }, register, log });
		expect(register).not.toHaveBeenCalled();
		expect(lines).toEqual([]);
	});

	it('warns when the app-module disappeared from the install', async () => {
		await registerAfterUpdate({ manifestPath, before: { version: '1' }, register, log });
		expect(register).not.toHaveBeenCalled();
		expect(lines.join('\n')).toContain('no longer');
	});

	it('warns, with the reason and the manual fix, when the new manifest cannot be read', async () => {
		writeManifest('{not json');
		await registerAfterUpdate({ manifestPath, before: { version: '1' }, register, log });
		expect(register).not.toHaveBeenCalled();
		expect(lines.join('\n')).toContain('manifest.json');
		expect(lines.join('\n')).toContain('task cli register');
	});
});
