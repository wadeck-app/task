// Assignee and claim on GitLab: kept in the managed block of the issue DESCRIPTION (no GitLab user is touched, no fill is declared). The
// decision is the one of the local store (decideClaim...), the write is ONE PUT of the description after the usual conditional re-read.
import {
	BackendDataError,
	BackendLimitError,
	BackendRejectedError,
	StaleRevisionError,
	TaskClaimedError,
	TaskNotClaimedError,
	TaskReleaseRefusedError,
} from '@wadeck-app/task-core';

import { FakeGitLab } from './fakeGitLab.testkit.js';
import { WRITE_STATUSES, makeGitLabBackend, writeStatusMap } from './gitlabBackend.testkit.js';
import type { TestBackend } from './gitlabBackend.testkit.js';

let fake: FakeGitLab;
let t: TestBackend;

const P = '/projects/42';
const NOW = '2026-11-14T10:00:00.000Z';
const HALF = '2026-11-14T10:15:00.000Z';
const END = '2026-11-14T10:30:00.000Z';

function make(extra: Partial<Parameters<typeof makeGitLabBackend>[1]> = {}): TestBackend {
	return makeGitLabBackend(fake, {
		statuses: WRITE_STATUSES,
		projectTypes: ['bug', 'feature'],
		...extra,
		options: { statusMap: writeStatusMap(), ...extra.options },
	});
}

beforeEach(async () => {
	fake = await FakeGitLab.start();
	t = make();
});

afterEach(async () => {
	await fake.stop();
});

const sent = (): string[] => fake.writes().map(request => `${request.method} ${request.path.replace(P, '')}`);
const descriptionOf = (iid: number): string => fake.issue(iid)!.description ?? '';
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
	it('writes the claim block with ONE PUT of the description; no GitLab assignee and no label is touched; the list carries the assignee', async () => {
		const iid = fake.seedIssue({ title: 'a', description: 'The details' });
		fake.requests.length = 0;

		const record = await t.backend.setAssignee!(String(iid), ' worker-1 ');

		expect(record.assignee).toBe('worker-1');
		expect(record.claimedAt).toBeUndefined();
		expect(record.leaseUntil).toBeUndefined();
		expect(record.description).toBe('The details');
		expect(descriptionOf(iid)).toBe(`The details\n\n${block('{"claim":{"assignee":"worker-1"}}')}`);
		expect(sent()).toEqual(['PUT /issues/1']);
		// Nothing but the description is sent: no assignee_id, no labels.
		expect(Object.keys(fake.writes()[0]!.body as object)).toEqual(['description']);
		expect(fake.issue(iid)!.labels).toEqual([]);
		const summary = (await t.backend.list())[0]!;
		expect(summary.assignee).toBe('worker-1');
		expect(summary.leaseUntil).toBeUndefined();
	});

	it('the same assignee writes nothing and keeps its lease; another one drops the lease', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		await t.backend.claim!(String(iid), { assignee: 'w1', leaseUntil: END, now: NOW });
		fake.requests.length = 0;

		const same = await t.backend.setAssignee!(String(iid), 'w1');
		expect(sent()).toEqual([]);
		expect(same.leaseUntil).toBe(END);

		const other = await t.backend.setAssignee!(String(iid), 'w2');
		expect(other).toMatchObject({ assignee: 'w2' });
		expect(other.leaseUntil).toBeUndefined();
		expect(other.claimedAt).toBeUndefined();
	});

	it('clear removes the claim and the block with it; clearing an issue nobody holds writes nothing', async () => {
		const iid = fake.seedIssue({ title: 'a', description: 'Text' });
		await t.backend.setAssignee!(String(iid), 'w1');

		const cleared = await t.backend.clearAssignee!(String(iid));

		expect(cleared.assignee).toBeUndefined();
		expect(descriptionOf(iid)).toBe('Text');
		fake.requests.length = 0;
		await t.backend.clearAssignee!(String(iid));
		expect(sent()).toEqual([]);
	});

	it('refuses a blank or multi-line assignee before any request', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		fake.requests.length = 0;

		await failure(() => t.backend.setAssignee!(String(iid), ' '));
		await failure(() => t.backend.setAssignee!(String(iid), 'a\nb'));

		expect(fake.requests).toEqual([]);
	});

	it('keeps the description, the metadata and the links of the block, and every other write keeps the claim', async () => {
		await fake.stop();
		fake = await FakeGitLab.start();
		t = make({
			fills: {
				meta: { use: 'body-block', fidelity: 'degrade' },
				'linkTypes.duplicateOf': { use: 'relate-block', fidelity: 'degrade' },
			},
		});
		const iid = fake.seedIssue({ title: 'a', description: 'Text' });
		const other = fake.seedIssue({ title: 'b' });
		await t.backend.setMeta(String(iid), 'owner', 'ann');
		await t.backend.addLink(String(iid), 'duplicateOf', String(other));

		await t.backend.setAssignee!(String(iid), 'w1');
		expect(descriptionOf(iid)).toContain('"claim":{"assignee":"w1"}');
		expect(descriptionOf(iid)).toContain('"meta":{"owner":"ann"}');
		expect(descriptionOf(iid)).toContain('"type":"duplicateOf"');

		await t.backend.setDescription(String(iid), 'New text');
		await t.backend.setMeta(String(iid), 'owner', 'bob');
		const record = await t.backend.get(String(iid));
		expect(record).toMatchObject({ assignee: 'w1', description: 'New text', meta: { owner: 'bob' } });
		expect(record.links).toEqual([{ type: 'duplicateOf', target: String(other) }]);
	});
});

