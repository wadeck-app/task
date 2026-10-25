import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	AmbiguousReferenceError,
	NoProjectInScopeError,
	ProjectNotFoundError,
	addPath,
	normalizePath,
	projectToolDir,
} from '@wadeck-app/project-sdk';

import { describeError } from './describeError.js';
import { resolveProject, resolveProjectReference } from './resolveProject.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

let sandbox: SharedRegistrySandbox;

beforeEach(() => {
	sandbox = createSharedRegistrySandbox();
});

afterEach(() => {
	sandbox.cleanup();
});

/** The directory as the CLI prints it (native separators, no trailing one). */
const native = (dir: string): string => path.resolve(dir);

describe('resolveProject: the shared registry', () => {
	it('-p <name> resolves the project; its data is in the registry data folder, not in <main path>/.task', async () => {
		const dir = sandbox.dir('shop', { task: true });
		const project = await sandbox.register('shop', dir);

		const resolved = resolveProject({ cwd: sandbox.root, projectRef: 'shop', env: sandbox.env });

		expect(resolved).toMatchObject({
			id: project.id,
			name: 'shop',
			path: native(dir),
			source: 'flag',
			via: '--project',
			registryDir: sandbox.registryDir,
		});
		expect(resolved.storage).toMatchObject({
			dataDir: projectToolDir(sandbox.registryDir, project.id, 'task', 'data'),
			mainDir: native(dir),
		});
	});

	it('-p accepts an alias, an id and a unique id prefix, case-insensitively', async () => {
		const dir = sandbox.dir('shop', { task: true });
		const project = await sandbox.register('shop', dir, { aliases: ['store'] });

		for (const ref of ['store', 'STORE', project.id, project.id.slice(0, 4)]) {
			expect(resolveProject({ cwd: sandbox.root, projectRef: ref, env: sandbox.env }).id, ref).toBe(project.id);
		}
	});

	it('TASK_PROJECT selects the project, and -p wins over it', async () => {
		const shop = await sandbox.register('shop', sandbox.dir('shop', { task: true }));
		const blog = await sandbox.register('blog', sandbox.dir('blog', { task: true }));
		const env = { ...sandbox.env, TASK_PROJECT: 'blog' };

		const fromEnv = resolveProject({ cwd: sandbox.root, env });
		expect(fromEnv).toMatchObject({ id: blog.id, source: 'env', via: 'TASK_PROJECT' });

		const fromFlag = resolveProject({ cwd: sandbox.root, projectRef: 'shop', env });
		expect(fromFlag).toMatchObject({ id: shop.id, source: 'flag' });
	});

	it('a blank TASK_PROJECT counts as unset', async () => {
		const dir = sandbox.dir('shop', { task: true });
		await sandbox.register('shop', dir);

		const resolved = resolveProject({ cwd: dir, env: { ...sandbox.env, TASK_PROJECT: '  ' } });

		expect(resolved.source).toBe('cwd');
	});

	it('the cwd inside a registered folder resolves the project (deepest registered ancestor)', async () => {
		const dir = sandbox.dir('shop', { task: true });
		const sub = path.join(dir, 'src', 'deep');
		fs.mkdirSync(sub, { recursive: true });
		const project = await sandbox.register('shop', dir);

		const resolved = resolveProject({ cwd: sub, env: sandbox.env });

		expect(resolved).toMatchObject({ id: project.id, path: native(dir), source: 'cwd', via: 'cwd' });
	});

	it('the cwd in a secondary path of the project resolves to the MAIN path (events run there)', async () => {
		const main = sandbox.dir('shop', { task: true });
		const worktree = sandbox.dir('shop-feature');
		const project = await sandbox.register('shop', main);
		await addPath(sandbox.registryDir, 'shop', worktree);

		const resolved = resolveProject({ cwd: worktree, env: sandbox.env });

		expect(resolved).toMatchObject({ id: project.id, path: native(main), source: 'cwd' });
	});

	it('a registered project whose main path has no .task is a fresh project, not an error (its data lives in the registry)', async () => {
		const dir = sandbox.dir('shop');
		const project = await sandbox.register('shop', dir);

		const resolved = resolveProject({ cwd: sandbox.root, projectRef: 'shop', env: sandbox.env });

		expect(resolved).toMatchObject({ id: project.id, path: native(dir), source: 'flag' });
		expect(fs.existsSync(resolved.storage.dataDir)).toBe(false);
	});

	it('resolving never refuses an unmigrated project (migrate-data needs to resolve it); opening its context does (see openContext.test.ts)', async () => {
		const dir = sandbox.dir('shop', { task: true });
		fs.writeFileSync(path.join(dir, '.task', 'tasks', 'one.json'), '{}');
		await sandbox.register('shop', dir);

		expect(resolveProject({ cwd: dir, env: sandbox.env }).source).toBe('cwd');
	});

	it('a reference that does not resolve is an error with suggestions, never a fallback', async () => {
		const dir = sandbox.dir('shop', { task: true });
		await sandbox.register('shop', dir);

		const failure = captureError(() => resolveProject({ cwd: dir, projectRef: 'shpo', env: sandbox.env }));

		expect(failure).toBeInstanceOf(ProjectNotFoundError);
		expect((failure as ProjectNotFoundError).suggestions.map(s => s.text)).toEqual(['shop']);
		expect(describeError(failure).kind).toBe('not-found');
	});

	it('an id prefix shared by two projects lists the candidates (kind ambiguous), nothing is guessed', () => {
		// Ids are random, so the registry file is forged for this case (the SDK mutations cannot choose an id).
		fs.mkdirSync(sandbox.registryDir, { recursive: true });
		const project = (id: string, name: string): object => ({
			id,
			name,
			aliases: [],
			paths: [],
			createdAt: '2026-10-24T00:00:00.000Z',
		});
		fs.writeFileSync(
			path.join(sandbox.registryDir, 'registry.json'),
			JSON.stringify({
				schemaVersion: 1,
				projects: [project('abcd0001', 'first'), project('abcd0002', 'second')],
			})
		);

		const failure = captureError(() => resolveProject({ cwd: sandbox.root, projectRef: 'abcd', env: sandbox.env }));

		expect(failure).toBeInstanceOf(AmbiguousReferenceError);
		const described = describeError(failure);
		expect(described.kind).toBe('ambiguous');
		expect(described.details['candidates']).toEqual([
			{ id: 'abcd0001', name: 'first' },
			{ id: 'abcd0002', name: 'second' },
		]);
	});

	it('a virtual project (no path) resolves: its data is id-based, it has no path (and so no cwd for events)', async () => {
		const project = await sandbox.register('config-only', undefined);

		const resolved = resolveProject({ cwd: sandbox.root, projectRef: 'config-only', env: sandbox.env });

		expect(resolved.id).toBe(project.id);
		expect(resolved.path).toBeUndefined();
		expect(resolved.storage.dataDir).toBe(projectToolDir(sandbox.registryDir, project.id, 'task', 'data'));
		expect(resolved.storage.mainDir).toBeUndefined();
		expect(resolved.logLine).toContain('virtual');
	});

	it('the log line says how the project was resolved: project, source, path and registry dir', async () => {
		const dir = sandbox.dir('shop', { task: true });
		const project = await sandbox.register('shop', dir);

		const { logLine } = resolveProject({ cwd: dir, env: sandbox.env });

		expect(logLine).toContain(`shop (${project.id})`);
		expect(logLine).toContain('via cwd');
		expect(logLine).toContain(sandbox.registryDir);
		expect(logLine).toContain(projectToolDir(sandbox.registryDir, project.id, 'task', 'data'));
	});
});

