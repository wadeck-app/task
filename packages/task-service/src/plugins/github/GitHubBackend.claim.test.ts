// Assignee and claim on GitHub: kept in the managed block of the issue body (no GitHub user is touched, no fill is declared). The
// decision is the one of the local store (decideClaim...), the write is ONE PATCH of the body after the usual conditional re-read.
import {
	BackendDataError,
	BackendLimitError,
	StaleRevisionError,
	TaskClaimedError,
	TaskNotClaimedError,
	TaskReleaseRefusedError,
} from '@wadeck-app/task-core';

import { FakeGitHub } from './fakeGitHub.testkit.js';
import { WRITE_STATUS_MAP, WRITE_STATUSES, makeGitHubBackend } from './githubBackend.testkit.js';
import type { TestBackend } from './githubBackend.testkit.js';

let fake: FakeGitHub;
let t: TestBackend;

const R = '/repos/acme/shop';
const NOW = '2026-11-14T10:00:00.000Z';
const HALF = '2026-11-14T10:15:00.000Z';
const END = '2026-11-14T10:30:00.000Z';

function make(extra: Parameters<typeof makeGitHubBackend>[1] = {}): TestBackend {
	return makeGitHubBackend(fake, {
		statuses: WRITE_STATUSES,
		...extra,
		options: { statusMap: WRITE_STATUS_MAP, ...extra.options },
	});
}

beforeEach(async () => {
	fake = await FakeGitHub.start({ repo: 'acme/shop' });
	t = make();
});

afterEach(async () => {
	await fake.stop();
});

const sent = (): string[] => fake.writes().map(request => `${request.method} ${request.path.replace(R, '')}`);
const bodyOf = (number: number): string => fake.issues.get(number)!.body ?? '';
const block = (json: string): string => `<!-- task:begin v1 -->${json}<!-- task:end -->`;

