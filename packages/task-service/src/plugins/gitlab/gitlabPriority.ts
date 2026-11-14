// The priority of an issue on GitLab: ALWAYS a label (GitLab Free has no native priority field), `<priorityPrefix><name>` or, for a
// priority named in `priorityMap`, that whole label name. Both spellings are reserved: such a label never shows among the labels of a
// task, and `add-label` / `remove-label` refuse it. Names are compared exactly (GitLab labels are case sensitive). Pure: no request.
import { BackendDataError } from '@wadeck-app/task-core';

import { priorityLabelName } from './gitlabOptions.js';
import type { GitLabSettings } from './gitlabOptions.js';

/** What the mapping needs to read and write a priority. */
export interface PriorityContext {
	prefix: string;
	/** Task priority -> the whole label name. */
	map: Readonly<Record<string, string>>;
	/** The priorities of the project, highest first; undefined = any priority is accepted (a hand-built context). */
	priorities: readonly string[] | undefined;
	/** The texts already reported as `ignored`, so a label read again by the next read is not said again. */
	reported: Set<string>;
}

export function createPriorityContext(
	settings: Pick<GitLabSettings, 'priorityPrefix' | 'priorityMap'>,
	priorities: readonly string[] | undefined
): PriorityContext {
	return { prefix: settings.priorityPrefix, map: settings.priorityMap, priorities, reported: new Set() };
}

/** The label that carries a task priority. */
export function labelOfPriority(priority: string, pc: PriorityContext): string {
	return priorityLabelName({ priorityPrefix: pc.prefix, priorityMap: pc.map }, priority);
}

/** True for a label that is reserved to carry a priority: the prefix, or a name `priorityMap` gives to a priority. */
export function isPriorityLabel(name: string, pc: PriorityContext): boolean {
	return name.startsWith(pc.prefix) || Object.values(pc.map).includes(name);
}

/** The valid priorities as a sentence, for messages. */
export function listPriorities(pc: PriorityContext): string {
	return pc.priorities === undefined ? 'any text' : pc.priorities.join(', ');
}

/**
 * The task priority a priority label stands for; undefined when the project has no such priority (the label is reserved all the
 * same). `isPriorityLabel(name)` must hold.
 */
export function priorityOfLabel(name: string, pc: PriorityContext): string | undefined {
	for (const [priority, mapped] of Object.entries(pc.map)) {
		if (mapped === name) return priority;
	}
	if (!name.startsWith(pc.prefix)) return undefined;
	const tail = name.slice(pc.prefix.length);
	if (pc.priorities === undefined) return tail === '' ? undefined : tail;
	return pc.priorities.includes(tail) && !Object.hasOwn(pc.map, tail) ? tail : undefined;
}

/** The names of the priority labels among `labels`. */
export function priorityLabelsOf(labels: readonly string[], pc: PriorityContext): string[] {
	return labels.filter(name => isPriorityLabel(name, pc));
}

/**
 * What an issue says about its priority: the task priority, or nothing. A label that is not a priority of the project reads as no
 * priority and is reported through `ignored` (the caller turns it into a read notice). Two priority labels are an error naming the
 * issue.
 */
export function readPriority(
	issue: { iid: number },
	labels: readonly string[],
	pc: PriorityContext,
	issueUrl: (iid: number) => string,
	ignored: (text: string) => void
): string | undefined {
	const held = priorityLabelsOf(labels, pc);
	if (held.length > 1) {
		throw new BackendDataError(
			'gitlab',
			`issue #${issue.iid}`,
			`issue #${issue.iid} carries two priority labels (${held.join(', ')})`,
			`Remove one of them on ${issueUrl(issue.iid)}`
		);
	}
	const label = held[0];
	if (label === undefined) return undefined;
	const priority = priorityOfLabel(label, pc);
	if (priority === undefined) {
		ignored(
			`issue #${issue.iid} has the label "${label}", which is not a priority of this project (${listPriorities(pc)}); it reads as no priority. Fix the label on ${issueUrl(issue.iid)}, or map it in strategy.options.priorityMap`
		);
	}
	return priority;
}
