import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ROUTES } from '@wadeck-app/task-core';

import { startServerFixture } from './testHelpers.js';
import type { ServerFixture } from './testHelpers.js';

// Traversal-shaped ids against EVERY route of the protocol that carries a task id (path, body field, query), through the
// real HTTP server: each is refused with 400 {error: {message, hint}}, and the data folder (with a canary where `../x`
// would land) is byte-identical afterwards.
const open: ServerFixture[] = [];
afterEach(async () => {
	for (const f of open.splice(0)) await f.stop();
});

function snapshot(base: string): Record<string, string> {
	const out: Record<string, string> = {};
	const visit = (current: string): void => {
		for (const name of fs.readdirSync(current)) {
			const full = path.join(current, name);
			const rel = path.relative(base, full);
			if (fs.statSync(full).isDirectory()) {
				out[`${rel}/`] = '<dir>';
				visit(full);
			} else out[rel] = fs.readFileSync(full, 'utf8');
		}
	};
	visit(base);
	return out;
}

const BODIES: Record<string, (evil: string) => unknown> = {
	updateStatus: () => ({ status: 'done' }),
	setTitle: () => ({ title: 't' }),
	setDescription: () => ({ description: 'd' }),
	setType: () => ({ type: 'bug' }),
	addLabel: () => ({ label: 'l' }),
	setMeta: () => ({ value: 'v' }),
	setParent: () => ({ parentId: 'abc' }),
	addLink: () => ({ type: 'blockedBy', targetId: 'abc' }),
	addComment: () => ({ text: 'hi' }),
	editComment: () => ({ text: 'hi' }),
	setPriority: () => ({ priority: 'high' }),
	setAssignee: () => ({ assignee: 'bob' }),
	claim: () => ({ assignee: 'bob', leaseMs: 60_000 }),
	release: () => ({ force: true }),
};

describe('task serve with traversal-shaped ids', () => {
	it('refuses them on every route, in every id position, and leaves the data folder untouched', async () => {
		const f = await startServerFixture();
		open.push(f);
		const dataDir = path.join(f.test.rootDir, 'data');
		fs.mkdirSync(dataDir, { recursive: true });
		const canary = path.join(dataDir, 'x.json');
		fs.writeFileSync(canary, JSON.stringify({ id: 'x', title: 'canary', status: 'backlog' }));
		fs.writeFileSync(
			path.join(dataDir, 'abs.json'),
			JSON.stringify({ id: 'abs', title: 'canary', status: 'backlog' })
		);
		const real = (await f.call('create', {}, { title: 'real', status: 'backlog' })).body.result.id as string;
		const before = snapshot(f.test.rootDir);

		const evils = [
			'../x',
			'..\\x',
			'a/b',
			'%2e%2e%2f',
			path.join(dataDir, 'abs'),
			'ab\u0000c',
			'a'.repeat(300),
			'.hidden',
			'x.json',
		];
		const problems: string[] = [];
		let attempts = 0;
		for (const evil of evils) {
			for (const route of ROUTES) {
				if (route.op === 'info') continue;
				const idPositions =
					route.path.includes(':id') || route.path.includes(':prefix') || route.path.includes(':target');
				const bodyEvil = route.op === 'setParent' || route.op === 'addLink';
				if (!idPositions && !bodyEvil && !['create', 'getForest', 'listPage', 'getMany'].includes(route.op))
					continue;

				const variants: Array<{
					where: string;
					params: Record<string, string>;
					body?: unknown;
					query?: Record<string, string>;
				}> = [];
				const baseParams = (): Record<string, string> => {
					const params: Record<string, string> = {};
					for (const [, name] of route.path.matchAll(/:(\w+)/g)) {
						params[name] =
							name === 'type'
								? 'blockedBy'
								: name === 'target'
									? real
									: name === 'label' || name === 'key' || name === 'commentId'
										? 'k'
										: real;
					}
					return params;
				};
				const body = BODIES[route.op]?.(evil);
				if (route.path.includes(':id'))
					variants.push({ where: 'id', params: { ...baseParams(), id: evil }, body });
				if (route.path.includes(':prefix')) variants.push({ where: 'prefix', params: { prefix: evil } });
				if (route.path.includes(':target'))
					variants.push({ where: 'target', params: { ...baseParams(), target: evil } });
				if (route.op === 'setParent')
					variants.push({ where: 'parentId', params: baseParams(), body: { parentId: evil } });
				if (route.op === 'addLink') {
					variants.push({
						where: 'targetId',
						params: baseParams(),
						body: { type: 'blockedBy', targetId: evil },
					});
				}
				if (route.op === 'create') {
					variants.push({
						where: 'parentId',
						params: {},
						body: { title: 'x', status: 'backlog', parentId: evil },
					});
				}
				if (route.op === 'getForest')
					variants.push({ where: 'parentId', params: {}, query: { parentId: evil } });
				if (route.op === 'getMany') variants.push({ where: 'ids', params: {}, body: { ids: [evil] } });
				if (route.op === 'listPage') variants.push({ where: 'parentId', params: {}, body: { parentId: evil } });

				for (const variant of variants) {
					attempts++;
					const where = `${route.op} ${variant.where} ${JSON.stringify(evil.slice(0, 20))}`;
					let result;
					try {
						result = await f.call(
							route.op,
							variant.params,
							variant.body,
							variant.query ? { query: variant.query } : {}
						);
					} catch (error) {
						problems.push(`${where}: client threw ${String(error).slice(0, 120)}`);
						continue;
					}
					if (result.status !== 400) {
						problems.push(`${where}: status ${result.status} ${JSON.stringify(result.body).slice(0, 120)}`);
						continue;
					}
					const error = result.body?.error as { message?: unknown; hint?: unknown } | undefined;
					if (typeof error?.message !== 'string' || typeof error?.hint !== 'string') {
						problems.push(
							`${where}: 400 without message and hint: ${JSON.stringify(result.body).slice(0, 120)}`
						);
					}
				}
			}
		}

		// A raw request with the traversal NOT percent-encoded as a whole (a client that builds the URL by hand).
		for (const rawPath of [
			'/v1/tasks/../x',
			'/v1/tasks/..%2fx',
			'/v1/tasks/%2e%2e/x',
			'/v1/tasks/%2e%2e%2fx',
			'/v1/tasks/a%00b',
		]) {
			const result = await f.raw(rawPath, { headers: f.headers() });
			attempts++;
			if (result.status >= 500 || result.status === 200) problems.push(`raw ${rawPath}: status ${result.status}`);
		}

		expect(attempts).toBeGreaterThan(150);
		expect(problems).toEqual([]);
		expect(snapshot(f.test.rootDir)).toEqual(before);
		expect(fs.readFileSync(canary, 'utf8')).toContain('canary');
	}, 120_000);
});
