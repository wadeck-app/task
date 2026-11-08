import { LOCAL_CAPABILITIES, LocalFileBackend } from '@wadeck-app/task-core';
import type { TaskBackend } from '@wadeck-app/task-core';

import { createLazyBackend } from './lazyBackend.js';
import type { StrategyInstance, StrategyPlugin } from './plugins/kinds.js';

function fakePlugin(): StrategyPlugin {
	return {
		extensionPoint: 'strategy',
		backendKind: 'github',
		capabilities: LOCAL_CAPABILITIES,
		fillTechniques: {},
		validate: () => undefined,
		create: () => Promise.reject(new Error('not used')),
		describe: () => ({ summary: '', options: {}, snippet: '' }),
	};
}

function instanceOver(backend: Partial<TaskBackend>): StrategyInstance & { disposed: number } {
	const instance = {
		disposed: 0,
		backend: backend as TaskBackend,
		describe: () => [],
		check: () => Promise.resolve([]),
		dispose: () => {
			instance.disposed += 1;
			return Promise.resolve();
		},
	};
	return instance;
}

describe('createLazyBackend', () => {
	it('answers kind and capabilities from the plugin without creating anything', () => {
		const open = vi.fn();

		const lazy = createLazyBackend(fakePlugin(), open);

		expect(lazy.backend.kind).toBe('github');
		expect(lazy.backend.capabilities).toBe(LOCAL_CAPABILITIES);
		expect(open).not.toHaveBeenCalled();
	});

	it('is not mistaken for a promise when awaited', async () => {
		const lazy = createLazyBackend(fakePlugin(), vi.fn());

		// Promise.resolve adopts a thenable: it would hang or reject if the proxy answered to `then`.
		await expect(Promise.resolve(lazy.backend)).resolves.toBe(lazy.backend);
	});

	it('creates the instance at the first call, once, however many calls and however concurrent', async () => {
		const list = vi.fn().mockResolvedValue([]);
		const instance = instanceOver({ list });
		const open = vi.fn().mockResolvedValue(instance);
		const lazy = createLazyBackend(fakePlugin(), open);

		await Promise.all([lazy.backend.list(), lazy.backend.list()]);
		await lazy.backend.list();

		expect(open).toHaveBeenCalledTimes(1);
		expect(list).toHaveBeenCalledTimes(3);
	});

	it('forwards the arguments and the result, and the call keeps its this', async () => {
		const get = vi.fn().mockResolvedValue({ id: 'a' });
		const lazy = createLazyBackend(fakePlugin(), () => Promise.resolve(instanceOver({ get })));

		await expect(lazy.backend.get('abc')).resolves.toEqual({ id: 'a' });
		expect(get).toHaveBeenCalledWith('abc');
	});

	it('a failing create rejects the call with the cause, and every later call too (nothing silent)', async () => {
		const lazy = createLazyBackend(fakePlugin(), () => Promise.reject(new Error('server unreachable')));

		await expect(lazy.backend.list()).rejects.toThrow('server unreachable');
		await expect(lazy.backend.list()).rejects.toThrow('server unreachable');
	});

	it('a method the backend does not have is a pointed error', async () => {
		const lazy = createLazyBackend(fakePlugin(), () => Promise.resolve(instanceOver({})));

		await expect((lazy.backend as unknown as { nope(): Promise<void> }).nope()).rejects.toThrow(
			'the github backend has no method "nope"'
		);
	});

	it('dispose before any call creates nothing and disposes nothing', async () => {
		const open = vi.fn();
		const lazy = createLazyBackend(fakePlugin(), open);

		await lazy.dispose();

		expect(open).not.toHaveBeenCalled();
	});

	it('dispose after use disposes the instance once, however many times it is called', async () => {
		const instance = instanceOver({ list: vi.fn().mockResolvedValue([]) });
		const lazy = createLazyBackend(fakePlugin(), () => Promise.resolve(instance));
		await lazy.backend.list();

		await lazy.dispose();
		await lazy.dispose();

		expect(instance.disposed).toBe(1);
	});

	it('after dispose a call is refused, not silently re-created', async () => {
		const instance = instanceOver({ list: vi.fn().mockResolvedValue([]) });
		const lazy = createLazyBackend(fakePlugin(), () => Promise.resolve(instance));
		await lazy.backend.list();
		await lazy.dispose();

		await expect(lazy.backend.list()).rejects.toThrow('the github backend was already disposed');
	});

	it('exposes the instance once opened, for the diagnostics', async () => {
		const instance = instanceOver({ list: vi.fn().mockResolvedValue([]) });
		const lazy = createLazyBackend(fakePlugin(), () => Promise.resolve(instance));
		expect(lazy.opened()).toBeUndefined();

		await lazy.backend.list();

		expect(lazy.opened()).toBe(instance);
	});

	it('covers every method of the real local backend (a method added to the port must not be lost)', () => {
		const lazy = createLazyBackend(fakePlugin(), vi.fn());
		const methods = Object.getOwnPropertyNames(LocalFileBackend.prototype).filter(name => name !== 'constructor');

		for (const name of methods) {
			expect(typeof (lazy.backend as unknown as Record<string, unknown>)[name], name).toBe('function');
		}
		expect(methods.length).toBeGreaterThan(30);
	});
});
