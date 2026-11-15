// What a move costs and how fast the worker may spend it. Everything comes from the traits of the sides (cost per write, a cost model, a
// cap on writes) and from the budget the person wrote: nothing here knows what kind of storage a side is.
//
// The pace is kept with SLIDING WINDOWS, not a bucket that starts full: "at most N in the last minute" is true at every instant, so a
// documented cap (a number of writes a minute, an hour) is never exceeded by a burst, and what the last minute used is the figure
// `status` shows.
import type { BackendTraits, MigrationTaskFacts, VersionedRecord } from '@wadeck-app/task-core';

import { isIdentityKey } from './identityBlock.js';

export interface RateWindowSpec {
	name: string;
	/** What is counted: every request of a move, or only the requests that change the system (writes). */
	unit: 'requests' | 'writes';
	limit: number;
	windowMs: number;
}

export interface MoveCost {
	requests: number;
	writes: number;
	/** How the numbers were found: the cost model of the side, the cost per write times the writes counted, or one unit (no cost declared). */
	basis: 'model' | 'per-write' | 'unit';
}

export interface RateUse {
	requests: number;
	writes: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** The identity block of a copy has four entries (fromId, hash, authority, publicId); the switch writes two of them again. */
const IDENTITY_WRITES = 4;
const SWITCH_WRITES = 2;

/** The windows the worker must stay inside: the person's budget and the cap on writes the side documents. */
export function rateWindowsOf(
	budget: { requestsPerMinute?: number } | undefined,
	traits: BackendTraits
): RateWindowSpec[] {
	const windows: RateWindowSpec[] = [];
	if (budget?.requestsPerMinute !== undefined) {
		windows.push({ name: 'budget', unit: 'requests', limit: budget.requestsPerMinute, windowMs: MINUTE_MS });
	}
	const cap = traits.cost?.contentCap;
	if (cap?.perMinute !== undefined) {
		windows.push({ name: 'content cap per minute', unit: 'writes', limit: cap.perMinute, windowMs: MINUTE_MS });
	}
	if (cap !== undefined) {
		windows.push({ name: 'content cap per hour', unit: 'writes', limit: cap.perHour, windowMs: HOUR_MS });
	}
	return windows;
}

function factsOf(record: VersionedRecord): MigrationTaskFacts {
	const meta = Object.fromEntries(Object.entries(record.meta ?? {}).filter(([key]) => !isIdentityKey(key)));
	return {
		state: 'new',
		status: record.status,
		hasParent: record.parentId !== undefined,
		...(record.type === undefined ? {} : { type: record.type }),
		...(record.priority === undefined ? {} : { priority: record.priority }),
		...(record.assignee === undefined ? {} : { assignee: record.assignee }),
		labels: record.labels ?? [],
		meta,
		// A copy always carries its identity block.
		marker: true,
		links: (record.links ?? []).map(link => link.type),
		comments: record.comments?.length ?? 0,
	};
}

/**
 * What moving this task costs the side it moves to, for the pace and the estimate. An ESTIMATE: it counts the calls of a move from the
 * task's facts (the real count depends on labels that exist, on a relation that has no copy yet, on retries).
 */
export function moveCost(record: VersionedRecord, traits: BackendTraits): MoveCost {
	const { cost } = traits;
	if (cost === undefined) return { requests: 1, writes: 1, basis: 'unit' };
	if (cost.model !== undefined) {
		const counted = cost.model([factsOf(record)]);
		return { requests: counted.requests, writes: counted.writes, basis: 'model' };
	}
	const facts = factsOf(record);
	const fields =
		traits.foldsCreate === true
			? 0
			: (facts.type === undefined ? 0 : 1) +
				(facts.priority === undefined ? 0 : 1) +
				facts.labels.length +
				Object.keys(facts.meta).length +
				IDENTITY_WRITES;
	const writes =
		1 + fields + (facts.assignee === undefined ? 0 : 1) + facts.links.length + facts.comments + SWITCH_WRITES;
	return { requests: writes * cost.requests, writes, basis: 'per-write' };
}

interface Charge {
	at: number;
	requests: number;
	writes: number;
}

/** Keeps what was spent in the last hour and answers, for a charge, how long to wait before it fits every window. */
export class RateLimiter {
	private charges: Charge[] = [];
	private readonly longest: number;

	constructor(
		private readonly windows: readonly RateWindowSpec[],
		private readonly now: () => number
	) {
		this.longest = Math.max(MINUTE_MS, ...windows.map(window => window.windowMs));
	}

	/**
	 * 0 when the charge fits every window now. Otherwise the time until it will (the oldest charges leave the window one by one) and the
	 * window that makes it wait longest. A charge larger than a whole limit passes when the window is empty: it can never fit otherwise.
	 */
	waitFor(cost: MoveCost): { ms: number; window?: string } {
		const now = this.now();
		let worst: { ms: number; window?: string } = { ms: 0 };
		for (const window of this.windows) {
			const ms = this.waitInWindow(window, cost, now);
			if (ms > worst.ms) worst = { ms, window: window.name };
		}
		return worst;
	}

	private waitInWindow(window: RateWindowSpec, cost: MoveCost, now: number): number {
		const amount = window.unit === 'requests' ? cost.requests : cost.writes;
		const inside = this.charges.filter(charge => charge.at > now - window.windowMs);
		let used = inside.reduce(
			(sum, charge) => sum + (window.unit === 'requests' ? charge.requests : charge.writes),
			0
		);
		for (const charge of inside) {
			if (used === 0 || used + amount <= window.limit) break;
			used -= window.unit === 'requests' ? charge.requests : charge.writes;
			if (used === 0 || used + amount <= window.limit) return Math.max(0, charge.at + window.windowMs - now);
		}
		return 0;
	}

	record(cost: MoveCost): void {
		const now = this.now();
		this.charges.push({ at: now, requests: cost.requests, writes: cost.writes });
		this.charges = this.charges.filter(charge => charge.at > now - this.longest);
	}

	/** What the last minute spent. */
	used(): RateUse {
		const since = this.now() - MINUTE_MS;
		const inside = this.charges.filter(charge => charge.at > since);
		return {
			requests: inside.reduce((sum, charge) => sum + charge.requests, 0),
			writes: inside.reduce((sum, charge) => sum + charge.writes, 0),
		};
	}
}
