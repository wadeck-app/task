// The identity block: what every copy of a task in "new" carries, as metadata, so the routing index can be rebuilt from the stores
// alone and a task keeps the id the person knows. Only the generic metadata capability of the port is used: nothing here knows what
// kind of storage holds it. Three entries:
//   migrating.publicId  the id the person sees (the id in "current" for a task that was there, else its own id in "new")
//   migrating.fromId    the id in "current" the copy was made from (absent for a task created in "new")
//   migrating.hash      16 hex characters: a hash of the content of the task when it was copied (see contentHash)
// The three keys are short on purpose: a metadata carrier may cap key and value together (a label carrier: 50 characters).
import * as crypto from 'node:crypto';

import { BackendDataError } from '@wadeck-app/task-core';
import type { BackendCapabilities } from '@wadeck-app/task-core';

export const IDENTITY_KEYS = {
	publicId: 'migrating.publicId',
	fromId: 'migrating.fromId',
	hash: 'migrating.hash',
} as const;

const PREFIX = 'migrating.';
const HASH_PATTERN = /^[0-9a-f]{16}$/;

export interface IdentityBlock {
	publicId: string;
	fromId?: string;
	hash: string;
}

export function isIdentityKey(key: string): boolean {
	return key.startsWith(PREFIX);
}

export function identityMeta(block: IdentityBlock): Record<string, string> {
	return {
		[IDENTITY_KEYS.publicId]: block.publicId,
		...(block.fromId === undefined ? {} : { [IDENTITY_KEYS.fromId]: block.fromId }),
		[IDENTITY_KEYS.hash]: block.hash,
	};
}

function damaged(subject: string, key: string, problem: string): never {
	throw new BackendDataError(
		'migrating',
		subject,
		`${subject}: the identity block is damaged: ${key} ${problem}`,
		'Someone edited the metadata of this task by hand. Put the entry back (the rebuild of the routing index prints what it read), or remove every "migrating." metadata entry of this task to make it a plain task of "new" that the migrating strategy does not know.'
	);
}

/** The identity block of a task's metadata; `undefined` when it carries none. A damaged block is a loud error, never read as absent. */
export function readIdentity(
	meta: Readonly<Record<string, string>> | undefined,
	subject: string
): IdentityBlock | undefined {
	const keys = Object.keys(meta ?? {}).filter(isIdentityKey);
	if (meta === undefined || keys.length === 0) return undefined;
	for (const key of keys) {
		if (!(Object.values(IDENTITY_KEYS) as string[]).includes(key))
			damaged(subject, key, 'is not a key of the block');
	}
	const publicId = meta[IDENTITY_KEYS.publicId];
	if (publicId === undefined || publicId === '') damaged(subject, IDENTITY_KEYS.publicId, 'is missing or empty');
	const hash = meta[IDENTITY_KEYS.hash];
	if (hash === undefined || !HASH_PATTERN.test(hash)) {
		damaged(subject, IDENTITY_KEYS.hash, `must be 16 hexadecimal characters, found ${JSON.stringify(hash)}`);
	}
	const fromId = meta[IDENTITY_KEYS.fromId];
	if (fromId === '') damaged(subject, IDENTITY_KEYS.fromId, 'is empty (leave it out for a task created in "new")');
	return { publicId, ...(fromId === undefined ? {} : { fromId }), hash };
}

/** What the content of a task is, for the hash: the fields a person edits. Not its ids, relations, dates, revision or comments. */
export interface ContentFacts {
	title: string;
	description?: string;
	status: string;
	type?: string;
	labels?: readonly string[];
	meta?: Readonly<Record<string, string>>;
	priority?: string;
	assignee?: string;
}

/** A short stable hash of the content of a task: equal for equal content whatever the order of labels and metadata keys. */
export function contentHash(facts: ContentFacts): string {
	const description = facts.description === undefined || facts.description === facts.title ? null : facts.description;
	const meta = Object.entries(facts.meta ?? {})
		.filter(([key]) => !isIdentityKey(key))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const labels = [...(facts.labels ?? [])].sort();
	// A list, not an object: the position names the field, so a value cannot slide into its neighbour.
	const canonical = JSON.stringify([
		facts.title,
		description,
		facts.status,
		facts.type ?? null,
		labels,
		meta,
		facts.priority ?? null,
		facts.assignee ?? null,
	]);
	return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Whether a side can carry the identity block, as the problem and its fix in one text, or `undefined` when it can. The migration
 * start calls it for the "new" side before any task moves: a side that cannot store metadata cannot make the index rebuildable.
 */
export function identityCarrierProblem(capabilities: BackendCapabilities, ref: string): string | undefined {
	if (capabilities.writes === 'none') {
		return `the strategy in "new" (${ref}) takes no writes (capabilities.writes is none), so no task can be copied there. Fix: use a strategy that accepts writes for "new".`;
	}
	if (!capabilities.meta) {
		return `the strategy in "new" (${ref}) cannot store metadata (capabilities.meta is false), and every task copied there carries an identity block in its metadata so the routing index can be rebuilt. Fix: give that strategy metadata (a strategy that can emulate it declares a meta fill in strategy.options.new.options.fills, see \`task strategy show\`), or choose another strategy for "new".`;
	}
	return undefined;
}
