// Bearer-token check of the task server: constant-time comparison, and a small fixed delay after a failure with a counter (no lockout:
// a legitimate client with a typo must never be locked out of its own server; the delay makes guessing slow, not impossible, and the
// token is long and random). The token is never logged, echoed or kept anywhere but here.
import * as crypto from 'node:crypto';

/** The shortest token the server accepts to start with: a guessable one defeats the point of the check. */
export const MIN_TOKEN_LENGTH = 16;

export interface TokenCheck {
	/** True when the `Authorization` header carries exactly the server's bearer token. */
	accepts(authorization: string | undefined): boolean;
}

function digest(text: string): Buffer {
	return crypto.createHash('sha256').update(text, 'utf8').digest();
}

/** Compares in constant time: both sides are hashed to the same length first, so neither the length nor the content leaks through timing. */
export function createTokenCheck(token: string): TokenCheck {
	const expected = digest(token);
	return {
		accepts(authorization) {
			const match = /^Bearer (.+)$/.exec(authorization ?? '');
			// Always hash something, so a missing header costs the same as a wrong one.
			const given = digest(match?.[1] ?? '');
			return crypto.timingSafeEqual(given, expected) && match !== null;
		},
	};
}

export interface AuthFailureLimiter {
	/** Records a failure of `source` (an address) and returns how many it has made, and the delay to wait before answering. */
	failed(source: string): { count: number; delayMs: number };
	total(): number;
}

/** A fixed delay per failure and a counter per source. No lockout, no growth: the cost of a guess is constant. */
export function createFailureLimiter(delayMs: number): AuthFailureLimiter {
	const counts = new Map<string, number>();
	let total = 0;
	return {
		failed(source) {
			total++;
			const count = (counts.get(source) ?? 0) + 1;
			counts.set(source, count);
			// Bounded memory: a scan from many addresses must not grow the map without limit.
			if (counts.size > 1000) counts.delete(counts.keys().next().value as string);
			return { count, delayMs };
		},
		total: () => total,
	};
}
