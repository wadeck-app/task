// View models of priority, assignee and lease (the task page and the Tasks list). Presentation only: the rules (valid priorities,
// who may claim, what a lease is) are task-core's and task-service's; this file only words and flags what they hold.
import type { TaskRecord, TaskSummary } from '@wadeck-app/task-core';

import { shortUtcTime } from './display.js';

/** What the views need of the project config. */
export interface PriorityConfig {
	/** The valid priorities, highest first. */
	priorities: string[];
	defaults: { priority: string; leaseMinutes: number };
}

export type PriorityTone = 'danger' | 'warning' | 'neutral';

/**
 * The colour of a priority by its rank in the project's list (highest first): the first is `danger`, the second `warning`, every
 * other one `neutral`. A project with a single priority has no "most urgent" one: it stays `neutral`. The names do not matter, so a
 * project that calls them p0, p1... gets the same colours.
 */
export function priorityTone(config: PriorityConfig, priority: string): PriorityTone {
	if (config.priorities.length < 2) return 'neutral';
	const rank = config.priorities.indexOf(priority);
	if (rank === 0) return 'danger';
	return rank === 1 ? 'warning' : 'neutral';
}

/**
 * The options of the priority picker: "None" first (an empty value clears the priority, so the project default applies again),
 * then the project's priorities, highest first, each with its tone.
 */
export function priorityOptionRows(
	config: PriorityConfig
): Array<{ value: string; label: string; tone: PriorityTone }> {
	return [
		{ value: '', label: `None (default: ${config.defaults.priority})`, tone: 'neutral' },
		...config.priorities.map(priority => ({
			value: priority,
			label: priority,
			tone: priorityTone(config, priority),
		})),
	];
}

