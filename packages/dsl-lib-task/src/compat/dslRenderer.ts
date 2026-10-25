import * as renderer from '@wadeck-app/dsl-renderer';
import { resolveExpressionValue } from '@wadeck-app/dsl-renderer';
import { reportOnce } from '../reportOnce.js';

/*
 * The generated entries (scripts/generate-entries.ts) call four helpers of dsl-renderer that older shells do not
 * export: the installed app-core-cli 2026.10.24-094 ships dsl-renderer 175, which exports only renderChildren,
 * resolveExpressionValue, createRegistry... A named import of a missing export is `undefined` in the bundle and the
 * page crashes on the first render. Each helper here is the shell's own when it has it, else a local copy that
 * mirrors dsl-renderer 2026.10.25-260 (engine/coerceProp.js, DslRenderer.js); compat/dslRenderer.test.ts compares
 * the two on a table of cases. Delete this file, and the rewrite in generate-entries.ts, once the minimum shell
 * (manifest dslLib.shared) exports them.
 */

export type CoerceKind = 'string' | 'primitive' | 'array' | 'object' | 'function';

type Ctx = Record<string, unknown>;

export interface RendererHelpers {
	coerceProp: (rawValue: unknown, where: string, kind: CoerceKind, required: boolean, nullable?: boolean) => unknown;
	resolveExpressionsDeep: (value: unknown, ctx: Ctx) => unknown;
	coerceStringList: (value: unknown, where: string) => string[];
	coerceDate: (value: unknown, where: string) => Date | null;
}

function describeReceived(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return 'a list';
	}
	return typeof value === 'object' ? 'a map' : typeof value;
}

function warnOnce(where: string, expected: string, value: unknown): void {
	reportOnce(
		`[${where}] expected ${expected} but received ${describeReceived(value)}; the value is ignored.`,
		'warn'
	);
}

/** Keeps `value` when it has the kind the component declares, otherwise ignores it and says why once. */
export function localCoerceProp(
	rawValue: unknown,
	where: string,
	kind: CoerceKind,
	required: boolean,
	nullable = false
): unknown {
	if (rawValue === null && nullable) {
		return null;
	}
	const value = rawValue === null ? undefined : rawValue;
	switch (kind) {
		case 'string':
			if (typeof value === 'string') {
				return value;
			}
			if (value === undefined) {
				return required ? '' : value;
			}
			if (typeof value === 'number') {
				return String(value);
			}
			warnOnce(where, 'a string', value);
			return required ? '' : undefined;
		case 'primitive':
			if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
				warnOnce(where, 'a string, number or boolean', value);
				return undefined;
			}
			return value;
		case 'array':
			if (Array.isArray(value)) {
				return value;
			}
			if (value === undefined) {
				return required ? [] : value;
			}
			warnOnce(where, 'a list', value);
			return required ? [] : undefined;
		case 'object':
			if (value === undefined || (typeof value === 'object' && !Array.isArray(value))) {
				return value;
			}
			warnOnce(where, 'a map', value);
			return undefined;
		case 'function':
			if (value === undefined || typeof value === 'function') {
				return value;
			}
			warnOnce(where, 'a function', value);
			return undefined;
	}
}

/** Resolves `$path` expressions in every string of a value (maps and lists included). */
export function localResolveExpressionsDeep(value: unknown, ctx: Ctx): unknown {
	if (typeof value === 'string') {
		return resolveExpressionValue(value, ctx);
	}
	if (Array.isArray(value)) {
		return value.map(item => localResolveExpressionsDeep(item, ctx));
	}
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, localResolveExpressionsDeep(item, ctx)])
		);
	}
	return value;
}

/** A list of strings; a missing value is an empty list, anything else that is not a list is ignored with one warning. */
export function localCoerceStringList(value: unknown, where: string): string[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value)) {
		warnOnce(where, 'a list', value);
		return [];
	}
	const kept: string[] = [];
	for (const entry of value) {
		if (typeof entry === 'string') {
			kept.push(entry);
		} else if (typeof entry === 'number' || typeof entry === 'boolean') {
			kept.push(String(entry));
		} else {
			warnOnce(where, 'a list of text entries', entry);
		}
	}
	return kept;
}

/** A valid Date, or null for "no date" (an unparseable value warns once). */
export function localCoerceDate(value: unknown, where: string): Date | null {
	if (value === undefined || value === null || value === '' || value === false) {
		return null;
	}
	const date =
		value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
	if (date === null || Number.isNaN(date.getTime())) {
		warnOnce(where, 'a date (ISO text or a timestamp)', value);
		return null;
	}
	return date;
}

/**
 * The helpers, taken from `namespace` when it has them. Reading a missing name can throw (a strict module mock) or give
 * undefined (a plain object): both mean "not exported".
 */
export function pickRendererHelpers(namespace: unknown): RendererHelpers {
	const pick = <T>(name: string, fallback: T): T => {
		try {
			const found = (namespace as Record<string, unknown>)[name];
			return typeof found === 'function' ? (found as T) : fallback;
		} catch {
			return fallback;
		}
	};
	return {
		coerceProp: pick('coerceProp', localCoerceProp),
		resolveExpressionsDeep: pick('resolveExpressionsDeep', localResolveExpressionsDeep),
		coerceStringList: pick('coerceStringList', localCoerceStringList),
		coerceDate: pick('coerceDate', localCoerceDate),
	};
}

const helpers = pickRendererHelpers(renderer);

export const coerceProp = helpers.coerceProp;
export const resolveExpressionsDeep = helpers.resolveExpressionsDeep;
export const coerceStringList = helpers.coerceStringList;
export const coerceDate = helpers.coerceDate;
