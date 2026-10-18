export function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
		Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
	);
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i]![j] =
				a[i - 1] === b[j - 1]
					? dp[i - 1]![j - 1]!
					: 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
		}
	}
	return dp[m]![n]!;
}

/** Closest candidate to `input` (case-insensitive, edit distance <= 3), or undefined when none is close. */
export function suggest(input: string, candidates: string[]): string | undefined {
	let best: string | undefined;
	let bestDist = Infinity;
	for (const c of candidates) {
		const d = levenshtein(input.toLowerCase(), c.toLowerCase());
		if (d < bestDist) {
			bestDist = d;
			best = c;
		}
	}
	return bestDist <= 3 ? best : undefined;
}

/**
 * Matches a glob pattern (supporting * as wildcard) against a value.
 * The match is case-sensitive and anchored (full value must match).
 */
export function matchGlob(pattern: string, value: string): boolean {
	// Escape all regex metacharacters except *, then replace * with .*
	const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
	return new RegExp(`^${regexStr}$`).test(value);
}
