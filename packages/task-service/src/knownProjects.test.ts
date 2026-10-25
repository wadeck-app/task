import * as fs from 'node:fs';
import * as path from 'node:path';

import { projectToolDir } from '@wadeck-app/project-sdk';

import { listKnownProjects } from './knownProjects.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

let sandbox: SharedRegistrySandbox;

beforeEach(() => {
	sandbox = createSharedRegistrySandbox();
});

afterEach(() => {
	sandbox.cleanup();
});

const list = (): ReturnType<typeof listKnownProjects> => listKnownProjects({ env: sandbox.env });

describe('listKnownProjects: the projects of the shared registry that have a folder', () => {
	it('lists registered projects with their id, registry name, main path and registry storage', async () => {
		const shop = sandbox.dir('shop-dir', { task: true });
		const project = await sandbox.register('shop', shop);

		const known = list();

		expect(known.registryProblem).toBeNull();
		expect(known.projects).toEqual([
			{
				id: project.id,
				name: 'shop',
				path: path.resolve(shop),
				storage: expect.objectContaining({
					dataDir: projectToolDir(sandbox.registryDir, project.id, 'task', 'data'),
				}) as unknown,
			},
		]);
	});

	it('lists a registered project that has no .task: its data lives in the registry, any project can hold tasks', async () => {
		await sandbox.register('fresh', sandbox.dir('fresh'));

		expect(list().projects.map(p => p.name)).toEqual(['fresh']);
	});

	it('a broken parent chain does not hide the project: it is listed with the problem, on its own storage', async () => {
		const child = await sandbox.register('child', sandbox.dir('child'));
		const registryFile = path.join(sandbox.registryDir, 'registry.json');
		const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')) as { projects: Array<{ parent?: string }> };
		registry.projects[0]!.parent = 'deadbeef';
		fs.writeFileSync(registryFile, JSON.stringify(registry));

		const [entry] = list().projects;

		expect(entry).toMatchObject({ id: child.id });
		expect(entry!.problem).toContain('deadbeef');
		expect(entry!.storage.dataDir).toContain(child.id);
	});

	it('leaves out a virtual project (no folder: the cross-project views and the module address projects by folder)', async () => {
		await sandbox.register('config-only', undefined);

		expect(list().projects).toEqual([]);
	});

	it('an unreadable shared registry lists nothing and reports the problem', () => {
		fs.mkdirSync(sandbox.registryDir, { recursive: true });
		fs.writeFileSync(path.join(sandbox.registryDir, 'registry.json'), '{ nope');

		const known = list();

		expect(known.projects).toEqual([]);
		expect(known.registryProblem).toContain('registry.json');
	});

	it('a missing shared registry is the first-use state, not a problem', () => {
		expect(list()).toMatchObject({ projects: [], registryProblem: null });
		expect(fs.existsSync(sandbox.registryDir)).toBe(false);
	});
});
