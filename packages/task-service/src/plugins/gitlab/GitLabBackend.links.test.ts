// Links of the gitlab backend over the fake server: blockedBy (Premium and Ultimate only) and the relate-block fills for duplicateOf
// and causedBy. The fake is modelled on docs.gitlab.com; whether GitLab refuses a second link between two issues, and with which
// code, is UNVERIFIED (the fake answers 409).
import {
	BackendAuthError,
	PartialWriteError,
	TaskConflictError,
	UnsupportedByBackendError,
} from '@wadeck-app/task-core';

import type { DeclaredFills } from '../kinds.js';
import { FakeGitLab } from './fakeGitLab.testkit.js';
import { WRITE_STATUSES, makeGitLabBackend, writeStatusMap } from './gitlabBackend.testkit.js';
import type { TestBackend } from './gitlabBackend.testkit.js';
import type { GitLabTier } from './gitlabOptions.js';

let fake: FakeGitLab;
let t: TestBackend;

const P = '/projects/42';

const BLOCK_FILLS: DeclaredFills = {
	'linkTypes.duplicateOf': { use: 'relate-block', fidelity: 'degrade' },
	'linkTypes.causedBy': { use: 'relate-block', fidelity: 'degrade' },
};

async function start(tier: GitLabTier, fills: DeclaredFills = {}, fakeTier: GitLabTier = tier) {
	fake = await FakeGitLab.start({ tier: fakeTier });
	t = makeGitLabBackend(fake, {
		tier,
		statuses: WRITE_STATUSES,
		options: { statusMap: writeStatusMap(tier) },
		fills,
	});
	for (const title of ['A', 'B', 'C']) await t.backend.create({ title, status: 'backlog' });
	fake.requests.length = 0;
}

afterEach(async () => {
	await fake.stop();
});

const sent = (): string[] => fake.writes().map(request => `${request.method} ${request.path.replace(P, '')}`);

