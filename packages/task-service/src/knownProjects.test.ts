import * as fs from 'node:fs';
import * as path from 'node:path';

import { projectToolDir, setFavorite, setPriority } from '@wadeck-app/project-sdk';

import { compareByImportance, listKnownProjects } from './knownProjects.js';
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
		const shop = sandbox.dir('shop-dir');
		const project = await sandbox.register('shop', shop);

		const known = list();

		expect(known.registryProblem).toBeNull();
		expect(known.projects).toEqual([
			{
				id: project.id,
				name: 'shop',
				favorite: false,
				priority: 'normal',
				path: path.resolve(shop),
				storage: expect.objectContaining({
					dataDir: projectToolDir(sandbox.registryDir, project.id, 'task', 'data'),
				}) as unknown,
			},
		]);
	});

	it('lists a registered project that has no data yet: its data lives in the registry, any project can hold tasks', async () => {
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

describe('listKnownProjects: importance order (favorites, then priority, then name)', () => {
	it('lists favorites first, then high, normal and low, then by name; carries favorite and priority', async () => {
		for (const name of ['delta', 'alpha', 'echo', 'bravo', 'charlie', 'foxtrot']) {
			await sandbox.register(name, sandbox.dir(name));
		}
		await setFavorite(sandbox.registryDir, 'foxtrot', true);
		await setFavorite(sandbox.registryDir, 'echo', true);
		await setPriority(sandbox.registryDir, 'echo', 'low');
		await setPriority(sandbox.registryDir, 'delta', 'high');
		await setPriority(sandbox.registryDir, 'alpha', 'low');

		expect(list().projects.map(p => [p.name, p.favorite, p.priority])).toEqual([
			['foxtrot', true, 'normal'],
			['echo', true, 'low'],
			['delta', false, 'high'],
			['bravo', false, 'normal'],
			['charlie', false, 'normal'],
			['alpha', false, 'low'],
		]);
	});

	it('a registry without favorite and priority fields lists everything normal, by name', async () => {
		await sandbox.register('zed', sandbox.dir('zed'));
		await sandbox.register('abe', sandbox.dir('abe'));

		expect(list().projects.map(p => [p.name, p.favorite, p.priority])).toEqual([
			['abe', false, 'normal'],
			['zed', false, 'normal'],
		]);
	});
});

describe('compareByImportance (the SDK order, for the adapters)', () => {
	it('puts favorites first, then high, normal, low, then the name; absent fields mean not favorite and normal', () => {
		const items = [
			{ id: '1', name: 'low', priority: 'low' as const },
			{ id: '2', name: 'plain' },
			{ id: '3', name: 'zfav', favorite: true },
			{ id: '4', name: 'high', favorite: false, priority: 'high' as const },
			{ id: '5', name: 'Aplain', priority: 'normal' as const },
		];

		expect([...items].sort(compareByImportance).map(i => i.name)).toEqual(['zfav', 'high', 'Aplain', 'plain', 'low']);
	});
});
