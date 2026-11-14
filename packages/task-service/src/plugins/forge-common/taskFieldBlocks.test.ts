import {
	InvalidTaskFieldError,
	TaskClaimedError,
	TaskNotClaimedError,
	TaskReleaseRefusedError,
} from '@wadeck-app/task-core';
import { describe, expect, it } from 'vitest';

import { planClaim, planClearAssignee, planRelease, planSetAssignee, withClaim } from './taskFieldBlocks.js';

const NOW = '2026-11-14T10:00:00.000Z';
const HALF = '2026-11-14T10:15:00.000Z';
const END = '2026-11-14T10:30:00.000Z';
const LATER = '2026-11-14T12:00:00.000Z';

describe('planSetAssignee / planClearAssignee', () => {
	it('gives a plain assignee with no lease, and drops the lease of another holder', () => {
		expect(planSetAssignee(undefined, ' w1 ')).toEqual({ claim: { assignee: 'w1' }, changed: true });
		expect(planSetAssignee({ assignee: 'w1', claimedAt: NOW, leaseUntil: END }, 'w2')).toEqual({
			claim: { assignee: 'w2' },
			changed: true,
		});
	});

	it('the same assignee changes nothing and keeps its lease', () => {
		const held = { assignee: 'w1', claimedAt: NOW, leaseUntil: END };
		expect(planSetAssignee(held, 'w1')).toEqual({ claim: held, changed: false });
	});

	it('refuses a blank or multi-line assignee', () => {
		expect(() => planSetAssignee(undefined, ' ')).toThrow(InvalidTaskFieldError);
		expect(() => planSetAssignee(undefined, 'a\nb')).toThrow(InvalidTaskFieldError);
	});

	it('clearing changes something only when someone held the issue', () => {
		expect(planClearAssignee({ assignee: 'w1' })).toEqual({ claim: undefined, changed: true });
		expect(planClearAssignee(undefined)).toEqual({ claim: undefined, changed: false });
	});
});

describe('planClaim', () => {
	it('a free issue is claimed with claimedAt = now', () => {
		expect(planClaim('7', undefined, { assignee: 'w1', leaseUntil: END, now: NOW })).toEqual({
			claim: { assignee: 'w1', claimedAt: NOW, leaseUntil: END },
			outcome: 'claimed',
		});
	});

	it('a live lease of someone else is TaskClaimedError; force and an expired lease are takeovers naming the holder', () => {
		const held = { assignee: 'w1', claimedAt: NOW, leaseUntil: END };
		expect(() => planClaim('7', held, { assignee: 'w2', leaseUntil: LATER, now: HALF })).toThrow(TaskClaimedError);
		const forced = planClaim('7', held, { assignee: 'w2', leaseUntil: LATER, now: HALF, force: true });
		expect(forced).toMatchObject({
			outcome: 'takeover',
			previousAssignee: 'w1',
			claim: { assignee: 'w2', claimedAt: HALF },
		});
		const expired = planClaim('7', held, { assignee: 'w2', leaseUntil: LATER, now: END });
		expect(expired).toMatchObject({ outcome: 'takeover', previousAssignee: 'w1' });
	});

	it('a bare assignee (no lease) is taken over without force', () => {
		expect(planClaim('7', { assignee: 'w1' }, { assignee: 'w2', leaseUntil: END, now: NOW })).toMatchObject({
			outcome: 'takeover',
			previousAssignee: 'w1',
		});
	});

	it('the holder renews with renew (claimedAt kept) and is refused without it on a live lease', () => {
		const held = { assignee: 'w1', claimedAt: NOW, leaseUntil: END };
		expect(() => planClaim('7', held, { assignee: 'w1', leaseUntil: LATER, now: HALF })).toThrow(TaskClaimedError);
		expect(planClaim('7', held, { assignee: 'w1', leaseUntil: LATER, now: HALF, renew: true })).toEqual({
			claim: { assignee: 'w1', claimedAt: NOW, leaseUntil: LATER },
			outcome: 'renewed',
		});
	});

	it('refuses a lease that does not end after now and a blank assignee before judging anything', () => {
		expect(() => planClaim('7', undefined, { assignee: 'w1', leaseUntil: NOW, now: NOW })).toThrow(
			InvalidTaskFieldError
		);
		expect(() => planClaim('7', undefined, { assignee: ' ', leaseUntil: END, now: NOW })).toThrow(
			InvalidTaskFieldError
		);
	});
});

describe('planRelease', () => {
	it('names the holder; nobody holding it, or another holder without force, is refused', () => {
		expect(planRelease('7', { assignee: 'w1' })).toEqual({ previousAssignee: 'w1' });
		expect(planRelease('7', { assignee: 'w1' }, { assignee: 'w1' })).toEqual({ previousAssignee: 'w1' });
		expect(planRelease('7', { assignee: 'w1' }, { assignee: 'w2', force: true })).toEqual({
			previousAssignee: 'w1',
		});
		expect(() => planRelease('7', undefined)).toThrow(TaskNotClaimedError);
		expect(() => planRelease('7', { assignee: 'w1' }, { assignee: 'w2' })).toThrow(TaskReleaseRefusedError);
	});
});

describe('withClaim', () => {
	it('sets or removes only the claim key', () => {
		expect(withClaim({ meta: { a: '1' } }, { assignee: 'w1' })).toEqual({
			meta: { a: '1' },
			claim: { assignee: 'w1' },
		});
		expect(withClaim({ meta: { a: '1' }, claim: { assignee: 'w1' } }, undefined)).toEqual({ meta: { a: '1' } });
		expect(withClaim(undefined, undefined)).toEqual({});
	});
});
