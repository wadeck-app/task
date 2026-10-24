import * as fs from 'node:fs';
import * as path from 'node:path';

import { ProjectsRegistryError } from './errors.js';
import { listKnownProjects } from './knownProjects.js';
import { registerProject } from './projectsRegistry.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

let sandbox: SharedRegistrySandbox;
let configDir: string;

beforeEach(() => {
	sandbox = createSharedRegistrySandbox();
	// The legacy registry (projects.json) lives in the task config dir.
	configDir = path.join(sandbox.root, 'task-config');
	fs.mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
	sandbox.cleanup();
});

const list = (): ReturnType<typeof listKnownProjects> => listKnownProjects(configDir, { env: sandbox.env });

describe('listKnownProjects: the shared registry first, the legacy projects.json second', () => {
	it('lists registered projects with their id and registry name, then the legacy-only ones marked unregistered', async () => {
		const shop = sandbox.dir('shop-dir', { task: true });
		const old = sandbox.dir('old', { task: true });
		const project = await sandbox.register('shop', shop);
		registerProject(configDir, old);

		const known = list();

		expect(known.registryProblem).toBeNull();
		expect(known.projects).toEqual([
			{ id: project.id, name: 'shop', path: path.resolve(shop), registered: true },
			{ name: 'old', path: path.resolve(old), registered: false },
		]);
	});

	it('shows a project once when both registries name it: the registry row wins (and its name)', async () => {
		const dir = sandbox.dir('shop-dir', { task: true });
		await sandbox.register('shop', dir);
		registerProject(configDir, dir);

		const known = list();

		expect(known.projects.map(p => [p.name, p.registered])).toEqual([['shop', true]]);
	});

	it('leaves out a registered project that has no .task and no legacy entry (it is not a task project)', async () => {
		await sandbox.register('flow-only', sandbox.dir('flow-only'));

		expect(list().projects).toEqual([]);
	});

	it('keeps a registered project without .task when the legacy registry lists it (its problem must stay visible)', async () => {
		const dir = sandbox.dir('gone');
		await sandbox.register('gone', dir);
		registerProject(configDir, dir);

		expect(list().projects.map(p => [p.name, p.registered])).toEqual([['gone', true]]);
	});

	it('leaves out a virtual project (no path, no task data in this version)', async () => {
		await sandbox.register('config-only', undefined);

		expect(list().projects).toEqual([]);
	});

	it('an unreadable shared registry does not hide the legacy projects: they are listed and the problem is reported', () => {
		const old = sandbox.dir('old', { task: true });
		registerProject(configDir, old);
		fs.mkdirSync(sandbox.registryDir, { recursive: true });
		fs.writeFileSync(path.join(sandbox.registryDir, 'registry.json'), '{ nope');

		const known = list();

		expect(known.projects.map(p => [p.name, p.registered])).toEqual([['old', false]]);
		expect(known.registryProblem).toContain('registry.json');
	});

	it('a missing shared registry is the first-use state, not a problem', () => {
		expect(list()).toMatchObject({ projects: [], registryProblem: null });
		expect(fs.existsSync(sandbox.registryDir)).toBe(false);
	});

	it('a corrupt projects.json is still an error (never read as nothing registered)', () => {
		fs.writeFileSync(path.join(configDir, 'projects.json'), '{ nope');

		expect(list).toThrow(ProjectsRegistryError);
	});
});
