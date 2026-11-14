import { BackendDataError } from '@wadeck-app/task-core';
import { describe, expect, it } from 'vitest';

import {
	redactToken,
	requireOwnAddress,
	shortPathOf,
	SlotLimiter,
	urlWithQuery,
	WriteSerializer,
} from './httpHelpers.js';

describe('redactToken', () => {
	it('hides every occurrence, and does nothing for an empty token', () => {
		expect(redactToken('a tok b tok', 'tok')).toBe('a *** b ***');
		expect(redactToken('abc', '')).toBe('abc');
	});
});

describe('addresses', () => {
	it('urlWithQuery sorts the query keys', () => {
		expect(urlWithQuery('https://h/api', '/x', { b: 2, a: 'z' })).toBe('https://h/api/x?a=z&b=2');
		expect(urlWithQuery('https://h/api', '/x')).toBe('https://h/api/x');
	});

	it('shortPathOf removes the base path and keeps the query', () => {
		expect(shortPathOf('https://h/api/v4/issues?page=2', 'https://h/api/v4')).toBe('/issues?page=2');
		expect(shortPathOf('https://h/other?x=1', 'https://h/api/v4')).toBe('/other?x=1');
	});

	const own = { baseUrl: 'https://h/api', origin: 'https://h', backendKind: 'gitlab' as const, forgeName: 'GitLab' };

	it('requireOwnAddress accepts a link inside the base address', () => {
		expect(() => requireOwnAddress('https://h/api/issues?page=2', { ...own, redact: t => t })).not.toThrow();
	});

	it.each([
		['https://evil/api/issues', 'GitLab sent a link to evil, which is not the configured address https://h/api'],
		['https://h/elsewhere', 'GitLab sent a link to h, which is not the configured address https://h/api'],
		['not an address', 'GitLab sent a link that is not an address: not an address'],
	])('requireOwnAddress refuses %s', (url, message) => {
		try {
			requireOwnAddress(url, { ...own, redact: t => t });
		} catch (error) {
			expect(error).toBeInstanceOf(BackendDataError);
			expect((error as BackendDataError).message).toContain(message);
			return;
		}
		throw new Error('expected a refusal');
	});
});

describe('SlotLimiter', () => {
	it('lets `max` through and the next one waits for a release', async () => {
		const limiter = new SlotLimiter(1);
		await limiter.acquire();
		let second = false;
		const waiting = limiter.acquire().then(() => {
			second = true;
		});
		await Promise.resolve();
		expect(second).toBe(false);
		limiter.release();
		await waiting;
		expect(second).toBe(true);
	});
});

describe('WriteSerializer', () => {
	it('runs one write at a time, spaced, and goes on after a failure', async () => {
		let now = 0;
		const slept: number[] = [];
		const writer = new WriteSerializer(
			1000,
			() => now,
			async ms => {
				slept.push(ms);
				now += ms;
			}
		);
		const order: string[] = [];
		const first = writer.run(async () => {
			order.push('first');
			throw new Error('boom');
		});
		const second = writer.run(async () => {
			order.push('second');
			return 2;
		});
		await expect(first).rejects.toThrow('boom');
		await expect(second).resolves.toBe(2);
		expect(order).toEqual(['first', 'second']);
		expect(slept).toEqual([1000]);
	});
});
