import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BackendDataError, LOCAL_CAPABILITIES, UnsupportedByBackendError } from '@wadeck-app/task-core';
import { RESTRICTED_CAPABILITIES, createRestrictedBackend } from '@wadeck-app/task-core/contract';

import {
	IDENTITY_KEYS,
	contentHash,
	identityCarrierProblem,
	identityMeta,
	isIdentityKey,
	readIdentity,
} from './identityBlock.js';

const FACTS = {
	title: 'Fix the login',
	status: 'backlog',
	labels: ['b', 'a'],
	meta: { team: 'x', area: 'y' },
	type: 'bug',
	priority: 'high',
	assignee: 'w1',
};

describe('identity block: the metadata a copy in "new" carries', () => {
	it('is three metadata entries under the migrating. prefix', () => {
		expect(identityMeta({ publicId: 'a1', fromId: 'a1', hash: '0123456789abcdef' })).toEqual({
			'migrating.publicId': 'a1',
			'migrating.fromId': 'a1',
			'migrating.hash': '0123456789abcdef',
		});
		expect(Object.values(IDENTITY_KEYS).every(isIdentityKey)).toBe(true);
		expect(isIdentityKey('team')).toBe(false);
	});

	it('has no fromId for a task that never was in "current"', () => {
		const meta = identityMeta({ publicId: '9', hash: '0123456789abcdef' });
		expect(meta).toEqual({ 'migrating.publicId': '9', 'migrating.hash': '0123456789abcdef' });
		expect(readIdentity(meta, 'task 9')).toEqual({ publicId: '9', hash: '0123456789abcdef' });
	});

	it('is read back as written', () => {
		const block = { publicId: 'a1', fromId: 'a1', hash: 'fedcba9876543210' };
		expect(readIdentity({ ...identityMeta(block), team: 'x' }, 'task 7')).toEqual(block);
	});

	it('is absent (undefined) for a task that carries none of it', () => {
		expect(readIdentity(undefined, 'task 7')).toBeUndefined();
		expect(readIdentity({ team: 'x' }, 'task 7')).toBeUndefined();
	});

	it.each([
		['no public id', { 'migrating.hash': '0123456789abcdef' }, IDENTITY_KEYS.publicId],
		['no hash', { 'migrating.publicId': 'a1' }, IDENTITY_KEYS.hash],
		[
			'an empty public id',
			{ 'migrating.publicId': '', 'migrating.hash': '0123456789abcdef' },
			IDENTITY_KEYS.publicId,
		],
		[
			'a hash that is not 16 hex characters',
			{ 'migrating.publicId': 'a1', 'migrating.hash': 'xyz' },
			IDENTITY_KEYS.hash,
		],
		[
			'an unknown migrating. key',
			{ 'migrating.publicId': 'a1', 'migrating.hash': '0123456789abcdef', 'migrating.other': '1' },
			'migrating.other',
		],
	])('is a loud error naming the task and the key when it is damaged: %s', (_name, meta, key) => {
		let thrown: unknown;
		try {
			readIdentity(meta, 'task 7 in "new"');
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(BackendDataError);
		const error = thrown as BackendDataError;
		expect(error.message).toContain('task 7 in "new"');
		expect(error.message).toContain(key);
		expect(error.hint.length).toBeGreaterThan(20);
	});
});

describe('contentHash', () => {
	it('is 16 hexadecimal characters', () => {
		expect(contentHash(FACTS)).toMatch(/^[0-9a-f]{16}$/);
	});

	it('does not depend on the order of the labels or of the metadata keys', () => {
		expect(contentHash({ ...FACTS, labels: ['a', 'b'], meta: { area: 'y', team: 'x' } })).toBe(contentHash(FACTS));
	});

	it('does not see the identity block itself', () => {
		const withBlock = {
			...FACTS,
			meta: { ...FACTS.meta, ...identityMeta({ publicId: 'a1', hash: '0123456789abcdef' }) },
		};
		expect(contentHash(withBlock)).toBe(contentHash(FACTS));
	});

	it('treats a description equal to the title as no description', () => {
		expect(contentHash({ ...FACTS, description: FACTS.title })).toBe(contentHash(FACTS));
	});

	it.each([
		['the title', { title: 'Other' }],
		['the description', { description: 'more' }],
		['the status', { status: 'done' }],
		['a label', { labels: ['a'] }],
		['a metadata value', { meta: { team: 'z', area: 'y' } }],
		['the type', { type: 'feature' }],
		['the priority', { priority: 'low' }],
		['the assignee', { assignee: 'w2' }],
	])('changes with %s', (_name, change) => {
		expect(contentHash({ ...FACTS, ...change })).not.toBe(contentHash(FACTS));
	});

	it('is not fooled by a value that moves from one field to the next', () => {
		expect(contentHash({ ...FACTS, type: 'ab', priority: 'c' })).not.toBe(
			contentHash({ ...FACTS, type: 'a', priority: 'bc' })
		);
	});
});

describe('identityCarrierProblem: can this side hold the identity block?', () => {
	it('is fine for a side that stores metadata and accepts writes', () => {
		expect(identityCarrierProblem(LOCAL_CAPABILITIES, 'local')).toBeUndefined();
	});

	it('names the side, the missing capability and the fix when the side has no metadata', () => {
		const problem = identityCarrierProblem(RESTRICTED_CAPABILITIES, 'the-strategy');
		expect(problem).toBeDefined();
		expect(problem).toContain('"new"');
		expect(problem).toContain('the-strategy');
		expect(problem).toContain('metadata');
		expect(problem).toContain('fills');
		expect(problem).toContain('Fix:');
	});

	it('refuses a side that takes no write at all', () => {
		const problem = identityCarrierProblem({ ...LOCAL_CAPABILITIES, writes: 'none' }, 'ro');
		expect(problem).toContain('writes');
		expect(problem).toContain('Fix:');
	});
});

describe('identityCarrierProblem over a real side that cannot store metadata', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('the restricted fake refuses the metadata, and the check names the same fact before anything is copied', async () => {
		const side = createRestrictedBackend(path.join(root, 'tasks'));
		const task = await side.create({ title: 'x', status: 'backlog' });

		await expect(side.setMeta(task.id, IDENTITY_KEYS.publicId, 'x')).rejects.toBeInstanceOf(
			UnsupportedByBackendError
		);
		const problem = identityCarrierProblem(side.capabilities, 'the restricted side');
		expect(problem).toContain('capabilities.meta is false');
		expect(problem).toContain('the restricted side');
	});
});