describe('claim and release', () => {
	it('a free issue is claimed with ONE PUT: assignee, claimedAt and leaseUntil on the record and in the list', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		fake.requests.length = 0;

		const result = await t.backend.claim!(String(iid), { assignee: ' w1 ', leaseUntil: END, now: NOW });

		expect(result.outcome).toBe('claimed');
		expect(result.previousAssignee).toBeUndefined();
		expect(result.task).toMatchObject({ assignee: 'w1', claimedAt: NOW, leaseUntil: END });
		expect(sent()).toEqual(['PUT /issues/1']);
		expect(descriptionOf(iid)).toBe(
			block(`{"claim":{"assignee":"w1","claimedAt":"${NOW}","leaseUntil":"${END}"}}`)
		);
		expect((await t.backend.list())[0]).toMatchObject({ assignee: 'w1', leaseUntil: END });
	});

	it('a live lease of someone else is TaskClaimedError naming the holder and the time left; nothing is written', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		await t.backend.claim!(String(iid), { assignee: 'w1', leaseUntil: END, now: NOW });
		fake.requests.length = 0;

		const error = await failure(() =>
			t.backend.claim!(String(iid), { assignee: 'w2', leaseUntil: END, now: HALF })
		);

		expect(error).toBeInstanceOf(TaskClaimedError);
		expect(error.message).toContain('claimed by "w1"');
		expect(error.message).toContain('15m');
		expect(sent()).toEqual([]);
	});

	it('the holder renews with renew (claimedAt kept); force and an expired lease are takeovers naming the previous holder', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		await t.backend.claim!(String(iid), { assignee: 'w1', leaseUntil: END, now: NOW });

		const renewed = await t.backend.claim!(String(iid), {
			assignee: 'w1',
			leaseUntil: '2026-11-14T12:00:00.000Z',
			now: HALF,
			renew: true,
		});
		expect(renewed.outcome).toBe('renewed');
		expect(renewed.task).toMatchObject({ claimedAt: NOW, leaseUntil: '2026-11-14T12:00:00.000Z' });

		const forced = await t.backend.claim!(String(iid), {
			assignee: 'w2',
			leaseUntil: '2026-11-14T13:00:00.000Z',
			now: HALF,
			force: true,
		});
		expect(forced).toMatchObject({ outcome: 'takeover', previousAssignee: 'w1' });
		const late = await t.backend.claim!(String(iid), {
			assignee: 'w3',
			leaseUntil: '2026-11-14T15:00:00.000Z',
			now: '2026-11-14T13:00:00.000Z',
		});
		expect(late).toMatchObject({ outcome: 'takeover', previousAssignee: 'w2' });
	});

	it('an assignee without a lease is taken over by a claim (a hand-made assignment holds no lease)', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		await t.backend.setAssignee!(String(iid), 'someone');

		const result = await t.backend.claim!(String(iid), { assignee: 'w1', leaseUntil: END, now: NOW });

		expect(result).toMatchObject({ outcome: 'takeover', previousAssignee: 'someone' });
	});

	it('release clears the holder and the lease; nobody holding it, or another holder without force, is refused', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		expect(await failure(() => t.backend.release!(String(iid)))).toBeInstanceOf(TaskNotClaimedError);
		await t.backend.claim!(String(iid), { assignee: 'w1', leaseUntil: END, now: NOW });
		fake.requests.length = 0;
		const refused = await failure(() => t.backend.release!(String(iid), { assignee: 'w2' }));
		expect(refused.message).toContain('held by "w1", not by "w2"');
		expect(sent()).toEqual([]);

		const released = await t.backend.release!(String(iid), { assignee: 'w1' });

		expect(released.previousAssignee).toBe('w1');
		expect(released.task.assignee).toBeUndefined();
		expect(released.task.leaseUntil).toBeUndefined();
		expect(descriptionOf(iid)).toBe('');
		expect((await t.backend.list())[0]!.assignee).toBeUndefined();
	});

	it('a bad request (lease not after now, blank assignee) is refused before any request', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		fake.requests.length = 0;

		await failure(() => t.backend.claim!(String(iid), { assignee: 'w1', leaseUntil: NOW, now: NOW }));
		await failure(() => t.backend.claim!(String(iid), { assignee: ' ', leaseUntil: END, now: NOW }));

		expect(fake.requests).toEqual([]);
	});
});

