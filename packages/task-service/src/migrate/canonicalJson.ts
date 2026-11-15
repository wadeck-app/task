// One canonical JSON text and one hash for everything a migration compares (the content of a source task, the definition of a target).
import * as crypto from 'node:crypto';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON with the keys of every object sorted: the same content always gives the same text. */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

/** The sha256 of a text, in hex. */
export function sha256Hex(text: string): string {
	return crypto.createHash('sha256').update(text).digest('hex');
}