/** The priority a task has: the stored one, else the project default. */
export function effectivePriority(config: PriorityConfig, record: Pick<TaskSummary, 'priority'>): string {
	return record.priority ?? config.defaults.priority;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "less than a minute", "12 min", "3 h 5 min", "2 d 4 h": a span, rounded down to the minute. */
export function spanText(ms: number): string {
	const span = Math.max(ms, 0);
	if (span < MINUTE) return 'less than a minute';
	if (span < HOUR) return `${Math.floor(span / MINUTE)} min`;
	if (span < DAY) {
		const minutes = Math.floor((span % HOUR) / MINUTE);
		return minutes === 0 ? `${Math.floor(span / HOUR)} h` : `${Math.floor(span / HOUR)} h ${minutes} min`;
	}
	const hours = Math.floor((span % DAY) / HOUR);
	return hours === 0 ? `${Math.floor(span / DAY)} d` : `${Math.floor(span / DAY)} d ${hours} h`;
}

export interface LeaseView {
	/** Set only when a lease is stored: its end is at or before `now`. Absent when the stored end is not a date. */
	leaseExpired?: boolean;
	/** "held until 14:30 UTC, 12 min left" / "lease expired 3 min ago" / a sentence naming an unreadable end; absent without a lease. */
	leaseText?: string;
	/** Somebody holds the task and a worker would need `force` to take it: a live lease, or a lease that cannot be read (never over). */
	leaseLive: boolean;
}

/** The facts about the lease of a task, judged at `now`. */
export function leaseView(record: Pick<TaskSummary, 'assignee' | 'leaseUntil'>, now: Date): LeaseView {
	if (record.leaseUntil === undefined) return { leaseLive: false };
	const end = Date.parse(record.leaseUntil);
	if (Number.isNaN(end)) {
		return {
			leaseText: `the lease end "${record.leaseUntil}" is not a valid date: release the task with force to repair it`,
			// A lease that cannot be read is never over (the store and the list agree).
			leaseLive: record.assignee !== undefined,
		};
	}
	const expired = end <= now.getTime();
	if (expired) {
		return {
			leaseExpired: true,
			leaseText: `lease expired ${spanText(now.getTime() - end)} ago`,
			leaseLive: false,
		};
	}
	const iso = new Date(end).toISOString();
	// The date only when the lease ends on another UTC day than today.
	const sameDay = iso.slice(0, 10) === now.toISOString().slice(0, 10);
	const when = sameDay ? shortUtcTime(iso).slice(11) : shortUtcTime(iso);
	return {
		leaseExpired: false,
		leaseText: `held until ${when} UTC, ${spanText(end - now.getTime())} left`,
		leaseLive: record.assignee !== undefined,
	};
}

/**
 * The rows of the Tasks list with the texts of the Priority, Assignee and Lease columns: `priority` (effective, never absent),
 * `priorityText` (the same, "(default)" when it is the project default), `priorityIsDefault`, `assignee` ('' when nobody holds the
 * task) and `leaseText` ('' without a lease). A row of a list asked with a filter already carries `priority` and `leaseExpired`.
 */
export function withFieldTexts<T extends Pick<TaskSummary, 'priority' | 'assignee' | 'leaseUntil'>>(
	config: PriorityConfig,
	rows: T[],
	now: Date
): Array<
	T & { priority: string; priorityText: string; priorityIsDefault: boolean; assignee: string; leaseText: string }
> {
	return rows.map(row => {
		const priority = effectivePriority(config, row);
		const isDefault = row.priority === undefined;
		return {
			...row,
			priority,
			priorityText: isDefault ? `${priority} (default)` : priority,
			priorityIsDefault: isDefault,
			assignee: row.assignee ?? '',
			leaseText: leaseView(row, now).leaseText ?? '',
		};
	});
}

/** The lease lengths a claim form offers (minutes), the project default always among them. */
const LEASE_CHOICES = [15, 30, 60, 120, 240, 480, 1440];

function leaseChoiceLabel(minutes: number): string {
	if (minutes % 1440 === 0) return `${minutes / 1440} d`;
	if (minutes % 60 === 0) return `${minutes / 60} h`;
	return `${minutes} min`;
}

/** The select of the lease length: `value` is the number of minutes (as text: a select holds strings). */
export function leaseOptionRows(defaultMinutes: number): Array<{ value: string; label: string }> {
	const minutes = [...new Set([...LEASE_CHOICES, defaultMinutes])].sort((a, b) => a - b);
	return minutes.map(value => ({
		value: String(value),
		label: value === defaultMinutes ? `${leaseChoiceLabel(value)} (default)` : leaseChoiceLabel(value),
	}));
}

/**
 * What `GET /tasks/:id` says about priority, assignee and claim. `supports*` come from the capabilities of the project's storage: a
 * view hides the controls of a storage that cannot carry the field instead of offering a change that always fails.
 */
export function taskFieldFacts(
	config: PriorityConfig,
	record: TaskRecord,
	capabilities: { priority: boolean; assignee: boolean; claim: boolean },
	now: Date
): Record<string, unknown> {
	const priority = effectivePriority(config, record);
	const lease = leaseView(record, now);
	const assignee = record.assignee ?? '';
	return {
		priority,
		priorityIsDefault: record.priority === undefined,
		priorityTone: priorityTone(config, priority),
		priorityOptions: priorityOptionRows(config),
		supportsPriority: capabilities.priority,
		assignee,
		hasAssignee: assignee !== '',
		noAssignee: assignee === '',
		claimedAt: record.claimedAt ?? null,
		leaseUntil: record.leaseUntil ?? null,
		leaseExpired: lease.leaseExpired ?? null,
		leaseText: lease.leaseText ?? null,
		// The DSL has no negation: `leaseHeld` (a live lease) and `claimOpen` (free, no lease, or a lease that ran out) are exclusive.
		leaseHeld: lease.leaseLive,
		claimOpen: !lease.leaseLive,
		supportsClaim: capabilities.claim && capabilities.assignee,
		// The sentence of the take-over dialog: who holds the task, until when, and what taking it over does.
		takeOverText:
			assignee === ''
				? null
				: `"${assignee}" holds this task (${lease.leaseText ?? 'no lease'}). Taking it over gives it to the name below and ends that lease; "${assignee}" is not told.`,
		claimDefaultLeaseMinutes: config.defaults.leaseMinutes,
		leaseOptions: leaseOptionRows(config.defaults.leaseMinutes),
	};
}

/**
 * The bodies of the forms and dialogs of priority and claim (`forms.priority`, `forms.claim`, `forms.takeOver`, `forms.renew`,
 * `forms.release`): each carries the encoded project and is posted as is, like `forms.delete`.
 */
export function taskFieldForms(
	config: PriorityConfig,
	record: TaskRecord,
	projectParam: string
): Record<string, Record<string, unknown>> {
	// `id` fills the {id} of the action url: a Form takes its placeholders from its own data, not from the page.
	const base = { projectParam, id: record.id, assignee: '', leaseMinutes: String(config.defaults.leaseMinutes) };
	return {
		// The value of the picker: the STORED priority ('' = none, the default applies).
		priority: { projectParam, priority: record.priority ?? '' },
		// A free task, or one whose lease is over: a plain claim. `renew` costs nothing on a free task and lets a holder extend.
		claim: { ...base, renew: true, force: false },
		// Someone holds it: the dialog's own button sends `force`. The name is the person taking over, never the holder.
		takeOver: { ...base, renew: false, force: true },
		// The holder extends its own lease.
		renew: { ...base, assignee: record.assignee ?? '', renew: true, force: false },
		release: { projectParam, id: record.id },
	};
}
