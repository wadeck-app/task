import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectsRegistryError } from './errors.js';
import { listRegisteredProjects } from './projectsRegistry.js';
import { registerInitializedProject } from './registerInitializedProject.js';

describe('registerInitializedProject', () => {
	let root: string;
	let configDir: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-reg-init-'));
		configDir = path.join(root, 'config');
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('registers a directory holding .task', () => {
		const dir = path.join(root, 'p');
		fs.mkdirSync(path.join(dir, '.task'), { recursive: true });
		expect(registerInitializedProject(configDir, dir)).toEqual({ path: dir, added: true });
		expect(listRegisteredProjects(configDir)).toEqual([dir]);
	});

	it('is idempotent', () => {
		const dir = path.join(root, 'p');
		fs.mkdirSync(path.join(dir, '.task'), { recursive: true });
		registerInitializedProject(configDir, dir);
		expect(registerInitializedProject(configDir, dir)).toEqual({ path: dir, added: false });
		expect(listRegisteredProjects(configDir)).toEqual([dir]);
	});

	it('refuses a directory without .task, naming `task init` as the fix, and writes nothing', () => {
		const dir = path.join(root, 'bare');
		fs.mkdirSync(dir);
		let caught: unknown;
		try {
			registerInitializedProject(configDir, dir);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ProjectsRegistryError);
		expect((caught as ProjectsRegistryError).message).toContain(dir);
		expect((caught as ProjectsRegistryError).hint).toContain('task init');
		expect(listRegisteredProjects(configDir)).toEqual([]);
	});

	it('refuses a directory that does not exist', () => {
		expect(() => registerInitializedProject(configDir, path.join(root, 'nope'))).toThrow(ProjectsRegistryError);
	});
});
