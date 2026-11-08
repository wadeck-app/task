import { setup } from './routeHarness.js';
import type { Harness } from './routeHarness.js';

// The contexts a request opens are released with it (stage 1 of the storage design): a project on a remote strategy may hold a
// connection or a cache. The service functions that open them are wrapped so each opened context carries a counting dispose.
const probe = vi.hoisted(() => ({ disposers: [] as Array<ReturnType<typeof vi.fn>> }));

vi.mock('@wadeck-app/task-service', async importOriginal => {
	const actual = await importOriginal<typeof import('@wadeck-app/task-service')>();
	const counting = <T extends { dispose?: () => Promise<void> }>(ctx: T): T => {
		const real = ctx.dispose?.bind(ctx);
		const dispose = vi.fn(() => real?.() ?? Promise.resolve());
		probe.disposers.push(dispose);
		return { ...ctx, dispose };
	};
	return {
		...actual,
		openTaskContext: (...args: Parameters<typeof actual.openTaskContext>) =>
			counting(actual.openTaskContext(...args)),
		inspectKnownProjects: (...args: Parameters<typeof actual.inspectKnownProjects>) => {
			const inspected = actual.inspectKnownProjects(...args);
			return {
				...inspected,
				entries: inspected.entries.map(entry => ({
					...entry,
					context: entry.context === null ? null : counting(entry.context),
				})),
			};
		},
	};
});

let h: Harness;
let alpha: string;

beforeEach(async () => {
	probe.disposers.length = 0;
	h = setup();
	const statuses = 'statuses:\n  - backlog\n  - { name: done, terminal: true }\n';
	alpha = await h.world.createProject('alpha', { configYml: statuses });
	await h.world.createProject('beta', { configYml: statuses });
	await h.call('POST /tasks', { query: { project: alpha }, body: { description: 'a task' } });
	probe.disposers.length = 0;
});

afterEach(() => {
	h.world.cleanup();
});

const disposedOnce = (): boolean[] => probe.disposers.map(dispose => dispose.mock.calls.length === 1);

describe('a request releases the contexts it opened', () => {
	it('a read of one project opens one context and disposes it once', async () => {
		const answer = await h.call('GET /tasks', { query: { project: alpha } });

		expect(answer.status).toBe(200);
		expect(probe.disposers).toHaveLength(1);
		expect(disposedOnce()).toEqual([true]);
	});

	it('also when the handler fails', async () => {
		const answer = await h.call('GET /tasks/:id', { params: { id: 'nope0000' }, query: { project: alpha } });

		expect(answer.status).toBe(404);
		expect(probe.disposers).toHaveLength(1);
		expect(disposedOnce()).toEqual([true]);
	});

	it('also on a write', async () => {
		const answer = await h.call('POST /tasks', { query: { project: alpha }, body: { description: 'another' } });

		expect(answer.status).toBe(201);
		expect(disposedOnce().every(Boolean)).toBe(true);
		expect(probe.disposers.length).toBeGreaterThan(0);
	});

	it('the project listing disposes each project once', async () => {
		const answer = await h.call('GET /projects');

		expect(answer.status).toBe(200);
		expect(probe.disposers).toHaveLength(2);
		expect(disposedOnce()).toEqual([true, true]);
	});

	it('a view across the projects disposes each project once', async () => {
		const answer = await h.call('GET /tree', { query: { allProjects: 'true' } });

		expect(answer.status).toBe(200);
		expect(probe.disposers.length).toBeGreaterThanOrEqual(2);
		expect(disposedOnce().every(Boolean)).toBe(true);
	});
});