const failure = async (call: () => Promise<unknown>): Promise<Error> => {
	try {
		await call();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a failure');
};

describe('blockedBy on the free tier', () => {
	beforeEach(() => start('free'));

	it('is refused before any request, with the tier to declare', async () => {
		const error = await failure(() => t.backend.addLink('1', 'blockedBy', '2'));

		expect(error).toBeInstanceOf(UnsupportedByBackendError);
		expect((error as UnsupportedByBackendError).capability).toBe('linkTypes');
		expect((error as UnsupportedByBackendError).hint).toContain('Premium and Ultimate');
		expect((error as UnsupportedByBackendError).hint).toContain('strategy.options.tier');
		expect(fake.requests).toEqual([]);
		expect(await failure(() => t.backend.removeLink('1', 'blockedBy', '2'))).toBeInstanceOf(
			UnsupportedByBackendError
		);
	});

	it('refuses duplicateOf and causedBy without their fill, naming the fill to declare', async () => {
		for (const type of ['duplicateOf', 'causedBy'] as const) {
			const error = await failure(() => t.backend.addLink('1', type, '2'));
			expect(error).toBeInstanceOf(UnsupportedByBackendError);
			expect((error as UnsupportedByBackendError).hint).toContain(
				`linkTypes.${type}: { use: relate-block, fidelity: degrade }`
			);
		}
		expect(fake.requests).toEqual([]);
	});
});

describe('blockedBy on premium', () => {
	beforeEach(() => start('premium'));

	it('adds an is_blocked_by link with one POST and reads it back from both ends', async () => {
		const record = await t.backend.addLink('1', 'blockedBy', '2');

		expect(sent()).toEqual(['POST /issues/1/links']);
		expect(fake.writes()[0]!.body).toEqual({
			target_project_id: 42,
			target_issue_iid: 2,
			link_type: 'is_blocked_by',
		});
		expect(record.links).toEqual([{ type: 'blockedBy', target: '2' }]);
		expect((await t.backend.getLinks('2')).blocks.map(task => task.id)).toEqual(['1']);
		expect(fake.links(2)).toEqual([{ iid: 1, type: 'blocks' }]);
	});

	it('refuses a duplicate, itself, an unknown target and a cycle, with the local wording, and sends nothing', async () => {
		await t.backend.addLink('1', 'blockedBy', '2');
		await t.backend.addLink('2', 'blockedBy', '3');
		fake.requests.length = 0;

		const duplicate = await failure(() => t.backend.addLink('1', 'blockedBy', '2'));
		const itself = await failure(() => t.backend.addLink('1', 'blockedBy', '1'));
		const direct = await failure(() => t.backend.addLink('2', 'blockedBy', '1'));
		const transitive = await failure(() => t.backend.addLink('3', 'blockedBy', '1'));

		expect(duplicate).toBeInstanceOf(TaskConflictError);
		expect(duplicate.message).toContain('already blockedBy');
		expect(itself.message).toContain('itself');
		expect(direct.message).toContain('cycle');
		expect(transitive.message).toContain('cycle');
		expect(transitive.message).toContain('3 -> 1');
		expect(await failure(() => t.backend.addLink('1', 'blockedBy', '99'))).toMatchObject({
			name: 'TaskNotFoundError',
		});
		expect(fake.writes()).toEqual([]);
	});

	it('removes it with a DELETE of the link id, and says when the link is not there', async () => {
		await t.backend.addLink('1', 'blockedBy', '2');
		fake.requests.length = 0;

		const record = await t.backend.removeLink('1', 'blockedBy', '2');

		expect(sent()).toHaveLength(1);
		expect(sent()[0]).toMatch(/^DELETE \/issues\/1\/links\/\d+$/);
		expect(record.links).toBeUndefined();
		expect(await failure(() => t.backend.removeLink('1', 'blockedBy', '2'))).toBeInstanceOf(TaskConflictError);
	});

	it('refuses to add a blocking link to a pair that already has another kind of link, and says why', async () => {
		fake.seedLink(1, 2, 'relates_to');

		const error = await failure(() => t.backend.addLink('1', 'blockedBy', '2'));

		expect(error).toBeInstanceOf(TaskConflictError);
		expect(error.message).toContain('relates to');
	});

	it('names the tier when the instance refuses the link: a project declared premium on a free instance', async () => {
		await fake.stop();
		await start('premium', {}, 'free');

		const error = await failure(() => t.backend.addLink('1', 'blockedBy', '2'));

		expect(error).toBeInstanceOf(BackendAuthError);
		expect(error.message).toContain('Premium or Ultimate');
		expect((error as BackendAuthError).hint).toContain('tier: free');
	});

	it('getOpenBlockers and getUnblockedBy follow the links', async () => {
		await t.backend.addLink('1', 'blockedBy', '2');
		const terminal = (status: string): boolean => status === 'done';

		expect((await t.backend.getOpenBlockers('1', terminal)).map(task => task.id)).toEqual(['2']);
		await t.backend.updateStatus('2', 'done');
		expect(await t.backend.getOpenBlockers('1', terminal)).toEqual([]);
		expect((await t.backend.getUnblockedBy('2', terminal)).map(task => task.id)).toEqual(['1']);
	});
});

describe('duplicateOf and causedBy with the relate-block fill', () => {
	beforeEach(() => start('free', BLOCK_FILLS));

	it('writes the entry in the description block, then a relates_to link, and reads both ways', async () => {
		const record = await t.backend.addLink('1', 'duplicateOf', '2');

		expect(sent()).toEqual(['PUT /issues/1', 'POST /issues/1/links']);
		expect(fake.writes()[1]!.body).toEqual({ target_project_id: 42, target_issue_iid: 2, link_type: 'relates_to' });
		expect(fake.issue(1)!.description).toBe(
			'<!-- task:begin v1 -->{"links":[{"type":"duplicateOf","target":"2"}]}<!-- task:end -->'
		);
		expect(record.links).toEqual([{ type: 'duplicateOf', target: '2' }]);
		const other = await t.backend.getLinks('2');
		expect(other.duplicates.map(task => task.id)).toEqual(['1']);
		expect(t.notices.some(notice => notice.kind === 'emulated' && notice.text.includes('relate-block'))).toBe(true);
	});

	it('never uses the /duplicate quick action', async () => {
		await t.backend.addLink('1', 'duplicateOf', '2');

		expect(fake.quickActionsRun).toBe(0);
		expect(fake.issue(1)!.state).toBe('opened');
	});

	it('keeps several causedBy entries, a single duplicateOf, and refuses repeats and cycles', async () => {
		await t.backend.addLink('1', 'causedBy', '2');
		await t.backend.addLink('1', 'causedBy', '3');
		await t.backend.addLink('1', 'duplicateOf', '2');

		expect((await t.backend.get('1')).links).toEqual([
			{ type: 'causedBy', target: '2' },
			{ type: 'causedBy', target: '3' },
			{ type: 'duplicateOf', target: '2' },
		]);
		const repeat = await failure(() => t.backend.addLink('1', 'causedBy', '2'));
		const second = await failure(() => t.backend.addLink('1', 'duplicateOf', '3'));
		const cycle = await failure(() => t.backend.addLink('2', 'causedBy', '1'));
		expect(repeat.message).toContain('already causedBy');
		expect(second.message).toContain('already a duplicateOf of "2"');
		expect(cycle).toBeInstanceOf(TaskConflictError);
		expect(cycle.message).toContain('cycle');
		// one relates_to link per pair, not per entry
		expect(fake.links(1).filter(link => link.iid === 2)).toHaveLength(1);
	});

	it('removing an entry removes the relates_to link too, unless another entry still needs it', async () => {
		await t.backend.addLink('1', 'causedBy', '2');
		await t.backend.addLink('1', 'duplicateOf', '2');
		fake.requests.length = 0;

		await t.backend.removeLink('1', 'causedBy', '2');
		expect(sent()).toEqual(['PUT /issues/1']);
		expect(fake.links(1)).toEqual([{ iid: 2, type: 'relates_to' }]);

		fake.requests.length = 0;
		const record = await t.backend.removeLink('1', 'duplicateOf', '2');

		expect(sent()[0]).toBe('PUT /issues/1');
		expect(sent()[1]).toMatch(/^DELETE \/issues\/1\/links\/\d+$/);
		expect(record.links).toBeUndefined();
		expect(fake.links(1)).toEqual([]);
		expect(fake.issue(1)!.description ?? '').toBe('');
		expect(await failure(() => t.backend.removeLink('1', 'duplicateOf', '2'))).toBeInstanceOf(TaskConflictError);
	});

	it('a failure of the second step after the first is a PartialWriteError with the command that finishes it', async () => {
		fake.failNext({ status: 400, method: 'POST', body: { message: 'nope' } });

		const error = (await failure(() => t.backend.addLink('1', 'causedBy', '2'))) as PartialWriteError;

		expect(error).toBeInstanceOf(PartialWriteError);
		expect(error.applied).toEqual(['wrote the causedBy entry in the description']);
		expect(error.notApplied).toEqual(['added the link "relates to" #2']);
		expect(error.hint).toContain('task link 1 causedBy 2');
	});

	it('an unreadable block of another issue does not stop the cycle check, it is reported as ignored when read', async () => {
		fake.issue(3)!.description = '<!-- task:begin v1 -->{not json<!-- task:end -->';

		await t.backend.addLink('1', 'causedBy', '2');

		expect((await t.backend.getLinksLenient('2')).links.causes.map(task => task.id)).toEqual(['1']);
		expect(t.notices.some(notice => notice.kind === 'ignored')).toBe(true);
	});
});
