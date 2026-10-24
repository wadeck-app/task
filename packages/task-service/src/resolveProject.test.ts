import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	AmbiguousReferenceError,
	NoProjectInScopeError,
	ProjectNotFoundError,
	VirtualProjectError,
	addPath,
	normalizePath,
} from '@wadeck-app/project-sdk';

import { describeError } from './describeError.js';
import { ConflictingProjectSelectionError, ProjectNotInitializedError } from './errors.js';
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
	it('-p <name> resolves the project and reads its data from <main path>/.task', async () => {
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
		expect(resolved.legacyWarning).toBeUndefined();
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
		expect(resolved.legacyWarning).toBeUndefined();
	});

	it('the cwd in a secondary path of the project reads the data of the MAIN path', async () => {
		const main = sandbox.dir('shop', { task: true });
		const worktree = sandbox.dir('shop-feature');
		const project = await sandbox.register('shop', main);
		await addPath(sandbox.registryDir, 'shop', worktree);

		const resolved = resolveProject({ cwd: worktree, env: sandbox.env });

		expect(resolved).toMatchObject({ id: project.id, path: native(main), source: 'cwd' });
	});

	it('a project whose main path has no .task is refused naming the project and the folder', async () => {
		const dir = sandbox.dir('shop');
		await sandbox.register('shop', dir);

		const failure = captureError(() => resolveProject({ cwd: sandbox.root, projectRef: 'shop', env: sandbox.env }));

		expect(failure).toBeInstanceOf(ProjectNotInitializedError);
		expect((failure as Error).message).toContain('shop');
		expect((failure as Error).message).toContain(native(dir));
		expect(describeError(failure).hint).toContain('task init');
	});

	it('a reference that does not resolve is an error with suggestions, never a fallback to the legacy rules', async () => {
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

	it('a virtual project (no path) fails loudly naming the project', async () => {
		await sandbox.register('config-only', undefined);

		const failure = captureError(() =>
			resolveProject({ cwd: sandbox.root, projectRef: 'config-only', env: sandbox.env })
		);

		expect(failure).toBeInstanceOf(VirtualProjectError);
		expect((failure as Error).message).toContain('config-only');
		expect(describeError(failure).kind).toBe('invalid');
	});

	it('-p together with --project-dir is a contradiction', async () => {
		const dir = sandbox.dir('shop', { task: true });
		await sandbox.register('shop', dir);

		const failure = captureError(() =>
			resolveProject({ cwd: dir, projectRef: 'shop', projectDir: dir, env: sandbox.env })
		);

		expect(failure).toBeInstanceOf(ConflictingProjectSelectionError);
		expect(describeError(failure).hint).toContain('--project-dir');
	});

	it('a registered directory given by --project-dir, TASK_PROJECT_DIR or PROJECT_DIR resolves in the registry without warning', async () => {
		const dir = sandbox.dir('shop', { task: true });
		const project = await sandbox.register('shop', dir);

		const byFlag = resolveProject({ cwd: sandbox.root, projectDir: dir, env: sandbox.env });
		const byTaskEnv = resolveProject({ cwd: sandbox.root, env: { ...sandbox.env, TASK_PROJECT_DIR: dir } });
		const byGeneric = resolveProject({ cwd: sandbox.root, env: { ...sandbox.env, PROJECT_DIR: dir } });

		for (const resolved of [byFlag, byTaskEnv, byGeneric]) {
			expect(resolved).toMatchObject({ id: project.id, source: 'cwd', path: native(dir) });
			expect(resolved.legacyWarning).toBeUndefined();
		}
		expect(byFlag.via).toBe('--project-dir');
		expect(byTaskEnv.via).toBe('TASK_PROJECT_DIR');
		expect(byGeneric.via).toBe('PROJECT_DIR');
	});

	it('the log line says how the project was resolved: project, source, path and registry dir', async () => {
		const dir = sandbox.dir('shop', { task: true });
		const project = await sandbox.register('shop', dir);

		const { logLine } = resolveProject({ cwd: dir, env: sandbox.env });

		expect(logLine).toContain(`shop (${project.id})`);
		expect(logLine).toContain('via cwd');
		expect(logLine).toContain(sandbox.registryDir);
		expect(logLine).toContain(path.join(native(dir), '.task'));
	});
});