const failure = async (call: () => Promise<unknown>): Promise<Error> => {
	try {
		await call();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a failure');
};

describe('setAssignee / clearAssignee', () => {
	it('writes the claim block with ONE PATCH of the body; no GitHub user and no label is touched; the list carries the assignee', async () => {
		const number = fake.addIssue({ title: 'a', body: 'The details' });

		const record = await t.backend.setAssignee!(String(number), ' worker-1 ');

		expect(record.assignee).toBe('worker-1');
		expect(record.claimedAt).toBeUndefined();
		expect(record.leaseUntil).toBeUndefined();
		expect(record.description).toBe('The details');
		expect(bodyOf(number)).toBe(`The details\n\n${block('{"claim":{"assignee":"worker-1"}}')}`);
		expect(sent()).toEqual(['PATCH /issues/1']);
		expect(fake.issues.get(number)!.labels).toEqual([]);
		const summary = (await t.backend.list())[0]!;
		expect(summary.assignee).toBe('worker-1');
		expect(summary.leaseUntil).toBeUndefined();
	});

	it('the same assignee writes nothing and keeps its lease; another one drops the lease', async () => {
		const number = fake.addIssue({ title: 'a' });
		await t.backend.claim!(String(number), { assignee: 'w1', leaseUntil: END, now: NOW });
		fake.requests.splice(0);

		const same = await t.backend.setAssignee!(String(number), 'w1');
		expect(sent()).toEqual([]);
		expect(same.leaseUntil).toBe(END);

		const other = await t.backend.setAssignee!(String(number), 'w2');
		expect(other).toMatchObject({ assignee: 'w2' });
		expect(other.leaseUntil).toBeUndefined();
		expect(other.claimedAt).toBeUndefined();
	});

	it('clear removes the claim and the block with it; clearing an issue nobody holds writes nothing', async () => {
		const number = fake.addIssue({ title: 'a', body: 'Text' });
		await t.backend.setAssignee!(String(number), 'w1');

		const cleared = await t.backend.clearAssignee!(String(number));

		expect(cleared.assignee).toBeUndefined();
		expect(bodyOf(number)).toBe('Text');
		fake.requests.splice(0);
		await t.backend.clearAssignee!(String(number));
		expect(sent()).toEqual([]);
	});

	it('refuses a blank or multi-line assignee before any request', async () => {
		const number = fake.addIssue({ title: 'a' });
		fake.requests.splice(0);

		await failure(() => t.backend.setAssignee!(String(number), ' '));
		await failure(() => t.backend.setAssignee!(String(number), 'a\nb'));

		expect(fake.requests).toEqual([]);
	});

	it('keeps the description, the metadata and the duplicate marker of the block, and every other write keeps the claim', async () => {
		t = make({ fills: { meta: { use: 'body-block', fidelity: 'degrade' } }, projectTypes: [] });
		const number = fake.addIssue({ title: 'a', body: 'Text' });
		await t.backend.setMeta(String(number), 'owner', 'ann');

		await t.backend.setAssignee!(String(number), 'w1');
		expect(bodyOf(number)).toBe(`Text\n\n${block('{"meta":{"owner":"ann"},"claim":{"assignee":"w1"}}')}`);

		await t.backend.setDescription(String(number), 'New text');
		await t.backend.setMeta(String(number), 'owner', 'bob');
		const record = await t.backend.get(String(number));
		expect(record).toMatchObject({ description: 'New text', assignee: 'w1', meta: { owner: 'bob' } });
		expect(bodyOf(number)).toBe(`New text\n\n${block('{"meta":{"owner":"bob"},"claim":{"assignee":"w1"}}')}`);
	});
});

describe('claim and release', () => {
	it('a free issue is claimed with ONE PATCH: assignee, claimedAt and leaseUntil on the record and in the list', async () => {
		const number = fake.addIssue({ title: 'a' });

		const result = await t.backend.claim!(String(number), { assignee: ' w1 ', leaseUntil: END, now: NOW });

		expect(result.outcome).toBe('claimed');
		expect(result.previousAssignee).toBeUndefined();
		expect(result.task).toMatchObject({ assignee: 'w1', claimedAt: NOW, leaseUntil: END });
		expect(sent()).toEqual(['PATCH /issues/1']);
		expect(bodyOf(number)).toBe(block(`{"claim":{"assignee":"w1","claimedAt":"${NOW}","leaseUntil":"${END}"}}`));
		expect((await t.backend.list())[0]).toMatchObject({ assignee: 'w1', leaseUntil: END });
	});

	it('a live lease of someone else is TaskClaimedError naming the holder and the time left; nothing is written', async () => {
		const number = fake.addIssue({ title: 'a' });
		await t.backend.claim!(String(number), { assignee: 'w1', leaseUntil: END, now: NOW });
		fake.requests.splice(0);

		const error = await failure(() =>
			t.backend.claim!(String(number), { assignee: 'w2', leaseUntil: END, now: HALF })
		);

		expect(error).toBeInstanceOf(TaskClaimedError);
		expect(error.message).toContain('claimed by "w1"');
		expect(error.message).toContain('15m');
		expect(sent()).toEqual([]);
	});

	it('the holder renews with renew (claimedAt kept); force and an expired lease are takeovers naming the previous holder', async () => {
		const number = fake.addIssue({ title: 'a' });
		await t.backend.claim!(String(number), { assignee: 'w1', leaseUntil: END, now: NOW });

		const renewed = await t.backend.claim!(String(number), {
			assignee: 'w1',
			leaseUntil: '2026-11-14T12:00:00.000Z',
			now: HALF,
			renew: true,
		});
		expect(renewed.outcome).toBe('renewed');
		expect(renewed.task).toMatchObject({ claimedAt: NOW, leaseUntil: '2026-11-14T12:00:00.000Z' });

		const forced = await t.backend.claim!(String(number), {
			assignee: 'w2',
			leaseUntil: '2026-11-14T13:00:00.000Z',
			now: HALF,
			force: true,
		});
		expect(forced).toMatchObject({ outcome: 'takeover', previousAssignee: 'w1' });
		const late = await t.backend.claim!(String(number), {
			assignee: 'w3',
			leaseUntil: '2026-11-14T15:00:00.000Z',
			now: '2026-11-14T13:00:00.000Z',
		});
		expect(late).toMatchObject({ outcome: 'takeover', previousAssignee: 'w2' });
	});

	it('release clears the holder and the lease; nobody holding it, or another holder without force, is refused', async () => {
		const number = fake.addIssue({ title: 'a' });
		expect(await failure(() => t.backend.release!(String(number)))).toBeInstanceOf(TaskNotClaimedError);
		await t.backend.claim!(String(number), { assignee: 'w1', leaseUntil: END, now: NOW });
		fake.requests.splice(0);
		const refused = await failure(() => t.backend.release!(String(number), { assignee: 'w2' }));
		expect(refused.message).toContain('held by "w1", not by "w2"');
		expect(sent()).toEqual([]);

		const released = await t.backend.release!(String(number), { assignee: 'w1' });

		expect(released.previousAssignee).toBe('w1');
		expect(released.task.assignee).toBeUndefined();
		expect(released.task.leaseUntil).toBeUndefined();
		expect(bodyOf(number)).toBe('');
		expect((await t.backend.list())[0]!.assignee).toBeUndefined();
	});

	it('a bad request (lease not after now, blank assignee) is refused before any request', async () => {
		const number = fake.addIssue({ title: 'a' });
		fake.requests.splice(0);

		await failure(() => t.backend.claim!(String(number), { assignee: 'w1', leaseUntil: NOW, now: NOW }));
		await failure(() => t.backend.claim!(String(number), { assignee: ' ', leaseUntil: END, now: NOW }));

		expect(fake.requests).toEqual([]);
	});
});

describe('the revision of a claim', () => {
	it('is compared on the claim part: another claim made meanwhile is stale, a description edited meanwhile is not', async () => {
		const number = fake.addIssue({ title: 'a', body: 'Text' });
		const read = await t.backend.get(String(number));
		fake.updateIssue(number, { body: 'Edited by a person' });

		const ok = await t.backend.claim!(String(number), {
			assignee: 'w1',
			leaseUntil: END,
			now: NOW,
			expectedRevision: read.revision,
		});
		expect(ok.task.assignee).toBe('w1');
		expect(bodyOf(number)).toContain('Edited by a person');

		const second = await t.backend.get(String(number));
		fake.updateIssue(number, {
			body: `Edited by a person\n\n${block('{"claim":{"assignee":"w9"}}')}`,
		});
		const stale = await failure(() =>
			t.backend.setAssignee!(String(number), 'w2', { expectedRevision: second.revision })
		);
		expect(stale).toBeInstanceOf(StaleRevisionError);
		expect(bodyOf(number)).toContain('w9');
	});

	it('a claim or a renewal does not make a description edit stale; another description edit does', async () => {
		const number = fake.addIssue({ title: 'a', body: 'Text' });
		const read = await t.backend.get(String(number));
		await t.backend.claim!(String(number), { assignee: 'w1', leaseUntil: END, now: NOW });

		await t.backend.claim!(String(number), { assignee: 'w1', leaseUntil: END, now: HALF, renew: true });

		const edited = await t.backend.setDescription(String(number), 'Other', { expectedRevision: read.revision });
		expect(edited.description).toBe('Other');
		expect(bodyOf(number)).toContain('"assignee":"w1"');

		// The same revision once somebody else changed the text first.
		const stale = await failure(() =>
			t.backend.setDescription(String(number), 'Third', { expectedRevision: read.revision })
		);
		expect(stale).toBeInstanceOf(StaleRevisionError);
	});
});

describe('what a corrupt or oversized block does', () => {
	it('a block that cannot be read is an error naming the issue on a read and on a claim, and the list reads the issue as unheld with a notice', async () => {
		const number = fake.addIssue({ title: 'a', body: `Text\n\n${block('{"claim":[]}')}` });
		fake.addIssue({ title: 'b' });

		const read = await failure(() => t.backend.get(String(number)));
		const claim = await failure(() =>
			t.backend.claim!(String(number), { assignee: 'w1', leaseUntil: END, now: NOW })
		);
		const list = await t.backend.list();

		expect(read).toBeInstanceOf(BackendDataError);
		expect(read.message).toContain('the task block of issue #1 has a "claim" that is not an object');
		expect(claim).toBeInstanceOf(BackendDataError);
		expect(list).toHaveLength(2);
		expect(list[0]!.assignee).toBeUndefined();
		expect(
			t.notices.some(
				notice => notice.kind === 'ignored' && notice.text.includes('its assignee and lease read as none')
			)
		).toBe(true);
		expect(sent()).toEqual([]);
	});

	it('a body that would pass the GitHub limit is a limit error, nothing is sent', async () => {
		const number = fake.addIssue({ title: 'a', body: 'x'.repeat(65_500) });
		fake.requests.splice(0);

		const error = await failure(() => t.backend.setAssignee!(String(number), 'w1'));

		expect(error).toBeInstanceOf(BackendLimitError);
		expect(sent()).toEqual([]);
	});
});

describe('two claims one after the other', () => {
	it('the second sees the first (check then write): the contract of a dispatcher is the loser retries the next task', async () => {
		const number = fake.addIssue({ title: 'a' });
		const other = make();

		await t.backend.claim!(String(number), { assignee: 'w1', leaseUntil: END, now: NOW });
		const lost = await failure(() =>
			other.backend.claim!(String(number), { assignee: 'w2', leaseUntil: END, now: HALF })
		);

		expect(lost).toBeInstanceOf(TaskClaimedError);
	});
});

describe('a second worker writing between the re-read and the write', () => {
	// GitHub has no conditional write: the loser's PATCH overwrites the winner's block. The read after the write shows who holds the
	// issue, and the caller that does not hold it is told so (TaskClaimedError naming the real holder), never "claimed".
	const rival = (number: number, holder: string): (() => void) => {
		return () => {
			fake.updateIssue(number, {
				body: block(`{"claim":{"assignee":"${holder}","claimedAt":"${NOW}","leaseUntil":"${END}"}}`),
			});
		};
	};

	it('claim: the rival wrote last, so the caller gets TaskClaimedError naming the rival', async () => {
		const number = fake.addIssue({ title: 'a' });
		// Ours is applied, then the rival's overwrites it before the read-back.
		fake.afterNextWrite(rival(number, 'w2'));

		const error = await failure(() =>
			t.backend.claim!(String(number), { assignee: 'w1', leaseUntil: END, now: NOW })
		);

		expect(error).toBeInstanceOf(TaskClaimedError);
		expect((error as TaskClaimedError).holder).toBe('w2');
		expect(error.message).toContain('"w2"');
	});

	it('claim: the caller that wrote last holds the issue and gets claimed', async () => {
		const number = fake.addIssue({ title: 'a' });
		fake.beforeNextWrite(rival(number, 'w2'));

		const result = await t.backend.claim!(String(number), { assignee: 'w1', leaseUntil: END, now: NOW });

		expect(result.outcome).toBe('claimed');
		expect(result.task).toMatchObject({ assignee: 'w1' });
	});

	it('release: a claim that appears after ours is a TaskConflictError describing the race and naming the new holder', async () => {
		const number = fake.addIssue({ title: 'a' });
		await t.backend.claim!(String(number), { assignee: 'w1', leaseUntil: END, now: NOW });
		fake.afterNextWrite(rival(number, 'w2'));

		const error = await failure(() => t.backend.release!(String(number), {}));

		expect(error.name).toBe('TaskConflictError');
		expect(error).not.toBeInstanceOf(TaskReleaseRefusedError);
		expect(error.message).toContain(`Task "${number}" was claimed by "w2" while you were releasing it`);
	});

	it('setAssignee: the rival wrote last, so the caller is told who holds the issue', async () => {
		const number = fake.addIssue({ title: 'a' });
		fake.afterNextWrite(rival(number, 'w2'));

		const error = await failure(() => t.backend.setAssignee!(String(number), 'w1'));

		expect(error).toBeInstanceOf(TaskClaimedError);
		expect((error as TaskClaimedError).holder).toBe('w2');
	});

	it('clearAssignee: an assignee that appeared after the clear is a TaskConflictError describing the race (no empty requester)', async () => {
		const number = fake.addIssue({ title: 'a' });
		await t.backend.setAssignee!(String(number), 'w1');
		fake.afterNextWrite(rival(number, 'w2'));

		const error = await failure(() => t.backend.clearAssignee!(String(number)));

		expect(error.name).toBe('TaskConflictError');
		expect(error).not.toBeInstanceOf(TaskClaimedError);
		expect(error.message).toContain(`Task "${number}" was claimed by "w2" while you were releasing it`);
	});
});

describe('the visible body is kept byte for byte', () => {
	const TEXT = '  Lead\r\nline two  \r\n\r\n';

	it('a claim appends the block after the raw text and a release takes it away again, leaving the text as it was', async () => {
		const number = fake.addIssue({ title: 'a' });
		fake.updateIssue(number, { body: TEXT });

		await t.backend.claim!(String(number), { assignee: 'w1', leaseUntil: END, now: NOW });

		const claimed = bodyOf(number);
		expect(claimed.startsWith(TEXT)).toBe(true);
		expect(claimed.slice(TEXT.length)).toBe(
			`\n\n${block(`{"claim":{"assignee":"w1","claimedAt":"${NOW}","leaseUntil":"${END}"}}`)}`
		);

		await t.backend.release!(String(number), {});

		expect(bodyOf(number)).toBe(TEXT);
	});

	it('a block in the middle of the text is replaced in place: the bytes before and after it are untouched', async () => {
		const number = fake.addIssue({ title: 'a' });
		const before = '  before \r\n';
		const after = '\r\n after  \r\n';
		fake.updateIssue(number, { body: `${before}${block('{"meta":{"k":"v"}}')}${after}` });

		await t.backend.setAssignee!(String(number), 'w1');

		expect(bodyOf(number)).toBe(`${before}${block('{"meta":{"k":"v"},"claim":{"assignee":"w1"}}')}${after}`);

		await t.backend.clearAssignee!(String(number));

		expect(bodyOf(number)).toBe(`${before}${block('{"meta":{"k":"v"}}')}${after}`);
	});
});