describe('quick actions: the claim block never runs one', () => {
	// GitLab RUNS a description line that starts with a slash and a command word. The block is ONE line starting with `<!--`, JSON
	// never holds a raw newline, so whatever the assignee is called the line does not start with a slash.
	it.each(['a/b', '/close', '/label ~bug', '/assign @root', ' /unassign'])(
		'the assignee %j is written inside the block line: nothing is run, it reads back as written',
		async name => {
			const iid = fake.seedIssue({ title: 'a', description: 'Text' });

			const claimed = await t.backend.claim!(String(iid), { assignee: name, leaseUntil: END, now: NOW });

			expect(claimed.task.assignee).toBe(name.trim());
			expect(fake.quickActionsRun).toBe(0);
			expect(fake.issue(iid)!.state).toBe('opened');
			expect(fake.issue(iid)!.labels).toEqual([]);
			const lines = descriptionOf(iid).split('\n');
			expect(lines.filter(line => /^\s*\//.test(line))).toEqual([]);
			expect(lines.at(-1)!.startsWith('<!--')).toBe(true);
			const released = await t.backend.release!(String(iid), { assignee: name });
			expect(released.previousAssignee).toBe(name.trim());
			expect(fake.quickActionsRun).toBe(0);
		}
	);

	it.each(['\u2028', '\u2029', '\u0085'])(
		'an assignee with the line break %j followed by /close is refused BEFORE ANY request, with a message that says why',
		async separator => {
			const iid = fake.seedIssue({ title: 'a' });
			fake.requests.length = 0;

			const set = await failure(() => t.backend.setAssignee!(String(iid), `x${separator}/close`));
			const claim = await failure(() =>
				t.backend.claim!(String(iid), { assignee: `x${separator}/close`, leaseUntil: END, now: NOW })
			);

			for (const error of [set, claim]) {
				expect(error).toBeInstanceOf(BackendRejectedError);
				expect(error.message).toContain('quick action');
				expect((error as BackendRejectedError).hint).toContain('Nothing was sent');
			}
			expect(fake.requests).toEqual([]);
			expect(fake.quickActionsRun).toBe(0);
		}
	);

	it('a vertical tab or a form feed is a control character: refused before any request like a newline', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		fake.requests.length = 0;

		const error = await failure(() => t.backend.setAssignee!(String(iid), 'x\u000b/close'));

		expect(error.name).toBe('InvalidTaskFieldError');
		expect(fake.requests).toEqual([]);
	});

	it('a separator followed by something that is not a command (a path, a digit) is not refused', async () => {
		const iid = fake.seedIssue({ title: 'a' });

		const record = await t.backend.setAssignee!(String(iid), 'x\u2028/ 1');

		expect(record.assignee).toBe('x\u2028/ 1');
		expect(fake.quickActionsRun).toBe(0);
	});

	it('a visible description that holds a slash line (kept by GitLab inside a code fence) does not stop a claim: the text is not re-checked', async () => {
		const iid = fake.seedIssue({ title: 'a', description: 'Run:\n```\n/etc\n```' });
		// Seeded as a person edited it: GitLab keeps the fenced line.
		fake.editDescription(iid, 'Run:\n```\n/etc\n```');

		const claimed = await t.backend.claim!(String(iid), { assignee: 'w1', leaseUntil: END, now: NOW });

		expect(claimed.task.assignee).toBe('w1');
		expect(descriptionOf(iid)).toContain('```\n/etc\n```');
		// ... while the same line written as a NEW description is still refused.
		const error = await failure(() => t.backend.setDescription(String(iid), 'fine\n/close'));
		expect(error).toBeInstanceOf(BackendRejectedError);
		expect(fake.quickActionsRun).toBe(0);
	});
});

describe('the revision of a claim', () => {
	it('is compared on the claim part: another claim made meanwhile is stale, a description edited meanwhile is not', async () => {
		const iid = fake.seedIssue({ title: 'a', description: 'Text' });
		const read = await t.backend.get(String(iid));
		fake.editDescription(iid, 'Edited by a person');

		const ok = await t.backend.claim!(String(iid), {
			assignee: 'w1',
			leaseUntil: END,
			now: NOW,
			expectedRevision: read.revision,
		});
		expect(ok.task.assignee).toBe('w1');
		expect(descriptionOf(iid)).toContain('Edited by a person');

		const second = await t.backend.get(String(iid));
		fake.editDescription(iid, `Edited by a person\n\n${block('{"claim":{"assignee":"w9"}}')}`);
		const stale = await failure(() =>
			t.backend.setAssignee!(String(iid), 'w2', { expectedRevision: second.revision })
		);
		expect(stale).toBeInstanceOf(StaleRevisionError);
		expect(descriptionOf(iid)).toContain('w9');
	});

	it('a claim or a renewal does not make a description edit stale; another description edit does', async () => {
		const iid = fake.seedIssue({ title: 'a', description: 'Text' });
		const read = await t.backend.get(String(iid));
		await t.backend.claim!(String(iid), { assignee: 'w1', leaseUntil: END, now: NOW });

		await t.backend.claim!(String(iid), { assignee: 'w1', leaseUntil: END, now: HALF, renew: true });

		const edited = await t.backend.setDescription(String(iid), 'Other', { expectedRevision: read.revision });
		expect(edited.description).toBe('Other');
		expect(descriptionOf(iid)).toContain('"assignee":"w1"');

		// The same revision once somebody else changed the text first.
		const stale = await failure(() =>
			t.backend.setDescription(String(iid), 'Third', { expectedRevision: read.revision })
		);
		expect(stale).toBeInstanceOf(StaleRevisionError);
	});

	it('a claim does not make a title, a label or a priority write stale', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		const read = await t.backend.get(String(iid));
		await t.backend.claim!(String(iid), { assignee: 'w1', leaseUntil: END, now: NOW });

		await t.backend.setTitle(String(iid), 'b', { expectedRevision: read.revision });
		await t.backend.addLabel(String(iid), 'frontend', { expectedRevision: read.revision });
		await t.backend.setPriority!(String(iid), 'high', { expectedRevision: read.revision });

		expect(fake.issue(iid)!.title).toBe('b');
	});
});

