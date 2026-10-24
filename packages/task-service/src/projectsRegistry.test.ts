import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProjectsRegistryError } from './errors.js';
import { isSameProjectDir, listRegisteredProjects, projectsRegistryPath } from './projectsRegistry.js';
import { addLegacyEntry } from './testHelpers.js';

function hintOf(call: () => unknown): string | undefined {
	try {
		call();
	} catch (error) {
		return (error as ProjectsRegistryError).hint;
	}
	return undefined;
}

// The legacy list is READ ONLY since stage 2a: fixtures write it by hand (addLegacyEntry).
describe('projects registry (legacy projects.json, read only)', () => {
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

	it('is the projects.json file of the config dir', () => {
		expect(projectsRegistryPath(configDir)).toBe(path.join(configDir, 'projects.json'));
	});

	it('lists nothing when there is no file', () => {
		expect(listRegisteredProjects(configDir)).toEqual([]);
	});

	it('lists the entries of the file in its order', () => {
		addLegacyEntry(configDir, projectB);
		addLegacyEntry(configDir, projectA);

		expect(listRegisteredProjects(configDir)).toEqual([projectB, projectA]);
	});

	it('reading never writes: the file is byte for byte what it was, and no lock or temp file appears', () => {
		addLegacyEntry(configDir, projectA);
		const before = fs.readFileSync(projectsRegistryPath(configDir), 'utf8');

		listRegisteredProjects(configDir);

		expect(fs.readFileSync(projectsRegistryPath(configDir), 'utf8')).toBe(before);
		expect(fs.readdirSync(configDir)).toEqual(['projects.json']);
	});

	it('does not create the config dir when there is no file', () => {
		listRegisteredProjects(configDir);

		expect(fs.existsSync(configDir)).toBe(false);
	});

	describe('corrupt file fails loudly, naming the file and the fix', () => {
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
			const call = (): unknown => listRegisteredProjects(configDir);

			expect(call).toThrow(ProjectsRegistryError);
			expect(call).toThrow(file);
			expect(hintOf(call)).toMatch(/Fix or delete/);
			expect(hintOf(call)).toContain('project add');
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
