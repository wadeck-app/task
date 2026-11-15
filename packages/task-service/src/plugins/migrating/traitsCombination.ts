// What a strategy that holds two others keeps and where its limits are: what both sides keep, within the tighter limit of the two. Reads
// values only; nothing here knows what kind of storage a side is. A side that declares nothing was already given NO_TRAITS by the host.
import type { BackendTraits } from '@wadeck-app/task-core';

/** The smaller of two limits; an absent limit (no limit known) does not loosen the other one. */
function tighter(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return Math.min(a, b);
}

function larger(a: number, b: number): number {
	return Math.max(a, b);
}

type Cost = NonNullable<BackendTraits['cost']>;
type PerCall = { requests: number; seconds: number };

/** The costlier of two per-call costs; a side that has none for it is not counted (it is cheaper or unknown, never invented). */
function costlier(a: PerCall | undefined, b: PerCall | undefined): PerCall | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return { requests: larger(a.requests, b.requests), seconds: larger(a.seconds, b.seconds) };
}

/** The cap that allows fewer writes an hour, with its own source; the per-minute cap of a side that has one is kept. */
function stricterCap(a: Cost['contentCap'], b: Cost['contentCap']): Cost['contentCap'] {
	if (a === undefined) return b;
	if (b === undefined) return a;
	const [strict, other] = a.perHour <= b.perHour ? [a, b] : [b, a];
	const perMinute = tighter(strict.perMinute, other.perMinute);
	return { perHour: strict.perHour, ...(perMinute === undefined ? {} : { perMinute }), source: strict.source };
}

/**
 * The pessimistic cost of a write that may touch either side: the larger number of requests and seconds, the smaller quota, the
 * stricter cap. A side with no cost is free. The per-run `model` of a side counts the calls of THAT side's creations, so it does not
 * describe a pair and is left out: the estimate falls back to the cost per write.
 */
function combineCost(a: Cost | undefined, b: Cost | undefined): Cost | undefined {
	if (a === undefined && b === undefined) return undefined;
	const quota = tighter(a?.quotaPerHour, b?.quotaPerHour);
	const read = costlier(a?.read, b?.read);
	const resolve = costlier(a?.resolve, b?.resolve);
	const cap = stricterCap(a?.contentCap, b?.contentCap);
	return {
		requests: larger(a?.requests ?? 0, b?.requests ?? 0),
		seconds: larger(a?.seconds ?? 0, b?.seconds ?? 0),
		...(quota === undefined ? {} : { quotaPerHour: quota }),
		...(read === undefined ? {} : { read }),
		...(resolve === undefined ? {} : { resolve }),
		...(cap === undefined ? {} : { contentCap: cap }),
	};
}

export function combineTraits(a: BackendTraits, b: BackendTraits): BackendTraits {
	const commentTextMax = tighter(a.commentTextMax, b.commentTextMax);
	const commentAuthorMax = tighter(a.commentAuthorMax, b.commentAuthorMax);
	const descriptionMax = tighter(a.descriptionMax, b.descriptionMax);
	const hierarchyDepth = tighter(a.hierarchyDepth, b.hierarchyDepth);
	const childrenPerParent = tighter(a.childrenPerParent, b.childrenPerParent);
	const cost = combineCost(a.cost, b.cost);
	const labelA = a.labelProblem;
	const labelB = b.labelProblem;
	return {
		keepsCreatedAt: a.keepsCreatedAt && b.keepsCreatedAt,
		authoredComments: a.authoredComments && b.authoredComments,
		...(commentTextMax === undefined ? {} : { commentTextMax }),
		...(commentAuthorMax === undefined ? {} : { commentAuthorMax }),
		...(descriptionMax === undefined ? {} : { descriptionMax }),
		...(labelA === undefined && labelB === undefined
			? {}
			: { labelProblem: (label: string) => labelA?.(label) ?? labelB?.(label) }),
		...(hierarchyDepth === undefined ? {} : { hierarchyDepth }),
		...(childrenPerParent === undefined ? {} : { childrenPerParent }),
		...(cost === undefined ? {} : { cost }),
		// `foldsCreate` is never set: the wrapper has no `createMigrated` of its own.
	};
}
