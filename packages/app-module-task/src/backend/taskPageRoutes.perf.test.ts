// Timings of the routes the task page calls on a project of 150 tasks (printed; the bounds only catch a regression to a
// scan of the whole project on the detail route).
import { setup, STATUSES_YML } from './routeHarness.js';
import type { Harness } from './routeHarness.js';

const TASKS = 150;
let h: Harness;

afterEach(() => h.world.cleanup());

async function timed<T>(label: string, run: () => Promise<T>): Promise<{ result: T; ms: number }> {
	const start = performance.now();
	const result = await run();
	const ms = Math.round((performance.now() - start) * 10) / 10;
	process.stderr.write(`[perf ${TASKS} tasks] ${label}: ${ms} ms\n`);
	return { result, ms };
}

describe(`routes on ${TASKS} seeded tasks`, () => {
	it('GET /tasks/:id stays on the index and its own files; /labels and /meta-keys scan once', async () => {
		h = setup();
		const project = await h.world.createProject('alpha', { configYml: STATUSES_YML });
		let parent = '';
		let sample = '';
		for (let index = 0; index < TASKS; index++) {
			const answer = await h.call('POST /tasks', {
				query: { project },
				body: { description: `task ${index}`, ...(index % 10 === 0 || parent === '' ? {} : { parent }) },
			});
			const id = answer.body['task'].id as string;
			if (index % 10 === 0) parent = id;
			if (index === TASKS / 2) sample = id;
			if (index % 3 === 0) {
				await h.call('POST /tasks/:id/labels', {
					params: { id },
					query: { project },
					body: { label: `l${index % 25}` },
				});
				await h.call('POST /tasks/:id/meta', {
					params: { id },
					query: { project },
					body: { key: `k${index % 7}`, value: 'v' },
				});
			}
		}
		const detail = await timed('GET /tasks/:id', () =>
			h.call('GET /tasks/:id', { params: { id: sample }, query: { project } })
		);
		const labels = await timed('GET /labels', () => h.call('GET /labels', { query: { project } }));
		const metaKeys = await timed('GET /meta-keys', () => h.call('GET /meta-keys', { query: { project } }));
		const search = await timed('GET /tasks/search', () =>
			h.call('GET /tasks/search', { query: { project, q: 'task 99' } })
		);
		expect(detail.result.status).toBe(200);
		expect(labels.result.body).toHaveLength(25);
		expect(metaKeys.result.body).toHaveLength(7);
		expect(search.result.status).toBe(200);
		expect(detail.ms).toBeLessThan(500);
	}, 300_000);
});