describe('what a corrupt or oversized block does', () => {
	it('a block that cannot be read is an error naming the issue on a read and on a claim, and the list reads the issue as unheld with a notice', async () => {
		const iid = fake.seedIssue({ title: 'a', description: `Text\n\n${block('{"claim":[]}')}` });
		fake.seedIssue({ title: 'b' });
		fake.requests.length = 0;

		const read = await failure(() => t.backend.get(String(iid)));
		const claim = await failure(() => t.backend.claim!(String(iid), { assignee: 'w1', leaseUntil: END, now: NOW }));
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

	it('a description that would pass the GitLab limit is a limit error, nothing is sent', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		fake.editDescription(iid, 'x'.repeat(1_048_570));
		fake.requests.length = 0;

		const error = await failure(() => t.backend.setAssignee!(String(iid), 'w1'));

		expect(error).toBeInstanceOf(BackendLimitError);
		expect(sent()).toEqual([]);
	});
});

describe('two claims one after the other', () => {
	it('the second sees the first (check then write): the contract of a dispatcher is the loser retries the next task', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		const other = make();

		await t.backend.claim!(String(iid), { assignee: 'w1', leaseUntil: END, now: NOW });
		const lost = await failure(() =>
			other.backend.claim!(String(iid), { assignee: 'w2', leaseUntil: END, now: HALF })
		);

		expect(lost).toBeInstanceOf(TaskClaimedError);
	});
});

