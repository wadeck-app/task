import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProjectsRegistryError } from './errors.js';
import { registryLockPath, withRegistryLock } from './registryLock.js';
import { registerProject } from './projectsRegistry.js';

let root: string;
let configDir: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-registry-lock-'));
	configDir = path.join(root, 'config');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function failureOf(call: () => unknown): ProjectsRegistryError {
	try {
		call();
	} catch (error) {
		expect(error).toBeInstanceOf(ProjectsRegistryError);
		return error as ProjectsRegistryError;
	}
	throw new Error('expected the call to throw');
}

describe('withRegistryLock', () => {
	it('holds the lock file while running and removes it afterwards, returning the result', () => {
		const result = withRegistryLock(configDir, () => {
			expect(fs.existsSync(registryLockPath(configDir))).toBe(true);
			return 42;
		});
		expect(result).toBe(42);
		expect(fs.existsSync(registryLockPath(configDir))).toBe(false);
	});

	it('releases the lock when the callback throws, and rethrows the same error', () => {
		const boom = new Error('boom');
		expect(() =>
			withRegistryLock(configDir, () => {
				throw boom;
			})
		).toThrow(boom);
		expect(fs.existsSync(registryLockPath(configDir))).toBe(false);
	});

	it('fails loudly after the timeout when a live holder keeps the lock, naming the lock file and what to do', () => {
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(registryLockPath(configDir), String(process.pid));

		const error = failureOf(() => withRegistryLock(configDir, () => 'never', { timeoutMs: 100, staleMs: 60_000 }));

		expect(error.message).toContain(registryLockPath(configDir));
		expect(error.message).toContain('100');
		expect(error.hint).toContain('delete');
		expect(error.hint).toContain(registryLockPath(configDir));
		// The foreign lock is not ours: it must survive.
		expect(fs.existsSync(registryLockPath(configDir))).toBe(true);
	});

	it('takes over a lock nobody touched for staleMs (crashed holder)', () => {
		fs.mkdirSync(configDir, { recursive: true });
		const lock = registryLockPath(configDir);
		fs.writeFileSync(lock, '999999');
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(lock, old, old);

		expect(withRegistryLock(configDir, () => 'ran', { timeoutMs: 1000, staleMs: 5000 })).toBe('ran');
		expect(fs.existsSync(lock)).toBe(false);
	});

	it('wraps a config dir that cannot be created, with the writable hint', () => {
		// A file where the config dir should be: mkdir fails on every platform, whatever the user rights.
		const blocker = path.join(root, 'blocker');
		fs.writeFileSync(blocker, 'x');
		const target = path.join(blocker, 'config');

		const error = failureOf(() => registerProject(target, path.join(root, 'project')));

		expect(error.message).toContain(`cannot create ${target}`);
		expect(error.hint).toBe(`Check that ${target} is writable.`);
	});
});
