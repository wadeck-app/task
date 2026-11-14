// What the revision of a github and of a gitlab issue share: one short hash per part of the issue, and the check of a write against
// the revision the caller read by the PARTS THE WRITE CHANGES (a comment, or a label added to a task whose title is being edited, is
// not a conflict). Each forge says which parts exist, how it reads them out of an issue and how its revision text is laid out.
import * as crypto from 'node:crypto';

/** Six hex characters of a SHA-1: enough to tell two states of one part apart, short enough to read in JSON and logs. */
export function shortHash(text: string): string {
	return crypto.createHash('sha1').update(text).digest('hex').slice(0, 6);
}

/**
 * The part of the revision that stands for the meta kept in the managed block. `read` returns the meta of the block; a block that
 * cannot be read has a stable hash of its own: the write that reads it reports the problem.
 */
export function blockMetaPart(read: () => Record<string, string> | undefined): string {
	try {
		const meta = read() ?? {};
		return JSON.stringify(
			Object.keys(meta)
				.sort()
				.map(key => [key, meta[key]])
		);
	} catch {
		return 'unreadable';
	}
}

/** `a.b.c` (one hash per group, in order) as a record; undefined when it is not what a revision of these groups holds. */
export function partsFromHashes<G extends string>(hashes: string, groups: readonly G[]): Record<G, string> | undefined {
	const values = hashes.split('.');
	if (values.length !== groups.length || values.some(value => !/^[0-9a-f]{6}$/.test(value))) return undefined;
	return Object.fromEntries(groups.map((group, index) => [group, values[index]!])) as Record<G, string>;
}

/**
 * The parts among `groups` that differ between the revision the caller read and the current one; empty = the write may go on. The
 * same revision is never stale. A revision this backend did not issue is `['revision']` (stale for any write). `partsOf` reads the
 * hashes out of the revision text of the forge.
 */
export function checkRevisionParts<G extends string>(
	expected: string,
	actual: string,
	groups: readonly G[],
	partsOf: (revision: string) => Record<G, string> | undefined
): string[] {
	if (expected === actual) return [];
	const wanted = partsOf(expected);
	const current = partsOf(actual);
	if (wanted === undefined || current === undefined) return ['revision'];
	return groups.filter(group => wanted[group] !== current[group]);
}
