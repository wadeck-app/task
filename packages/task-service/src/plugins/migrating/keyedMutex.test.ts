import { KeyedMutex } from './keyedMutex.js';

describe('KeyedMutex: one operation at a time per key, in arrival order', () => {
	it('runs the operations of one key one after the other, in the order they were asked', async () => {
		const mutex = new KeyedMutex();
		const order: string[] = [];
		const slow = mutex.run('t', async () => {
			order.push('a:start');
			await new Promise(resolve => setTimeout(resolve, 20));
			order.push('a:end');
		});
		const fast = mutex.run('t', () => {
			order.push('b');
			return Promise.resolve();
		});

		await Promise.all([slow, fast]);

		expect(order).toEqual(['a:start', 'a:end', 'b']);
	});

	it('lets different keys run together', async () => {
		const mutex = new KeyedMutex();
		const order: string[] = [];
		const slow = mutex.run('one', async () => {
			await new Promise(resolve => setTimeout(resolve, 20));
			order.push('one');
		});
		const other = mutex.run('two', () => {
			order.push('two');
			return Promise.resolve();
		});

		await Promise.all([slow, other]);

		expect(order).toEqual(['two', 'one']);
	});

	it('goes on after an operation failed, and hands the failure to its own caller only', async () => {
		const mutex = new KeyedMutex();
		const failing = mutex.run('t', () => Promise.reject(new Error('first failed')));
		const next = mutex.run('t', () => Promise.resolve('second ok'));

		await expect(failing).rejects.toThrow('first failed');
		await expect(next).resolves.toBe('second ok');
	});

	it('forgets a key when nobody waits for it (no growth)', async () => {
		const mutex = new KeyedMutex();
		await mutex.run('t', () => Promise.resolve());

		expect(mutex.size).toBe(0);
	});
});
