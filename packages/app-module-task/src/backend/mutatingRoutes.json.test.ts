import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { labelKey } from './labelKey.js';
import { metaKey } from './metaKey.js';
import { setup } from './routeHarness.js';
import type { Answer, Harness } from './routeHarness.js';

// The installed shell reads every answer that is not a 204 with response.json(). An empty body fails the action with
// "Failed to execute 'json' on 'Response': Unexpected end of JSON input" (toast: Action "createSubtask" failed: ...), with no
// status and no hint. So EVERY mutating route must answer a parseable JSON object, on success AND on a typed error, with or
// without ?inlineErrors=true, and never with 204/304 (those carry no body for the shell to read).

const CONFIG = [
	'statuses:',
	'  - backlog',
	'  - name: done',
	'    terminal: true',
	'types:',
	'  - bug',
	'  - chore',
	'',
].join('\n');

let h: Harness;
let project: string;
let a: string;
let b: string;
let child: string;
let commentId: string;

beforeEach(async () => {
	h = setup();
	project = await h.world.createProject('alpha', { configYml: CONFIG });
	const make = async (description: string, parent?: string): Promise<string> => {
		const created = await h.call('POST /tasks', {
			query: { project },
			body: { description, ...(parent === undefined ? {} : { parent }) },
		});
		return created.body['task'].id as string;
	};
	a = await make('task a');
	b = await make('task b');
	child = await make('child', a);
	await h.call('POST /tasks/:id/labels', { params: { id: a }, query: { project }, body: { label: 'bug1' } });
	await h.call('POST /tasks/:id/meta', { params: { id: a }, query: { project }, body: { key: 'k', value: 'v' } });
	await h.call('POST /tasks/:id/links', {
		params: { id: a },
		query: { project },
		body: { type: 'blockedBy', target: b },
	});
	const comment = await h.call('POST /tasks/:id/comments', {
		params: { id: a },
		query: { project },
		body: { text: 'first' },
	});
	commentId = comment.body['comment'].id as string;
});
afterEach(() => h.world.cleanup());

interface Call {
	params?: Record<string, string>;
	query?: Record<string, unknown>;
	body?: unknown;
}

/** One request that SUCCEEDS per mutating route, built from the state made above. */
const successes: Array<[route: string, request: () => Call]> = [
	['POST /tasks', () => ({ body: { title: 'new', parent: a } })],
	['POST /tasks/:id/status', () => ({ params: { id: a }, body: { status: 'done' } })],
	['POST /tasks/:id/status/:status', () => ({ params: { id: a, status: 'done' } })],
	['POST /tasks/:id/type', () => ({ params: { id: a }, body: { type: 'bug' } })],
	['POST /tasks/:id/type/:type', () => ({ params: { id: a, type: 'chore' } })],
	['DELETE /tasks/:id/type', () => ({ params: { id: a } })],
	['POST /tasks/:id/labels', () => ({ params: { id: a }, body: { label: 'other' } })],
	['POST /tasks/:id/labels/:label', () => ({ params: { id: a, label: 'other' } })],
	['DELETE /tasks/:id/labels/:label', () => ({ params: { id: a, label: 'bug1' } })],
	['DELETE /tasks/:id/label-keys/:key', () => ({ params: { id: a, key: labelKey('bug1') } })],
	['POST /tasks/:id/parent', () => ({ params: { id: b }, body: { parent: a } })],
	['DELETE /tasks/:id/parent', () => ({ params: { id: child } })],
	['POST /tasks/:id/meta', () => ({ params: { id: a }, body: { key: 'k2', value: 'v2' } })],
	['PUT /tasks/:id/meta/:key', () => ({ params: { id: a, key: 'k' }, body: { value: 'changed' } })],
	['DELETE /tasks/:id/meta/:key', () => ({ params: { id: a, key: 'k' } })],
	['PUT /tasks/:id/meta-keys/:key', () => ({ params: { id: a, key: metaKey('k') }, body: { value: 'changed' } })],
	['DELETE /tasks/:id/meta-keys/:key', () => ({ params: { id: a, key: metaKey('k') } })],
	['PATCH /tasks/:id', () => ({ params: { id: a }, body: { title: 'renamed' } })],
	['POST /tasks/:id/links', () => ({ params: { id: b }, body: { type: 'duplicateOf', target: a } })],
	['DELETE /tasks/:id/links', () => ({ params: { id: a }, body: { type: 'blockedBy', target: b } })],
	['POST /tasks/:id/comments', () => ({ params: { id: a }, body: { text: 'second' } })],
	['PATCH /tasks/:id/comments/:commentId', () => ({ params: { id: a, commentId }, body: { text: 'edited' } })],
	['DELETE /tasks/:id/comments/:commentId', () => ({ params: { id: a, commentId } })],
	['POST /types', () => ({ body: { name: 'feature' } })],
	['DELETE /types/:name', () => ({ params: { name: 'bug' } })],
	['POST /tasks/delete/plan', () => ({ body: { ids: [b] } })],
	['POST /tasks/delete', () => ({ body: { ids: [b], confirm: true } })],
];