describe('resolveProject: folders the registry does not know (the legacy path is gone)', () => {
	it('an unregistered cwd fails with the neutral registry error and the hint to register it, even when it holds a .task', () => {
		const dir = sandbox.dir('old', { task: true });

		const failure = captureError(() => resolveProject({ cwd: dir, env: sandbox.env }));

		expect(failure).toBeInstanceOf(NoProjectInScopeError);
		const described = describeError(failure);
		expect(described.kind).toBe('not-found');
		expect(described.message).toContain(native(dir));
		expect(described.hint).toContain(`project add "${native(dir)}"`);
		expect(described.hint).not.toContain('task init');
		expect(described.hint).not.toContain('migrate-data');
	});

	it('the registry is not created by a failed resolution (first-use state)', () => {
		const dir = sandbox.dir('old', { task: true });

		expect(captureError(() => resolveProject({ cwd: dir, env: sandbox.env }))).toBeInstanceOf(
			NoProjectInScopeError
		);
		expect(fs.existsSync(sandbox.registryDir)).toBe(false);
	});

	it('a subfolder with a .task of its own inside a registered folder resolves to the registered project', async () => {
		const parent = sandbox.dir('mono', { task: true });
		const nested = path.join(parent, 'packages', 'app');
		fs.mkdirSync(path.join(nested, '.task', 'tasks'), { recursive: true });
		const project = await sandbox.register('mono', parent);

		const resolved = resolveProject({ cwd: nested, env: sandbox.env });

		expect(resolved).toMatchObject({ id: project.id, source: 'cwd', path: native(parent) });
	});

	it('TASK_PROJECT_DIR and PROJECT_DIR select nothing: the cwd decides', async () => {
		const registered = sandbox.dir('shop', { task: true });
		await sandbox.register('shop', registered);
		const elsewhere = sandbox.dir('elsewhere');

		for (const name of ['TASK_PROJECT_DIR', 'PROJECT_DIR']) {
			const env = { ...sandbox.env, [name]: registered };
			expect(
				captureError(() => resolveProject({ cwd: elsewhere, env })),
				name
			).toBeInstanceOf(NoProjectInScopeError);
			expect(resolveProject({ cwd: registered, env: { ...env, [name]: elsewhere } }).via, name).toBe('cwd');
		}
	});

	it('a corrupt registry is the error, for the cwd and for a reference', () => {
		const bare = sandbox.dir('bare');
		fs.mkdirSync(sandbox.registryDir, { recursive: true });
		fs.writeFileSync(path.join(sandbox.registryDir, 'registry.json'), '{ not json');

		const noTask = captureError(() => resolveProject({ cwd: bare, env: sandbox.env }));
		const withRef = captureError(() => resolveProject({ cwd: bare, projectRef: 'x', env: sandbox.env }));

		for (const failure of [noTask, withRef]) {
			expect((failure as Error).name).toBe('RegistryCorruptError');
			expect(describeError(failure).kind).toBe('internal');
		}
	});
});

function captureError(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error('expected the call to throw');
}

describe('resolveProjectReference: a caller without a cwd (the app-module)', () => {
	it('resolves a name, an alias or an id like -p does, from the registry only', async () => {
		const dir = sandbox.dir('shop', { task: true });
		const project = await sandbox.register('shop', dir, { aliases: ['store'] });

		for (const ref of ['shop', 'store', project.id]) {
			expect(resolveProjectReference(ref, sandbox.env)).toMatchObject({
				id: project.id,
				path: native(dir),
				source: 'flag',
			});
		}
	});

	it('never reads TASK_PROJECT nor a path: an unknown reference is the typed error with suggestions', async () => {
		await sandbox.register('shop', sandbox.dir('shop', { task: true }));
		const env = { ...sandbox.env, TASK_PROJECT: 'shop' };

		const failure = captureError(() => resolveProjectReference('shpo', env));

		expect(failure).toBeInstanceOf(ProjectNotFoundError);
		expect(captureError(() => resolveProjectReference(sandbox.dir('shop'), env))).toBeInstanceOf(
			ProjectNotFoundError
		);
	});
});
