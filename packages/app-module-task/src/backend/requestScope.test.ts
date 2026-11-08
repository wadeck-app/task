import type { TaskServiceContext } from '@wadeck-app/task-service';

import { runInRequestScope, trackContext } from './requestScope.js';

function context(overrides: Partial<TaskServiceContext> = {}): TaskServiceContext {
	return { project: { name: 'shop' }, dispose: vi.fn(() => Promise.resolve()), ...overrides } as TaskServiceContext;
}

describe('runInRequestScope', () => {
	it('disposes every context opened during the request, once, after the handler is done', async () => {
		const a = context();
		const b = context();
		const order: string[] = [];
		a.dispose = vi.fn(() => {
			order.push('dispose a');
			return Promise.resolve();
		});

		const { value } = await runInRequestScope(async () => {
			trackContext(a);
			await Promise.resolve();
			trackContext(b);
			trackContext(a);
			order.push('handler done');
			return 42;
		}, vi.fn());

		expect(value).toBe(42);
		expect(order).toEqual(['handler done', 'dispose a']);
		expect(a.dispose).toHaveBeenCalledTimes(1);
		expect(b.dispose).toHaveBeenCalledTimes(1);
	});

	it('disposes them when the handler fails, and the failure is the handler failure', async () => {
		const a = context();

		await expect(
			runInRequestScope(async () => {
				trackContext(a);
				throw new Error('boom');
			}, vi.fn())
		).rejects.toThrow('boom');

		expect(a.dispose).toHaveBeenCalledTimes(1);
	});

	it('a dispose that fails is reported by name and does not change the answer', async () => {
		const a = context({ project: { name: 'shop' } });
		a.dispose = vi.fn(() => Promise.reject(new Error('socket stuck')));
		const report = vi.fn();

		const { value } = await runInRequestScope(() => {
			trackContext(a);
			return 'ok';
		}, report);

		expect(value).toBe('ok');
		expect(report).toHaveBeenCalledWith('could not release the storage of project shop: socket stuck');
	});

	it('hands back the notices of the reads, from every context, before they are forgotten', async () => {
		const a = context({ takeNotices: () => [{ kind: 'stale', text: 'offline, cached from 10:00' }] });
		const b = context({ takeNotices: () => [{ kind: 'ignored', text: 'left out' }] });

		const { notices } = await runInRequestScope(() => {
			trackContext(a);
			trackContext(b);
		}, vi.fn());

		expect(notices.map(notice => notice.text)).toEqual(['offline, cached from 10:00', 'left out']);
	});

	it('requests do not see each other: two at once dispose their own contexts', async () => {
		const mine = context();
		const yours = context();
		let release!: () => void;
		const gate = new Promise<void>(resolve => (release = resolve));

		const first = runInRequestScope(async () => {
			trackContext(mine);
			await gate;
		}, vi.fn());
		const second = runInRequestScope(() => {
			trackContext(yours);
		}, vi.fn());
		await second;

		expect(yours.dispose).toHaveBeenCalledTimes(1);
		expect(mine.dispose).not.toHaveBeenCalled();
		release();
		await first;
		expect(mine.dispose).toHaveBeenCalledTimes(1);
	});

	it('a context opened outside any request is returned as is (nothing tracks it)', () => {
		const a = context();

		expect(trackContext(a)).toBe(a);
		expect(a.dispose).not.toHaveBeenCalled();
	});
});
