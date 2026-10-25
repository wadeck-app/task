import * as renderer from '@wadeck-app/dsl-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetReported } from '../reportOnce.js';
import {
	coerceDate,
	coerceProp,
	coerceStringList,
	localCoerceDate,
	localCoerceProp,
	localCoerceStringList,
	localResolveExpressionsDeep,
	pickRendererHelpers,
	resolveExpressionsDeep,
} from './dslRenderer.js';
import type { CoerceKind } from './dslRenderer.js';

/*
 * The local helpers mirror dsl-renderer 260 (the version installed here); the shell may ship an older renderer
 * without them. Every case below runs through both and must give the same answer.
 */

afterEach(() => {
	resetReported();
	vi.restoreAllMocks();
});

const VALUES: [string, unknown][] = [
	['undefined', undefined],
	['null', null],
	['a string', 'text'],
	['an empty string', ''],
	['a number', 3],
	['zero', 0],
	['true', true],
	['false', false],
	['a list', ['a', 1]],
	['an empty list', []],
	['a map', { a: 1 }],
	['a function', () => 1],
];

const KINDS: CoerceKind[] = ['string', 'primitive', 'array', 'object', 'function'];

describe('localCoerceProp, against dsl-renderer', () => {
	for (const kind of KINDS) {
		for (const required of [true, false]) {
			for (const nullable of [true, false]) {
				for (const [name, value] of VALUES) {
					it(`${kind}, required ${String(required)}, nullable ${String(nullable)}, given ${name}`, () => {
						vi.spyOn(console, 'warn').mockImplementation(() => {});
						const expected = renderer.coerceProp(value, 'X.p', kind, required, nullable);

						expect(localCoerceProp(value, 'X.p', kind, required, nullable)).toEqual(expected);
					});
				}
			}
		}
	}

	it('warns once for a value of the wrong kind, naming the prop', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		localCoerceProp({ a: 1 }, 'Badge.label', 'string', true);
		localCoerceProp({ a: 1 }, 'Badge.label', 'string', true);

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('Badge.label'));
	});
});

describe('localResolveExpressionsDeep, against dsl-renderer', () => {
	const ctx = { $sources: { detail: { id: 't1', labels: ['a'], n: 2 } } };
	const CASES: [string, unknown][] = [
		['a literal', 'plain'],
		['a path', '$sources.detail.id'],
		['a missing path', '$sources.nope.id'],
		['a list of paths', ['$sources.detail.id', 'x', '$sources.detail.n']],
		['a nested map', { id: '$sources.detail.id', inner: { labels: '$sources.detail.labels', k: 3 } }],
		['null', null],
		['a number', 4],
		['a boolean', false],
		['an operator expression', '!$sources.detail.id'],
	];
	for (const [name, value] of CASES) {
		it(`gives the same answer for ${name}`, () => {
			expect(localResolveExpressionsDeep(value, ctx)).toEqual(renderer.resolveExpressionsDeep(value, ctx));
		});
	}
});

describe('localCoerceStringList and localCoerceDate, against dsl-renderer', () => {
	const LISTS: unknown[] = [undefined, null, 'x', ['a', 'b'], ['a', 2, true], ['a', {}], [], {}];
	for (const value of LISTS) {
		it(`list: ${JSON.stringify(value)}`, () => {
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			expect(localCoerceStringList(value, 'F.v')).toEqual(renderer.coerceStringList(value, 'F.v'));
		});
	}
	const DATES: unknown[] = [
		undefined,
		null,
		'',
		false,
		'2026-10-21T09:30:00.000Z',
		1_700_000_000_000,
		new Date(0),
		'nope',
		{},
		true,
	];
	for (const value of DATES) {
		it(`date: ${String(value)}`, () => {
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			expect(localCoerceDate(value, 'F.v')).toEqual(renderer.coerceDate(value, 'F.v'));
		});
	}
});

describe('the exported helpers', () => {
	it("are the renderer's own when it exports them", () => {
		expect(coerceProp).toBe(renderer.coerceProp);
		expect(resolveExpressionsDeep).toBe(renderer.resolveExpressionsDeep);
		expect(coerceStringList).toBe(renderer.coerceStringList);
		expect(coerceDate).toBe(renderer.coerceDate);
	});

	it('are the local ones when the renderer namespace lacks them', () => {
		const picked = pickRendererHelpers({ renderChildren: () => null });

		expect(picked.coerceProp).toBe(localCoerceProp);
		expect(picked.resolveExpressionsDeep).toBe(localResolveExpressionsDeep);
		expect(picked.coerceStringList).toBe(localCoerceStringList);
		expect(picked.coerceDate).toBe(localCoerceDate);
	});

	it('are the local ones when reading a missing export throws, as a strict module mock does', () => {
		const strict = new Proxy(
			{},
			{
				get: (_t, name) => {
					throw new Error(`no export ${String(name)}`);
				},
			}
		);

		expect(pickRendererHelpers(strict).coerceProp).toBe(localCoerceProp);
	});
});
