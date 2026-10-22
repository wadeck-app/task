import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addProject } from './addProject.js';
import { InvalidProjectPathError, ProjectsRegistryError } from './errors.js';
import { listRegisteredProjects, projectsRegistryPath } from './projectsRegistry.js';

describe('addProject (the "add project" form of the UI)', () => {
	let root: string;
	let configDir: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-add-'));
		configDir = path.join(root, 'config');
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function initialized(name: string): string {
		const dir = path.join(root, name);
		fs.mkdirSync(path.join(dir, '.task', 'tasks'), { recursive: true });
		return dir;
	}

	describe("mode 'register'", () => {
		it('registers an existing task project', () => {
			const dir = initialized('p');
			expect(addProject(configDir, { path: dir, mode: 'register' })).toEqual({
				path: dir,
				mode: 'register',
				added: true,
				initialized: false,
				createdDirectory: false,
			});
			expect(listRegisteredProjects(configDir)).toEqual([dir]);
		});

		it('is idempotent: registering twice answers added=false', () => {
			const dir = initialized('p');
			addProject(configDir, { path: dir, mode: 'register' });
			expect(addProject(configDir, { path: dir, mode: 'register' }).added).toBe(false);
			expect(listRegisteredProjects(configDir)).toEqual([dir]);
		});

		it('refuses a directory that is not a task project and offers the init mode, creating nothing', () => {
			const dir = path.join(root, 'bare');
			fs.mkdirSync(dir);
			expect(() => addProject(configDir, { path: dir, mode: 'register' })).toThrow(InvalidProjectPathError);
			try {
				addProject(configDir, { path: dir, mode: 'register' });
			} catch (error) {
				expect((error as InvalidProjectPathError).hint).toMatch(/initialise a new task project/i);
			}
			expect(fs.existsSync(path.join(dir, '.task'))).toBe(false);
			expect(listRegisteredProjects(configDir)).toEqual([]);
		});

		it('refuses a missing directory without creating it', () => {
			const dir = path.join(root, 'ghost');
			expect(() => addProject(configDir, { path: dir, mode: 'register' })).toThrow(/does not exist/);
			expect(fs.existsSync(dir)).toBe(false);
		});

		it('refuses createDirectory: it has no meaning when registering', () => {
			const dir = initialized('p');
			expect(() => addProject(configDir, { path: dir, mode: 'register', createDirectory: true })).toThrow(
				/only with the initialise mode/
			);
		});
	});

	describe("mode 'init'", () => {
		it('initialises an existing directory and registers it', () => {
			const dir = path.join(root, 'fresh');
			fs.mkdirSync(dir);
			const result = addProject(configDir, { path: dir, mode: 'init' });
			expect(result).toEqual({
				path: dir,
				mode: 'init',
				added: true,
				initialized: true,
				createdDirectory: false,
			});
			expect(fs.existsSync(path.join(dir, '.task', 'config.yml'))).toBe(true);
			expect(listRegisteredProjects(configDir)).toEqual([dir]);
		});

		it('on an already initialised directory registers it and reports initialized=false (nothing was created)', () => {
			const dir = initialized('p');
			const result = addProject(configDir, { path: dir, mode: 'init' });
			expect(result.initialized).toBe(false);
			expect(result.added).toBe(true);
		});

		it('refuses a directory that does not exist, saying how to create it, and creates nothing', () => {
			const dir = path.join(root, 'ghost');
			expect(() => addProject(configDir, { path: dir, mode: 'init' })).toThrow(/does not exist/);
			try {
				addProject(configDir, { path: dir, mode: 'init' });
			} catch (error) {
				expect((error as InvalidProjectPathError).hint).toMatch(/Create the directory/);
			}
			expect(fs.existsSync(dir)).toBe(false);
		});

		it('creates the directory only on request, one level deep (the parent must exist)', () => {
			const dir = path.join(root, 'newone');
			const result = addProject(configDir, { path: dir, mode: 'init', createDirectory: true });
			expect(result.createdDirectory).toBe(true);
			expect(result.initialized).toBe(true);
			expect(fs.existsSync(path.join(dir, '.task', 'tasks'))).toBe(true);
		});

		it('refuses to create a directory whose parent does not exist (a typo would create a stray tree)', () => {
			const dir = path.join(root, 'no', 'such', 'parent');
			expect(() => addProject(configDir, { path: dir, mode: 'init', createDirectory: true })).toThrow(
				/parent .* does not exist/
			);
			expect(fs.existsSync(path.join(root, 'no'))).toBe(false);
		});

		it('refuses a path that is a file', () => {
			const file = path.join(root, 'f.txt');
			fs.writeFileSync(file, 'x');
			expect(() => addProject(configDir, { path: file, mode: 'init' })).toThrow(/not a directory/);
			expect(() => addProject(configDir, { path: file, mode: 'init', createDirectory: true })).toThrow(
				/not a directory/
			);
		});

		it('fails loudly when the project was initialised but could not be registered (corrupt registry)', () => {
			const dir = path.join(root, 'fresh');
			fs.mkdirSync(dir);
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(projectsRegistryPath(configDir), '{not json');
			expect(() => addProject(configDir, { path: dir, mode: 'init' })).toThrow(ProjectsRegistryError);
			expect(() => addProject(configDir, { path: dir, mode: 'init' })).toThrow(
				/initialized .* but .* not registered/
			);
			expect(fs.existsSync(path.join(dir, '.task', 'config.yml'))).toBe(true);
		});
	});

	it('validates the path first: relative, NUL, relative segments', () => {
		expect(() => addProject(configDir, { path: 'rel', mode: 'register' })).toThrow(InvalidProjectPathError);
		expect(() => addProject(configDir, { path: path.join(root, 'a\0'), mode: 'init' })).toThrow(/NUL/);
		expect(() => addProject(configDir, { path: root + '/x/../y', mode: 'init' })).toThrow(/relative segment/);
	});

	it('refuses an unknown mode, naming the valid ones', () => {
		expect(() => addProject(configDir, { path: root, mode: 'delete' as never })).toThrow(/mode must be/);
	});
});
