import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProjectsRegistryError } from './errors.js';
import {
	isSameProjectDir,
	listRegisteredProjects,
	projectsRegistryPath,
	pruneMissingProjects,
	registerProject,
	unregisterProject,
} from './projectsRegistry.js';

function hintOf(call: () => unknown): string | undefined {
	try {
		call();
	} catch (error) {
		return (error as ProjectsRegistryError).hint;
	}
	return undefined;
}

describe('projects registry', () => {
	let configDir: string;
	let projectA: string;
	let projectB: string;

	beforeEach(() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-registry-'));
		configDir = path.join(root, 'config');
		projectA = path.join(root, 'a');
		projectB = path.join(root, 'b');
	});

	afterEach(() => {
		fs.rmSync(path.dirname(configDir), { recursive: true, force: true });
	});

	it('stores the registry as projects.json in the config dir', () => {
		expect(projectsRegistryPath(configDir)).toBe(path.join(configDir, 'projects.json'));
	});

	it('lists nothing when no project was ever registered (no file)', () => {
		expect(listRegisteredProjects(configDir)).toEqual([]);
	});

	it('registers a project, creating the config dir, and lists it', () => {
		expect(registerProject(configDir, projectA)).toEqual({ added: true });
		expect(listRegisteredProjects(configDir)).toEqual([projectA]);
		expect(JSON.parse(fs.readFileSync(projectsRegistryPath(configDir), 'utf8'))).toEqual([projectA]);
	});

	it('is idempotent: registering twice keeps one entry and reports added=false', () => {
		registerProject(configDir, projectA);
		expect(registerProject(configDir, projectA)).toEqual({ added: false });
		expect(listRegisteredProjects(configDir)).toEqual([projectA]);
	});

	it('normalizes the directory (trailing separator, dot segments) before comparing', () => {
		registerProject(configDir, projectA);
		expect(registerProject(configDir, path.join(projectA, 'x', '..') + path.sep)).toEqual({ added: false });
		expect(listRegisteredProjects(configDir)).toEqual([projectA]);
	});

	it('keeps registration order', () => {
		registerProject(configDir, projectB);
		registerProject(configDir, projectA);
		expect(listRegisteredProjects(configDir)).toEqual([projectB, projectA]);
	});

	it('leaves no temporary file behind (atomic write)', () => {
		registerProject(configDir, projectA);
		expect(fs.readdirSync(configDir)).toEqual(['projects.json']);
	});

	it('rejects a relative directory with an actionable error', () => {
		expect(() => registerProject(configDir, 'relative/dir')).toThrow(ProjectsRegistryError);
		expect(() => registerProject(configDir, 'relative/dir')).toThrow(/absolute/);
	});

	it('unregisters a project and reports whether it was registered', () => {
		registerProject(configDir, projectA);
		registerProject(configDir, projectB);
		expect(unregisterProject(configDir, projectA)).toEqual({ removed: true });
		expect(unregisterProject(configDir, projectA)).toEqual({ removed: false });
		expect(listRegisteredProjects(configDir)).toEqual([projectB]);
	});

	it('unregistering with no registry file removes nothing and creates no file', () => {
		expect(unregisterProject(configDir, projectA)).toEqual({ removed: false });
		expect(fs.existsSync(projectsRegistryPath(configDir))).toBe(false);
	});

	describe('corrupt registry fails loudly, naming the file and the fix', () => {
		function writeRaw(content: string): void {
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(projectsRegistryPath(configDir), content, 'utf8');
		}

		it.each([
			['invalid JSON', '{not json'],
			['an empty file', ''],
			['a JSON object instead of an array', '{"a":1}'],
			['an entry that is not a string', '[42]'],
			['a relative path entry', '["rel/dir"]'],
		])('%s', (_label, content) => {
			writeRaw(content);
			const file = projectsRegistryPath(configDir);
			for (const call of [
				() => listRegisteredProjects(configDir),
				() => registerProject(configDir, projectA),
				() => unregisterProject(configDir, projectA),
			]) {
				expect(call).toThrow(ProjectsRegistryError);
				expect(call).toThrow(file);
				expect(hintOf(call)).toMatch(/Fix or delete/);
			}
			// Never overwritten: the user's content is untouched.
			expect(fs.readFileSync(file, 'utf8')).toBe(content);
		});
	});
});

describe('isSameProjectDir', () => {
	const base = path.resolve(os.tmpdir(), 'Proj');

	it('is true for the same directory, however it is spelled (trailing separator, dot segments)', () => {
		expect(isSameProjectDir(base, base)).toBe(true);
		expect(isSameProjectDir(base, path.join(base, 'sub', '..'))).toBe(true);
	});

	it('is false for different directories', () => {
		expect(isSameProjectDir(base, path.join(base, 'sub'))).toBe(false);
	});

	it('ignores case on Windows only (the rule the registry applies to its entries)', () => {
		expect(isSameProjectDir(base, base.toUpperCase())).toBe(process.platform === 'win32');
	});
});

describe('pruneMissingProjects', () => {
	let root: string;
	let configDir: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-prune-'));
		configDir = path.join(root, 'config');
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('removes the entries whose directory no longer exists and returns them, keeping the others in order', () => {
		const kept = path.join(root, 'kept');
		const gone = path.join(root, 'gone');
		fs.mkdirSync(kept);
		registerProject(configDir, gone);
		registerProject(configDir, kept);
		expect(pruneMissingProjects(configDir)).toEqual({ removed: [gone] });
		expect(listRegisteredProjects(configDir)).toEqual([kept]);
	});

	it('dry run reports the same entries and writes nothing', () => {
		const gone = path.join(root, 'gone');
		registerProject(configDir, gone);
		const before = fs.readFileSync(projectsRegistryPath(configDir), 'utf8');
		expect(pruneMissingProjects(configDir, { dryRun: true })).toEqual({ removed: [gone] });
		expect(fs.readFileSync(projectsRegistryPath(configDir), 'utf8')).toBe(before);
	});

	it('does not touch the registry when every directory exists or nothing is registered', () => {
		expect(pruneMissingProjects(configDir)).toEqual({ removed: [] });
		expect(fs.existsSync(projectsRegistryPath(configDir))).toBe(false);
		const kept = path.join(root, 'kept');
		fs.mkdirSync(kept);
		registerProject(configDir, kept);
		expect(pruneMissingProjects(configDir)).toEqual({ removed: [] });
		expect(listRegisteredProjects(configDir)).toEqual([kept]);
	});

	it('treats a path that is a file as missing (a project is a directory)', () => {
		const file = path.join(root, 'afile');
		fs.writeFileSync(file, 'x');
		registerProject(configDir, file);
		expect(pruneMissingProjects(configDir)).toEqual({ removed: [file] });
	});

	it('throws the registry error for a corrupt registry instead of pruning', () => {
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(projectsRegistryPath(configDir), '{nope');
		expect(() => pruneMissingProjects(configDir)).toThrow(ProjectsRegistryError);
	});
});
