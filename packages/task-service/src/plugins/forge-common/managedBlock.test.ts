import { BackendDataError } from '@wadeck-app/task-core';
import { describe, expect, it } from 'vitest';

import { composeBody, readManagedBlock } from './managedBlock.js';

const input = (raw: string, linkTypes: readonly string[] = ['duplicateOf']) => ({
	raw,
	backendKind: 'github' as const,
	forgeName: 'GitHub',
	subject: 'issue #7',
	issueUrl: 'https://example.test/7',
	linkTypes,
});

const block = (json: string): string => `<!-- task:begin v1 -->${json}<!-- task:end -->`;

function failure(raw: string): BackendDataError {
	try {
		readManagedBlock(input(raw));
	} catch (error) {
		return error as BackendDataError;
	}
	throw new Error('expected readManagedBlock to throw');
}

describe('readManagedBlock', () => {
	it('a text without block is returned as it is', () => {
		expect(readManagedBlock(input('plain'))).toEqual({
			blockMeta: undefined,
			blockData: undefined,
			links: [],
			text: 'plain',
		});
	});

	it('reads meta, links of the wanted types in order, and removes the block from the text', () => {
		const raw = `Text\n\n${block('{"meta":{"a":"1"},"links":[{"type":"duplicateOf","target":3},{"type":"causedBy","target":"4"},{"type":"duplicateOf","target":"5"}]}')}`;
		const read = readManagedBlock(input(raw));
		expect(read.blockMeta).toEqual({ a: '1' });
		expect(read.links).toEqual([
			{ type: 'duplicateOf', target: '3' },
			{ type: 'duplicateOf', target: '5' },
		]);
		expect(read.text.trim()).toBe('Text');
		expect(readManagedBlock(input(raw, ['duplicateOf', 'causedBy'])).links).toHaveLength(3);
	});

	it.each([
		['<!-- task:begin v1 -->{}', 'has no end marker'],
		[block('{nope'), 'is not valid JSON'],
		[block('[]'), 'is not a JSON object'],
		[block('{"meta":[]}'), 'has a "meta" that is not an object'],
		[block('{"meta":{"k":1}}'), 'has a meta value that is not a text (k)'],
		[block('{"links":{}}'), 'has a "links" that is not a list'],
		[block('{"claim":[]}'), 'has a "claim" that is not an object'],
		[block('{"claim":{}}'), 'has a claim without an assignee'],
		[block('{"claim":{"assignee":""}}'), 'has a claim without an assignee'],
		[block('{"claim":{"assignee":"w","leaseUntil":5}}'), 'has a claim whose leaseUntil is not an ISO instant'],
		[block('{"claim":{"assignee":"w","claimedAt":"soon"}}'), 'has a claim whose claimedAt is not an ISO instant'],
	])('%s is an error naming the issue and the fix', (raw, message) => {
		const error = failure(raw);
		expect(error).toBeInstanceOf(BackendDataError);
		expect(error.backendKind).toBe('github');
		expect(error.message).toContain(`the task block of issue #7 ${message}`);
		expect(error.hint).toContain('https://example.test/7');
	});

	it('reads the claim: an assignee alone, or with the claim instants; no claim key reads as none', () => {
		expect(readManagedBlock(input(block('{"claim":{"assignee":"w1"}}'))).claim).toEqual({ assignee: 'w1' });
		const full =
			'{"meta":{"a":"1"},"claim":{"assignee":"w1","claimedAt":"2026-11-14T10:00:00.000Z","leaseUntil":"2026-11-14T10:30:00.000Z"}}';
		const read = readManagedBlock(input(`Text\n\n${block(full)}`));
		expect(read.claim).toEqual({
			assignee: 'w1',
			claimedAt: '2026-11-14T10:00:00.000Z',
			leaseUntil: '2026-11-14T10:30:00.000Z',
		});
		expect(read.blockMeta).toEqual({ a: '1' });
		expect(readManagedBlock(input('plain')).claim).toBeUndefined();
		expect(readManagedBlock(input(block('{"meta":{}}'))).claim).toBeUndefined();
	});

	it('another format version says to update task or remove the block on the forge', () => {
		const error = failure('<!-- task:begin v2 -->{}<!-- task:end -->');
		expect(error.message).toContain('has format v2');
		expect(error.hint).toBe('Update task (task cli update), or remove the block on GitHub');
	});
});

describe('composeBody', () => {
	it('puts the block last, and drops an empty one', () => {
		expect(composeBody('Text', { meta: { a: '1' } })).toBe(`Text\n\n${block('{"meta":{"a":"1"}}')}`);
		expect(composeBody('', { a: 1 })).toBe(block('{"a":1}'));
		expect(composeBody('Text', {})).toBe('Text');
		expect(composeBody('Text', undefined)).toBe('Text');
	});
});
