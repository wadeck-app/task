// The managed block both forge strategies keep in the text of an issue: an HTML comment holding JSON, written by task
// (`<!-- task:begin v1 -->{json}<!-- task:end -->`, last in the text). What it holds is what the forge cannot return itself
// (meta, links). Reading it is the same on every forge; only the names in the messages and the link types read differ, so they
// are parameters.
import { BackendDataError } from '@wadeck-app/task-core';
import type { BackendKind } from '@wadeck-app/task-core';

const BLOCK = /<!--\s*task:begin\s+v(\d+)\s*-->([\s\S]*?)<!--\s*task:end\s*-->/;
const BLOCK_BEGIN = /<!--\s*task:begin\b/;

export interface BlockLink {
	type: string;
	target: string;
}

export interface BlockReadInput {
	/** The text of the issue, CRLF already read as LF. */
	raw: string;
	backendKind: BackendKind;
	/** The forge as a person writes it in a message (`GitHub`). */
	forgeName: string;
	/** What the messages call the issue (`issue #12`). */
	subject: string;
	/** Where the issue is, for the fix. */
	issueUrl: string;
	/** The link types of the block that are read; the others are ignored. */
	linkTypes: readonly string[];
}

/**
 * Who holds the issue, as the block keeps it (`claim` key): the assignee alone for a plain assignment, with the instants of a claim
 * under a lease. Neither forge has a field for it that is not a forge user, so it travels in the block.
 */
export interface BlockClaim {
	assignee: string;
	/** ISO instant of the claim; absent for a hand-made assignee. */
	claimedAt?: string;
	/** ISO instant the lease ends; absent for a hand-made assignee. */
	leaseUntil?: string;
}

export interface BlockRead {
	/** The claim the block holds; absent without a `claim` key. */
	claim: BlockClaim | undefined;
	/** The meta the block holds; absent without a `meta` key. */
	blockMeta: Record<string, string> | undefined;
	/** The whole content of the block; absent when the text has no block. */
	blockData: Record<string, unknown> | undefined;
	/** The links of the block of a wanted type, in the order written. */
	links: BlockLink[];
	/** The text without the block, not trimmed. */
	text: string;
}

/** Reads the block out of `raw`. A block that cannot be read is an error naming the issue, never a guess. */
export function readManagedBlock(input: BlockReadInput): BlockRead {
	const { raw, backendKind, forgeName, subject, issueUrl } = input;
	const fix = `Repair or remove the block between <!-- task:begin v1 --> and <!-- task:end --> on ${issueUrl}`;
	const bad = (message: string, hint: string = fix): BackendDataError =>
		new BackendDataError(backendKind, subject, `the task block of ${subject} ${message}`, hint);
	const match = BLOCK.exec(raw);
	if (match === null) {
		if (BLOCK_BEGIN.test(raw)) throw bad('has no end marker');
		return { claim: undefined, blockMeta: undefined, blockData: undefined, links: [], text: raw };
	}
	if (match[1] !== '1') {
		throw bad(
			`has format v${match[1]}, which this version of task does not read`,
			`Update task (task cli update), or remove the block on ${forgeName}`
		);
	}
	let data: unknown;
	try {
		data = JSON.parse(match[2]!);
	} catch (error) {
		throw bad(`is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (typeof data !== 'object' || data === null || Array.isArray(data)) throw bad('is not a JSON object');
	let blockMeta: Record<string, string> | undefined;
	const meta = (data as { meta?: unknown }).meta;
	if (meta !== undefined) {
		if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
			throw bad('has a "meta" that is not an object');
		}
		blockMeta = {};
		for (const [key, value] of Object.entries(meta)) {
			if (typeof value !== 'string') throw bad(`has a meta value that is not a text (${key})`);
			blockMeta[key] = value;
		}
	}
	const links: BlockLink[] = [];
	const listed = (data as { links?: unknown }).links;
	if (listed !== undefined) {
		if (!Array.isArray(listed)) throw bad('has a "links" that is not a list');
		for (const link of listed as Array<{ type?: unknown; target?: unknown }>) {
			if (
				typeof link?.type === 'string' &&
				input.linkTypes.includes(link.type) &&
				(typeof link.target === 'string' || typeof link.target === 'number')
			) {
				links.push({ type: link.type, target: String(link.target) });
			}
		}
	}
	let claim: BlockClaim | undefined;
	const held = (data as { claim?: unknown }).claim;
	if (held !== undefined) {
		if (typeof held !== 'object' || held === null || Array.isArray(held))
			throw bad('has a "claim" that is not an object');
		const { assignee, claimedAt, leaseUntil } = held as Record<string, unknown>;
		if (typeof assignee !== 'string' || assignee.trim() === '') throw bad('has a claim without an assignee');
		for (const [key, value] of [
			['claimedAt', claimedAt],
			['leaseUntil', leaseUntil],
		] as const) {
			if (value !== undefined && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) {
				throw bad(`has a claim whose ${key} is not an ISO instant`);
			}
		}
		claim = {
			assignee,
			...(claimedAt === undefined ? {} : { claimedAt: claimedAt as string }),
			...(leaseUntil === undefined ? {} : { leaseUntil: leaseUntil as string }),
		};
	}
	return { claim, blockMeta, blockData: data as Record<string, unknown>, links, text: raw.replace(BLOCK, '') };
}

const blockOf = (data: Record<string, unknown>): string =>
	`<!-- task:begin v1 -->${JSON.stringify(data)}<!-- task:end -->`;

/** The text to write: the visible text, then the managed block when it holds anything (the block is last, an empty one is dropped). */
export function composeBody(visibleText: string, data: Record<string, unknown> | undefined): string {
	if (data === undefined || Object.keys(data).length === 0) return visibleText;
	return visibleText === ''
		? blockOf(data)
		: `${visibleText}

${blockOf(data)}`;
}
