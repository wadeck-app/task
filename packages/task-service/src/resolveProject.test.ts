import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	AmbiguousReferenceError,
	NoProjectInScopeError,
	ProjectOptionError,
	ProjectNotFoundError,
	addPath,
	normalizePath,
	projectToolDir,
} from '@wadeck-app/project-sdk';

import { describeError } from './describeError.js';
import {
	readProjectOption,
	resolveProject,
	resolveProjectFromArgs,
	resolveProjectReference,
} from './resolveProject.js';
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
	it('-p <name> resolves the project; its data is in the registry data folder', async () => {
		const dir = sandbox.dir('shop');
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
		});
	});

	it('-p accepts an alias, an id and a unique id prefix, case-insensitively', async () => {
		const dir = sandbox.dir('shop');
		const project = await sandbox.register('shop', dir, { aliases: ['store'] });

		for (const ref of ['store', 'STORE', project.id, project.id.slice(0, 4)]) {
			expect(resolveProject({ cwd: sandbox.root, projectRef: ref, env: sandbox.env }).id, ref).toBe(project.id);
		}
	});

	it('TASK_PROJECT selects the project, and -p wins over it', async () => {
		const shop = await sandbox.register('shop', sandbox.dir('shop'));
		const blog = await sandbox.register('blog', sandbox.dir('blog'));
		const env = { ...sandbox.env, TASK_PROJECT: 'blog' };

		const fromEnv = resolveProject({ cwd: sandbox.root, env });
		expect(fromEnv).toMatchObject({ id: blog.id, source: 'env', via: 'TASK_PROJECT' });

		const fromFlag = resolveProject({ cwd: sandbox.root, projectRef: 'shop', env });
		expect(fromFlag).toMatchObject({ id: shop.id, source: 'flag' });
	});

	it('a blank TASK_PROJECT counts as unset', async () => {
		const dir = sandbox.dir('shop');
		await sandbox.register('shop', dir);

		const resolved = resolveProject({ cwd: dir, env: { ...sandbox.env, TASK_PROJECT: '  ' } });

		expect(resolved.source).toBe('cwd');
	});

	it('the cwd inside a registered folder resolves the project (deepest registered ancestor)', async () => {
		const dir = sandbox.dir('shop');
		const sub = path.join(dir, 'src', 'deep');
		fs.mkdirSync(sub, { recursive: true });
		const project = await sandbox.register('shop', dir);

		const resolved = resolveProject({ cwd: sub, env: sandbox.env });

		expect(resolved).toMatchObject({ id: project.id, path: native(dir), source: 'cwd', via: 'cwd' });
	});

	it('the cwd in a secondary path of the project resolves to the MAIN path (events run there)', async () => {
		const main = sandbox.dir('shop');
		const worktree = sandbox.dir('shop-feature');
		const project = await sandbox.register('shop', main);
		await addPath(sandbox.registryDir, 'shop', worktree);

		const resolved = resolveProject({ cwd: worktree, env: sandbox.env });

		expect(resolved).toMatchObject({ id: project.id, path: native(main), source: 'cwd' });
	});

	it('a registered project with no data yet is a fresh project, not an error (its data lives in the registry)', async () => {
		const dir = sandbox.dir('shop');
		const project = await sandbox.register('shop', dir);

		const resolved = resolveProject({ cwd: sandbox.root, projectRef: 'shop', env: sandbox.env });

		expect(resolved).toMatchObject({ id: project.id, path: native(dir), source: 'flag' });
		expect(fs.existsSync(resolved.storage.dataDir)).toBe(false);
	});

	it('a reference that does not resolve is an error with suggestions, never a fallback', async () => {
		const dir = sandbox.dir('shop');
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
		expect(resolved.logLine).toContain('virtual');
	});

	it('the log line says how the project was resolved: project, source, path and registry dir', async () => {
		const dir = sandbox.dir('shop');
		const project = await sandbox.register('shop', dir);

		const { logLine } = resolveProject({ cwd: dir, env: sandbox.env });

		expect(logLine).toContain(`shop (${project.id})`);
		expect(logLine).toContain('via cwd');
		expect(logLine).toContain(sandbox.registryDir);
		expect(logLine).toContain(projectToolDir(sandbox.registryDir, project.id, 'task', 'data'));
	});
});

describe('resolveProject: folders the registry does not know', () => {
	it('an unregistered cwd fails with the neutral registry error and the hint to register it', () => {
		const dir = sandbox.dir('old');

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
		const dir = sandbox.dir('old');

		expect(captureError(() => resolveProject({ cwd: dir, env: sandbox.env }))).toBeInstanceOf(
			NoProjectInScopeError
		);
		expect(fs.existsSync(sandbox.registryDir)).toBe(false);
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
		const dir = sandbox.dir('shop');
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
		await sandbox.register('shop', sandbox.dir('shop'));
		const env = { ...sandbox.env, TASK_PROJECT: 'shop' };

		const failure = captureError(() => resolveProjectReference('shpo', env));

		expect(failure).toBeInstanceOf(ProjectNotFoundError);
		expect(captureError(() => resolveProjectReference(sandbox.dir('shop'), env))).toBeInstanceOf(
			ProjectNotFoundError
		);
	});
});

describe('readProjectOption and resolveProjectFromArgs (the SDK rules, wrapped)', () => {
	it('readProjectOption takes -p, --project x and --project=x out of argv and reads TASK_PROJECT (blank = unset)', () => {
		expect(readProjectOption(['list', '-p', 'a', '--all'], {})).toEqual({ args: ['list', '--all'], flag: 'a' });
		expect(readProjectOption(['--project=b', 'list'], { TASK_PROJECT: 'c' })).toEqual({
			args: ['list'],
			flag: 'b',
			env: 'c',
		});
		expect(readProjectOption(['list'], { TASK_PROJECT: '  ' })).toEqual({ args: ['list'] });
	});

	it('refuses a missing value and a repeated flag with the SDK error, and reads nothing after --', () => {
		expect(() => readProjectOption(['list', '-p'], {})).toThrow(ProjectOptionError);
		expect(() => readProjectOption(['-p', 'a', '--project=b'], {})).toThrow(ProjectOptionError);
		expect(readProjectOption(['list', '--', '-p'], {}).args).toEqual(['list', '--', '-p']);
	});

	it('resolveProjectFromArgs resolves flag > TASK_PROJECT > cwd and returns the other arguments', async () => {
		const dir = path.join(sandbox.root, 'shop');
		fs.mkdirSync(dir, { recursive: true });
		const project = await sandbox.register('shop', dir);
		const env = { ...sandbox.env, TASK_PROJECT: 'nothing-like-it' };

		const byFlag = resolveProjectFromArgs({ cwd: sandbox.root, argv: ['list', '-p', project.id], env });
		expect(byFlag.project).toMatchObject({ id: project.id, source: 'flag' });
		expect(byFlag.args).toEqual(['list']);
		expect(() => resolveProjectFromArgs({ cwd: sandbox.root, argv: ['list'], env })).toThrow(ProjectNotFoundError);
		expect(resolveProjectFromArgs({ cwd: dir, argv: ['list'], env: sandbox.env }).project.source).toBe('cwd');
	});
});