describe('a second worker writing between the re-read and the write', () => {
	// GitLab has no conditional write: the loser's PUT overwrites the winner's block. The read after the write shows who holds the
	// issue, and the caller that does not hold it is told so (TaskClaimedError naming the real holder), never "claimed".
	const rival = (iid: number, holder: string): (() => void) => {
		return () =>
			fake.editDescription(
				iid,
				block(`{"claim":{"assignee":"${holder}","claimedAt":"${NOW}","leaseUntil":"${END}"}}`)
			);
	};

	it('claim: the rival wrote last, so the caller gets TaskClaimedError naming the rival', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		// Ours is applied, then the rival's overwrites it before the read-back.
		fake.afterNextWrite(rival(iid, 'w2'));

		const error = await failure(() => t.backend.claim!(String(iid), { assignee: 'w1', leaseUntil: END, now: NOW }));

		expect(error).toBeInstanceOf(TaskClaimedError);
		expect((error as TaskClaimedError).holder).toBe('w2');
		expect(error.message).toContain('"w2"');
	});

	it('claim: the caller that wrote last holds the issue and gets claimed', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		fake.beforeNextWrite(rival(iid, 'w2'));

		const result = await t.backend.claim!(String(iid), { assignee: 'w1', leaseUntil: END, now: NOW });

		expect(result.outcome).toBe('claimed');
		expect(result.task).toMatchObject({ assignee: 'w1' });
	});

	it('release: a claim that appears after ours is a TaskConflictError describing the race and naming the new holder', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		await t.backend.claim!(String(iid), { assignee: 'w1', leaseUntil: END, now: NOW });
		fake.afterNextWrite(rival(iid, 'w2'));

		const error = await failure(() => t.backend.release!(String(iid), {}));

		expect(error.name).toBe('TaskConflictError');
		expect(error).not.toBeInstanceOf(TaskReleaseRefusedError);
		expect(error.message).toContain(`Task "${iid}" was claimed by "w2" while you were releasing it`);
	});

	it('setAssignee: the rival wrote last, so the caller is told who holds the issue', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		fake.afterNextWrite(rival(iid, 'w2'));

		const error = await failure(() => t.backend.setAssignee!(String(iid), 'w1'));

		expect(error).toBeInstanceOf(TaskClaimedError);
		expect((error as TaskClaimedError).holder).toBe('w2');
	});

	it('clearAssignee: an assignee that appeared after the clear is a TaskConflictError describing the race (no empty requester)', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		await t.backend.setAssignee!(String(iid), 'w1');
		fake.afterNextWrite(rival(iid, 'w2'));

		const error = await failure(() => t.backend.clearAssignee!(String(iid)));

		expect(error.name).toBe('TaskConflictError');
		expect(error).not.toBeInstanceOf(TaskClaimedError);
		expect(error.message).toContain(`Task "${iid}" was claimed by "w2" while you were releasing it`);
	});

	it('claim: a rival that erased the block after ours leaves nobody holding it, said as a conflict (never "claimed")', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		fake.afterNextWrite(() => fake.editDescription(iid, ''));

		const error = await failure(() => t.backend.claim!(String(iid), { assignee: 'w1', leaseUntil: END, now: NOW }));

		expect(error.name).toBe('TaskConflictError');
		expect(error.message).toContain('nobody holds it now');
	});
});

describe('the visible description is sent byte for byte', () => {
	// GitLab itself turns CRLF into LF and strips trailing blanks of whatever it receives (LIVE-VERIFIED, ledger), so what is checked
	// is the text SENT: outside the managed block it is exactly the text GitLab held, never trimmed or normalised by task.
	const TEXT = '  Lead\r\nline two  \r\n\r\n';
	const sentDescription = (index: number): string =>
		(fake.writes()[index]!.body as { description: string }).description;

	it('a claim appends the block after the raw text and a release takes it away again, leaving the text as it was', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		fake.editDescription(iid, TEXT);
		fake.requests.length = 0;

		await t.backend.claim!(String(iid), { assignee: 'w1', leaseUntil: END, now: NOW });
		await t.backend.release!(String(iid), {});

		const claimed = sentDescription(0);
		expect(claimed.startsWith(TEXT)).toBe(true);
		expect(claimed.slice(TEXT.length)).toBe(
			`\n\n${block(`{"claim":{"assignee":"w1","claimedAt":"${NOW}","leaseUntil":"${END}"}}`)}`
		);
		// The second request starts from what GitLab then held: its own clean-up (CRLF to LF) applied, nothing else changed.
		expect(sentDescription(1)).toBe(TEXT.replace(/\r\n/g, '\n'));
	});

	it('a block in the middle of the text is replaced in place: the bytes before and after it are untouched', async () => {
		const iid = fake.seedIssue({ title: 'a' });
		const before = '  before \r\n';
		const after = '\r\n after  \r\n';
		fake.editDescription(iid, `${before}${block('{"meta":{"k":"v"}}')}${after}`);
		fake.requests.length = 0;

		await t.backend.setAssignee!(String(iid), 'w1');
		await t.backend.clearAssignee!(String(iid));

		expect(sentDescription(0)).toBe(`${before}${block('{"meta":{"k":"v"},"claim":{"assignee":"w1"}}')}${after}`);
		// GitLab also stripped the trailing blanks of the whole text.
		expect(sentDescription(1)).toBe(
			`${before}${block('{"meta":{"k":"v"}}')}${after}`.replace(/\r\n/g, '\n').trimEnd()
		);
	});
});
