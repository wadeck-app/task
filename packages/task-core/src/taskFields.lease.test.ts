import { MAX_LEASE_MINUTES } from './TaskConfigLoader';
import { InvalidTaskFieldError, LEASE_MS_MAX, LEASE_MS_MIN, normalizeClaimRequest } from './taskFields';

// The one lease rule of every backend: normalizeClaimRequest.
const NOW = '2026-11-14T10:00:00.000Z';
const at = (ms: number): string => new Date(Date.parse(NOW) + ms).toISOString();
const request = (leaseMs: number) => ({ assignee: 'w1', now: NOW, leaseUntil: at(leaseMs) });

describe('the lease bounds of normalizeClaimRequest', () => {
	it('shares its constants with the config limit: 1 second to MAX_LEASE_MINUTES', () => {
		expect(LEASE_MS_MIN).toBe(1000);
		expect(LEASE_MS_MAX).toBe(MAX_LEASE_MINUTES * 60_000);
	});

	it('accepts both ends', () => {
		expect(normalizeClaimRequest(request(LEASE_MS_MIN)).leaseUntil).toBe(at(LEASE_MS_MIN));
		expect(normalizeClaimRequest(request(LEASE_MS_MAX)).leaseUntil).toBe(at(LEASE_MS_MAX));
	});

	it.each([500, 999, LEASE_MS_MAX + 1])(
		'refuses a lease of %i ms as an invalid lease with the bounds in the text',
		ms => {
			const error = (() => {
				try {
					normalizeClaimRequest(request(ms));
				} catch (e) {
					return e as InvalidTaskFieldError;
				}
				throw new Error('expected a refusal');
			})();
			expect(error).toBeInstanceOf(InvalidTaskFieldError);
			expect(error.field).toBe('lease');
			expect(error.message).toContain('1 second');
			expect(error.message).toContain(`${MAX_LEASE_MINUTES} minutes`);
		}
	);
});