describe('resolveProject: the legacy path (removed in stage 2)', () => {
	it('an unregistered cwd holding a .task still works, with a warning naming the dir and the command to register it', () => {
		const dir = sandbox.dir('old', { task: true });

		const resolved = resolveProject({ cwd: dir, env: sandbox.env });

		expect(resolved).toMatchObject({ name: 'old', path: native(dir), source: 'legacy', via: 'cwd' });
		expect(resolved.id).toBeUndefined();
		expect(resolved.legacyWarning).toContain(native(dir));
		expect(resolved.legacyWarning).toContain(`project add "${native(dir)}"`);
		expect(resolved.legacyWarning).toContain('removed');
		expect(resolved.logLine).toContain('legacy');
		expect(resolved.logLine).toContain(sandbox.registryDir);
	});

	it('--project-dir, TASK_PROJECT_DIR and PROJECT_DIR keep working for an unregistered dir, in that order, with the warning', () => {
		const flagDir = sandbox.dir('by-flag', { task: true });
		const taskDir = sandbox.dir('by-task-env', { task: true });
		const genericDir = sandbox.dir('by-generic-env', { task: true });
		const env = { ...sandbox.env, TASK_PROJECT_DIR: taskDir, PROJECT_DIR: genericDir };

		const byFlag = resolveProject({ cwd: sandbox.root, projectDir: flagDir, env });
		const byTask = resolveProject({ cwd: sandbox.root, env });
		const byGeneric = resolveProject({ cwd: sandbox.root, env: { ...sandbox.env, PROJECT_DIR: genericDir } });

		expect(byFlag).toMatchObject({ path: native(flagDir), source: 'legacy', via: '--project-dir' });
		expect(byTask).toMatchObject({ path: native(taskDir), source: 'legacy', via: 'TASK_PROJECT_DIR' });
		expect(byGeneric).toMatchObject({ path: native(genericDir), source: 'legacy', via: 'PROJECT_DIR' });
		for (const resolved of [byFlag, byTask, byGeneric]) {
			expect(resolved.legacyWarning).toContain(`project add "${resolved.path}"`);
		}
	});

	it('a relative --project-dir is resolved against the cwd, as before', () => {
		const dir = sandbox.dir('rel', { task: true });

		const resolved = resolveProject({ cwd: path.dirname(dir), projectDir: 'rel', env: sandbox.env });

		expect(resolved.path).toBe(native(dir));
	});

	it('a subfolder with its own .task inside a registered project keeps its own data (never silently switched), with a warning', async () => {
		const parent = sandbox.dir('mono', { task: true });
		const nested = path.join(parent, 'packages', 'app');
		fs.mkdirSync(path.join(nested, '.task', 'tasks'), { recursive: true });
		const project = await sandbox.register('mono', parent);

		const resolved = resolveProject({ cwd: nested, env: sandbox.env });

		expect(resolved).toMatchObject({ path: native(nested), source: 'legacy' });
		expect(resolved.legacyWarning).toContain(native(nested));
		expect(resolved.legacyWarning).toContain(project.name);
	});

	it('a registered folder itself wins over its own .task copy being a legacy entry (the folder is registered)', async () => {
		const worktree = sandbox.dir('shop-feature', { task: true });
		const main = sandbox.dir('shop', { task: true });
		await sandbox.register('shop', main);
		await addPath(sandbox.registryDir, 'shop', worktree);

		const resolved = resolveProject({ cwd: worktree, env: sandbox.env });

		expect(resolved).toMatchObject({ source: 'cwd', path: native(main) });
	});

	it('nothing resolves and there is no .task: "project not initialized", the task init step and the project add hint', () => {
		const dir = sandbox.dir('bare');

		const failure = captureError(() => resolveProject({ cwd: dir, env: sandbox.env }));

		expect(failure).toBeInstanceOf(ProjectNotInitializedError);
		const described = describeError(failure);
		expect(described.message).toContain('project not initialized');
		expect(described.hint).toContain('task init');
		// The hint is the SDK's own (its normalised form of the folder: forward slashes).
		expect(described.hint).toContain(`project add "${normalizePath(dir)}"`);
	});

	it('a corrupt registry does not break a legacy project: it works, and the warning carries the registry problem', () => {
		const dir = sandbox.dir('old', { task: true });
		fs.mkdirSync(sandbox.registryDir, { recursive: true });
		fs.writeFileSync(path.join(sandbox.registryDir, 'registry.json'), '{ not json');

		const resolved = resolveProject({ cwd: dir, env: sandbox.env });

		expect(resolved.source).toBe('legacy');
		expect(resolved.legacyWarning).toContain('registry.json');
	});

	it('a corrupt registry is the error when there is nothing to fall back on, and when a reference is given', () => {
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

	it('no registry file at all is the first-use state: the legacy path works', () => {
		const dir = sandbox.dir('old', { task: true });

		expect(fs.existsSync(sandbox.registryDir)).toBe(false);
		expect(resolveProject({ cwd: dir, env: sandbox.env }).source).toBe('legacy');
		expect(fs.existsSync(sandbox.registryDir)).toBe(false);
	});

	it('the NoProjectInScopeError data is carried by the not-initialized error', () => {
		const dir = sandbox.dir('bare');

		const failure = captureError(() => resolveProject({ cwd: dir, env: sandbox.env }));

		expect((failure as ProjectNotInitializedError).scopeError).toBeInstanceOf(NoProjectInScopeError);
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
