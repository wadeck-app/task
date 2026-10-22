import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeError } from './describeError.js';
import {
	InvalidProjectPathError,
	ProjectAlreadyRegisteredError,
	ProjectNotRegisteredError,
	ProjectsRegistryError,
} from './errors.js';
import {
	listRegisteredProjects,
	projectsRegistryPath,
	registerProject,
	relocateProject,
	removeRegisteredProject,
} from './projectsRegistry.js';

describe('project registry: relocate and remove', () => {
	let root: string;
	let configDir: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-reloc-'));
		configDir = path.join(root, 'config');
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function project(name: string, options: { initialized?: boolean; register?: boolean } = {}): string {
		const dir = path.join(root, name);
		fs.mkdirSync(options.initialized === false ? dir : path.join(dir, '.task', 'tasks'), { recursive: true });
		if (options.register !== false) registerProject(configDir, dir);
		return dir;
	}

	describe('relocateProject', () => {
		it('replaces the entry in place (same position), writing nothing else', () => {
			const a = project('a');
			const b = project('b');
			const c = project('c');
			const moved = project('b-moved', { register: false });
			expect(relocateProject(configDir, b, moved)).toEqual({ from: b, to: moved });
			expect(listRegisteredProjects(configDir)).toEqual([a, moved, c]);
		});

		it('leaves the data of the old and the new directory untouched', () => {
			const old = project('old');
			fs.writeFileSync(path.join(old, '.task', 'keep.txt'), 'x');
			const next = project('next', { register: false });
			relocateProject(configDir, old, next);
			expect(fs.readFileSync(path.join(old, '.task', 'keep.txt'), 'utf8')).toBe('x');
		});

		it('works when the old directory is gone from the disk (the main recovery path)', () => {
			const old = project('old');
			fs.rmSync(old, { recursive: true });
			const next = project('next', { register: false });
			relocateProject(configDir, old, next);
			expect(listRegisteredProjects(configDir)).toEqual([next]);
		});

		it('fails when the old directory is not registered, naming it, and writes nothing', () => {
			project('a');
			const stranger = project('stranger', { register: false });
			const next = project('next', { register: false });
			const before = fs.readFileSync(projectsRegistryPath(configDir), 'utf8');
			expect(() => relocateProject(configDir, stranger, next)).toThrow(ProjectNotRegisteredError);
			expect(() => relocateProject(configDir, stranger, next)).toThrow(stranger);
			expect(fs.readFileSync(projectsRegistryPath(configDir), 'utf8')).toBe(before);
		});

		it('fails when the new directory is already registered', () => {
			const a = project('a');
			const b = project('b');
			const before = fs.readFileSync(projectsRegistryPath(configDir), 'utf8');
			expect(() => relocateProject(configDir, a, b)).toThrow(ProjectAlreadyRegisteredError);
			expect(fs.readFileSync(projectsRegistryPath(configDir), 'utf8')).toBe(before);
		});

		it('fails when the new directory does not exist, is a file, or is not an initialized task project', () => {
			const a = project('a');
			expect(() => relocateProject(configDir, a, path.join(root, 'nope'))).toThrow(/does not exist/);
			const file = path.join(root, 'f.txt');
			fs.writeFileSync(file, 'x');
			expect(() => relocateProject(configDir, a, file)).toThrow(/not a directory/);
			const bare = project('bare', { initialized: false, register: false });
			expect(() => relocateProject(configDir, a, bare)).toThrow(InvalidProjectPathError);
			expect(() => relocateProject(configDir, a, bare)).toThrow(/not an initialized task project/);
			expect(listRegisteredProjects(configDir)).toEqual([a]);
		});

		it('says how to initialise a directory that is not a task project', () => {
			const a = project('a');
			const bare = project('bare', { initialized: false, register: false });
			try {
				relocateProject(configDir, a, bare);
				expect.unreachable();
			} catch (error) {
				expect((error as InvalidProjectPathError).hint).toMatch(/task init|initialise/);
			}
		});

		it('refuses relative, NUL-containing and relative-segment paths on both sides', () => {
			const a = project('a');
			expect(() => relocateProject(configDir, 'rel/a', a)).toThrow(InvalidProjectPathError);
			expect(() => relocateProject(configDir, a, 'rel/b')).toThrow(InvalidProjectPathError);
			expect(() => relocateProject(configDir, a, path.join(root, 'x\0y'))).toThrow(/NUL/);
			expect(() => relocateProject(configDir, a, root + '/a/../a')).toThrow(/relative segment/);
		});

		it('refuses a move onto itself', () => {
			const a = project('a');
			expect(() => relocateProject(configDir, a, a)).toThrow(/same directory/);
		});

		it('fails loudly on a corrupt registry and leaves it untouched', () => {
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(projectsRegistryPath(configDir), '{not json');
			const next = project('next', { register: false });
			expect(() => relocateProject(configDir, path.join(root, 'a'), next)).toThrow(ProjectsRegistryError);
			expect(fs.readFileSync(projectsRegistryPath(configDir), 'utf8')).toBe('{not json');
		});

		it('is classified for the adapters: invalid path 400, unknown 404, duplicate 409', () => {
			const a = project('a');
			const b = project('b');
			expect(describeError(new InvalidProjectPathError('m', 'h')).kind).toBe('invalid');
			expect(describeError(new ProjectNotRegisteredError(a)).kind).toBe('not-found');
			expect(describeError(new ProjectAlreadyRegisteredError(b)).kind).toBe('conflict');
		});
	});

	describe('removeRegisteredProject (the remove path: registry entry only)', () => {
		it('unregisters the project and returns the entry as stored', () => {
			const a = project('a');
			const b = project('b');
			expect(removeRegisteredProject(configDir, a)).toEqual({ removed: a });
			expect(listRegisteredProjects(configDir)).toEqual([b]);
		});

		it('NEVER deletes the .task data nor the directory', () => {
			const a = project('a');
			fs.writeFileSync(path.join(a, '.task', 'tasks', 't.md'), 'data');
			removeRegisteredProject(configDir, a);
			expect(fs.readFileSync(path.join(a, '.task', 'tasks', 't.md'), 'utf8')).toBe('data');
		});

		it('removes an entry whose directory is gone', () => {
			const a = project('a');
			fs.rmSync(a, { recursive: true });
			expect(removeRegisteredProject(configDir, a)).toEqual({ removed: a });
			expect(listRegisteredProjects(configDir)).toEqual([]);
		});

		it('fails when the project is not registered and writes nothing', () => {
			const a = project('a');
			const before = fs.readFileSync(projectsRegistryPath(configDir), 'utf8');
			const other = path.join(root, 'other');
			expect(() => removeRegisteredProject(configDir, other)).toThrow(ProjectNotRegisteredError);
			expect(() => removeRegisteredProject(configDir, other)).toThrow(`project "${other}" is not registered`);
			expect(fs.readFileSync(projectsRegistryPath(configDir), 'utf8')).toBe(before);
			expect(listRegisteredProjects(configDir)).toEqual([a]);
		});

		it('refuses a relative path', () => {
			expect(() => removeRegisteredProject(configDir, 'rel')).toThrow(InvalidProjectPathError);
		});
	});
});