/** One request that FAILS per mutating route, in the ways a page can make it fail: no body, unknown task. */
const failures: Array<[label: string, route: string, request: () => Call]> = [
	['no body', 'POST /tasks', () => ({})],
	['blank text', 'POST /tasks', () => ({ body: { title: '   ' } })],
	['unknown parent', 'POST /tasks', () => ({ body: { title: 'x', parent: 'zzzzzzzz' } })],
	['no body', 'POST /tasks/:id/status', () => ({ params: { id: a } })],
	['unknown task', 'POST /tasks/:id/status/:status', () => ({ params: { id: 'zzzzzzzz', status: 'done' } })],
	['unknown status', 'POST /tasks/:id/status/:status', () => ({ params: { id: a, status: 'nope' } })],
	['no body', 'POST /tasks/:id/type', () => ({ params: { id: a } })],
	['unknown type', 'POST /tasks/:id/type/:type', () => ({ params: { id: a, type: 'nope' } })],
	['unknown task', 'DELETE /tasks/:id/type', () => ({ params: { id: 'zzzzzzzz' } })],
	['no body', 'POST /tasks/:id/labels', () => ({ params: { id: a } })],
	['blank label', 'POST /tasks/:id/labels/:label', () => ({ params: { id: a, label: ' ' } })],
	['unknown task', 'DELETE /tasks/:id/labels/:label', () => ({ params: { id: 'zzzzzzzz', label: 'x' } })],
	['bad key', 'DELETE /tasks/:id/label-keys/:key', () => ({ params: { id: a, key: '%%%' } })],
	['no body', 'POST /tasks/:id/parent', () => ({ params: { id: a } })],
	['cycle', 'POST /tasks/:id/parent', () => ({ params: { id: a }, body: { parent: child } })],
	['unknown task', 'DELETE /tasks/:id/parent', () => ({ params: { id: 'zzzzzzzz' } })],
	['no body', 'POST /tasks/:id/meta', () => ({ params: { id: a } })],
	['no value', 'PUT /tasks/:id/meta/:key', () => ({ params: { id: a, key: 'k' }, body: {} })],
	['blank key', 'DELETE /tasks/:id/meta/:key', () => ({ params: { id: a, key: ' ' } })],
	['no value', 'PUT /tasks/:id/meta-keys/:key', () => ({ params: { id: a, key: metaKey('k') }, body: {} })],
	['unknown task', 'DELETE /tasks/:id/meta-keys/:key', () => ({ params: { id: 'zzzzzzzz', key: metaKey('k') } })],
	['no body', 'PATCH /tasks/:id', () => ({ params: { id: a } })],
	['no body', 'POST /tasks/:id/links', () => ({ params: { id: a } })],
	[
		'unknown target',
		'POST /tasks/:id/links',
		() => ({ params: { id: a }, body: { type: 'blockedBy', target: 'zzzzzzzz' } }),
	],
	['no query', 'DELETE /tasks/:id/links', () => ({ params: { id: a } })],
	['no body', 'POST /tasks/:id/comments', () => ({ params: { id: a } })],
	[
		'unknown comment',
		'PATCH /tasks/:id/comments/:commentId',
		() => ({ params: { id: a, commentId: 'zzzzzz' }, body: { text: 'x' } }),
	],
	['unknown comment', 'DELETE /tasks/:id/comments/:commentId', () => ({ params: { id: a, commentId: 'zzzzzz' } })],
	['no body', 'POST /types', () => ({})],
	['unknown type', 'DELETE /types/:name', () => ({ params: { name: 'nope' } })],
	['no body', 'POST /tasks/delete/plan', () => ({})],
	['not confirmed', 'POST /tasks/delete', () => ({ body: { ids: [b] } })],
];

/** The body must survive what the shell does with it: be a non-empty JSON text of an object. */
function expectJsonObject(label: string, answer: Answer): void {
	expect(answer.status, `${label}: a 204/304 has no body for the shell to read`).not.toBe(204);
	expect(answer.status, label).not.toBe(304);
	expect(answer.body, `${label}: the body is missing`).toBeTruthy();
	const text = JSON.stringify(answer.body);
	expect(text, label).toBeTypeOf('string');
	const parsed: unknown = JSON.parse(text);
	expect(typeof parsed, label).toBe('object');
	expect(parsed, label).not.toBeNull();
}

describe('every mutating route answers parseable JSON', () => {
	it('the tables cover every mutating route that is registered', () => {
		const registered = [...h.routes.keys()].filter(key => !key.startsWith('GET ')).sort();
		const covered = [...new Set(successes.map(([route]) => route))].sort();
		expect(covered).toEqual(registered);
		expect(new Set(failures.map(([, route]) => route))).toEqual(new Set(registered));
	});

	it.each(successes)('%s: success', async (route, request) => {
		const call = request();
		const answer = await h.call(route, {
			...call,
			query: { project, inlineErrors: 'true', ...(call.query ?? {}) },
		});

		expectJsonObject(route, answer);
		expect(answer.status, `${route} should succeed: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
		expect(answer.body['failed']).toBeUndefined();
	});

	it.each(failures)('%s: %s', async (label, route, request) => {
		const call = request();

		const plain = await h.call(route, { ...call, query: { project, ...(call.query ?? {}) } });
		const inline = await h.call(route, {
			...call,
			query: { project, inlineErrors: 'true', ...(call.query ?? {}) },
		});

		expectJsonObject(`${route} (${label})`, plain);
		expect(plain.status, `${route} (${label}) should be refused`).toBeGreaterThanOrEqual(400);
		expect(typeof plain.body['error']).toBe('string');
		expectJsonObject(`${route} (${label}) inline`, inline);
		expect(inline.status).toBe(200);
		expect(inline.body['failed']).toBe(true);
		expect(typeof inline.body['errorText']).toBe('string');
	});

	it('an unknown project is a JSON error too (plain and inline)', async () => {
		for (const [route, request] of successes) {
			const call = request();
			const plain = await h.call(route, { ...call, query: { project: 'nope-project' } });
			const inline = await h.call(route, { ...call, query: { project: 'nope-project', inlineErrors: 'true' } });
			expectJsonObject(`${route} unknown project`, plain);
			expect(plain.status, route).toBeGreaterThanOrEqual(400);
			expectJsonObject(`${route} unknown project inline`, inline);
			expect(inline.body['failed'], route).toBe(true);
		}
	});
});
