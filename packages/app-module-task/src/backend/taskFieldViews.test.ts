import { describe, expect, it } from 'vitest';

import {
	leaseOptionRows,
	leaseView,
	priorityOptionRows,
	priorityTone,
	spanText,
	withFieldTexts,
} from './taskFieldViews.js';

const NOW = new Date('2026-11-14T14:18:00.000Z');
const config = {
	priorities: ['urgent', 'high', 'medium', 'low'],
	defaults: { priority: 'medium', leaseMinutes: 30 },
};

describe('priorityTone', () => {
	it('the first priority is danger, the second warning, the others neutral, by rank and not by name', () => {
		expect(config.priorities.map(p => priorityTone(config, p))).toEqual([
			'danger',
			'warning',
			'neutral',
			'neutral',
		]);
		const renamed = { ...config, priorities: ['p0', 'p1', 'p2'] };
		expect(renamed.priorities.map(p => priorityTone(renamed, p))).toEqual(['danger', 'warning', 'neutral']);
	});

	it('a project with one priority has no most urgent one; a value outside the list is neutral', () => {
		expect(priorityTone({ ...config, priorities: ['only'] }, 'only')).toBe('neutral');
		expect(priorityTone(config, 'gone')).toBe('neutral');
	});

	it('the options start with None (empty value, names the default) and keep the config order', () => {
		expect(priorityOptionRows(config).map(o => o.value)).toEqual(['', 'urgent', 'high', 'medium', 'low']);
		expect(priorityOptionRows(config)[0]!.label).toBe('None (default: medium)');
	});
});

describe('spanText', () => {
	it.each([
		[0, 'less than a minute'],
		[-5000, 'less than a minute'],
		[59_999, 'less than a minute'],
		[60_000, '1 min'],
		[12 * 60_000 + 30_000, '12 min'],
		[60 * 60_000, '1 h'],
		[(3 * 60 + 5) * 60_000, '3 h 5 min'],
		[24 * 3_600_000, '1 d'],
		[(2 * 24 + 4) * 3_600_000, '2 d 4 h'],
	])('%d ms reads %s', (ms, text) => expect(spanText(ms)).toBe(text));
});

describe('leaseView', () => {
	it('no lease: nothing to say, not held', () => {
		expect(leaseView({ assignee: 'w1' }, NOW)).toEqual({ leaseLive: false });
		expect(leaseView({}, NOW)).toEqual({ leaseLive: false });
	});

	it('a live lease says until when (UTC, the time only on the same day) and how long is left', () => {
		expect(leaseView({ assignee: 'w1', leaseUntil: '2026-11-14T14:30:00.000Z' }, NOW)).toEqual({
			leaseExpired: false,
			leaseText: 'held until 14:30 UTC, 12 min left',
			leaseLive: true,
		});
	});

	it('a lease ending another UTC day says the date', () => {
		expect(leaseView({ assignee: 'w1', leaseUntil: '2026-11-15T09:00:00.000Z' }, NOW).leaseText).toBe(
			'held until 2026-11-15 09:00 UTC, 18 h 42 min left'
		);
	});

	it('an expired lease says how long ago and is not held (a plain claim takes it)', () => {
		expect(leaseView({ assignee: 'w1', leaseUntil: '2026-11-14T14:15:00.000Z' }, NOW)).toEqual({
			leaseExpired: true,
			leaseText: 'lease expired 3 min ago',
			leaseLive: false,
		});
		// The end instant itself is over, like the list and the store.
		expect(leaseView({ assignee: 'w1', leaseUntil: NOW.toISOString() }, NOW).leaseExpired).toBe(true);
	});

	it('a lease that is not a date is reported, never judged over: it stays held and has no leaseExpired', () => {
		const view = leaseView({ assignee: 'w1', leaseUntil: 'tomorrow' }, NOW);
		expect(view.leaseLive).toBe(true);
		expect(view).not.toHaveProperty('leaseExpired');
		expect(view.leaseText).toContain('"tomorrow" is not a valid date');
	});
});

describe('leaseOptionRows', () => {
	it('lists the usual lengths, the project default marked and always present', () => {
		const labels = leaseOptionRows(30).map(o => o.label);
		expect(labels).toEqual(['15 min', '30 min (default)', '1 h', '2 h', '4 h', '8 h', '1 d']);
		expect(leaseOptionRows(45).map(o => o.value)).toEqual(['15', '30', '45', '60', '120', '240', '480', '1440']);
		expect(leaseOptionRows(45).find(o => o.value === '45')!.label).toBe('45 min (default)');
	});
});

describe('withFieldTexts', () => {
	it('gives every row the effective priority, assignee text and lease text', () => {
		const rows = withFieldTexts(
			config,
			[
				{ id: 'a' },
				{ id: 'b', priority: 'high', assignee: 'w1', leaseUntil: '2026-11-14T14:30:00.000Z' },
			] as never[],
			NOW
		);
		expect(rows[0]).toMatchObject({
			priority: 'medium',
			priorityText: 'medium (default)',
			assignee: '',
			leaseText: '',
		});
		expect(rows[1]).toMatchObject({
			priority: 'high',
			priorityText: 'high',
			priorityIsDefault: false,
			assignee: 'w1',
			leaseText: 'held until 14:30 UTC, 12 min left',
		});
	});
});
