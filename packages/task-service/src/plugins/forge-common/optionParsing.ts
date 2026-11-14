// Small parsers of `strategy.options` that github and gitlab read the same way. A problem is a sentence starting with its key.
export type Parsed<T> = { value: T } | { problem: string };

/** A value as it is shown in a message. */
export const found = (value: unknown): string =>
	Array.isArray(value) ? 'a list' : (JSON.stringify(value) ?? String(value));

export const isMapping = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** A number option: `fallback` when absent, else a number accepted by `rule` (`expected` says what it must be). */
export function parseNumber(
	options: Record<string, unknown>,
	key: string,
	fallback: number,
	rule: (n: number) => boolean,
	expected: string
): Parsed<number> {
	const value = options[key];
	if (value === undefined) return { value: fallback };
	if (typeof value !== 'number' || !rule(value))
		return { problem: `${key}: must be ${expected}, found ${found(value)}` };
	return { value };
}

/** `cache: { ttlSeconds }`: the seconds a read is served without asking again (`fallback` when absent). */
export function parseTtlCache(value: unknown, fallback: number): Parsed<number> {
	if (value === undefined) return { value: fallback };
	if (!isMapping(value))
		return { problem: `cache: must be a mapping like { ttlSeconds: ${fallback} }, found ${found(value)}` };
	for (const key of Object.keys(value)) {
		if (key !== 'ttlSeconds') return { problem: `cache.${key}: unknown key (valid: ttlSeconds)` };
	}
	const ttl = value['ttlSeconds'];
	if (ttl === undefined) return { value: fallback };
	if (typeof ttl !== 'number' || !(ttl >= 0)) {
		return { problem: `cache.ttlSeconds: must be zero or a positive number of seconds, found ${found(ttl)}` };
	}
	return { value: ttl };
}
