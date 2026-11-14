// The priority of an issue, read from where GitHub keeps it: a native organization issue field (single select) or a label. Pure: no
// request. Both are read from the issue as the list and the single read return it, so a list needs no request per issue.
//
// What is read follows where the priority lives (`PriorityContext.storage`, set by the resolver before the issues are mapped): in the
// field the value is read and no label is reserved; in labels (or while `auto` is not resolved) a label that carries a priority is
// reserved: it never shows among the labels of the task.
import { BackendDataError } from '@wadeck-app/task-core';

import { PriorityNames } from '../forge-common/priorityNames.js';
import type { PrioritySettings } from './githubOptions.js';

/** One value of an issue field, as the issue and the issue list carry it (`issue_field_values`), measured on 2026-11-14. */
export interface ApiFieldValue {
	issue_field_id: number;
	node_id?: string;
	data_type: string;
	issue_field_name: string;
	/** For a single select, the id of the chosen option. */
	value: unknown;
	single_select_option?: { id: number; name: string; color?: string } | null;
}

/** What the mapping needs to read and write a priority. */
export interface PriorityContext {
	settings: PrioritySettings;
	/** The priorities of the project, highest first; undefined = any priority is accepted (a hand-built context). */
	priorities: readonly string[] | undefined;
	/** Task priority <-> option name of the field (`priorityMap` applies). */
	fieldNames: PriorityNames;
	/** Task priority <-> the tail of a label after the prefix (`priorityMap` does not apply: a mapped label is a whole name). */
	labelTails: PriorityNames;
	/**
	 * Where the priority lives, as far as it is known: set from the explicit settings at the start and by the resolver (an earlier
	 * command's memory, or the answer of GitHub). `field`: the value of the issue field is read and no label is reserved; `label`: the
	 * value is not read, so a value somebody set in the field never hides the label the strategy writes, and the priority labels are
	 * reserved; undefined: `auto` not resolved yet, labels are reserved and nothing is read from the field.
	 */
	storage: 'field' | 'label' | undefined;
	/** The texts already reported as `ignored`, so a value read again by the next read is not said again. */
	reported: Set<string>;
}

/** The storage the explicit settings name; undefined for `auto` without a field id. */
export function explicitStorage(settings: PrioritySettings): 'field' | 'label' | undefined {
	if (settings.storage === 'label') return 'label';
	if (settings.storage === 'field' || settings.fieldId !== undefined) return 'field';
	return undefined;
}

export function createPriorityContext(
	settings: PrioritySettings,
	priorities: readonly string[] | undefined
): PriorityContext {
	return {
		settings,
		priorities,
		fieldNames: new PriorityNames(priorities, settings.map),
		labelTails: new PriorityNames(priorities),
		storage: explicitStorage(settings),
		reported: new Set(),
	};
}

const lower = (text: string): string => text.toLowerCase();

/** The valid priorities as a sentence, for messages. */
export function listPriorities(pc: PriorityContext): string {
	return pc.priorities === undefined ? 'any text' : pc.priorities.join(', ');
}

// ---- labels ----

/** The label that carries a task priority. */
export function labelOfPriority(priority: string, pc: PriorityContext): string {
	const { map, prefix } = pc.settings;
	return Object.hasOwn(map, priority) ? map[priority]! : `${prefix}${priority}`;
}

/** True for a label that is reserved to carry a priority: the prefix, or a name `priorityMap` gives to a priority. */
export function isPriorityLabel(name: string, pc: PriorityContext): boolean {
	if (pc.storage === 'field') return false;
	return nameCarriesPriority(name, pc.settings);
}

/** True for a name that WOULD be a priority label (the prefix or a mapped name), whatever the storage: the sign that a project uses labels. */
export function nameCarriesPriority(name: string, settings: PrioritySettings): boolean {
	return (
		lower(name).startsWith(lower(settings.prefix)) ||
		Object.values(settings.map).some(mapped => lower(mapped) === lower(name))
	);
}

/**
 * The task priority a priority label stands for; undefined when the project has no such priority (the label is reserved all the
 * same). `isPriorityLabel(name)` must hold.
 */
export function priorityOfLabel(name: string, pc: PriorityContext): string | undefined {
	for (const [priority, mapped] of Object.entries(pc.settings.map)) {
		if (lower(mapped) === lower(name)) return priority;
	}
	if (!lower(name).startsWith(lower(pc.settings.prefix))) return undefined;
	return pc.labelTails.taskPriority(name.slice(pc.settings.prefix.length));
}

// ---- the field ----

/** The value of the priority field on an issue: the name of the chosen option; undefined without one. */
export function fieldPriorityName(
	values: readonly ApiFieldValue[] | undefined,
	pc: PriorityContext
): string | undefined {
	if (pc.storage !== 'field') return undefined;
	const { fieldId, fieldName } = pc.settings;
	const found = values?.find(
		item =>
			(fieldId !== undefined && item.issue_field_id === fieldId) ||
			lower(item.issue_field_name) === lower(fieldName)
	);
	const option = found?.single_select_option?.name;
	return option === undefined || option === '' ? undefined : option;
}

// ---- the issue ----

/** What the reading of a priority needs of an issue (the list item and the single read have it). */
export interface PriorityIssue {
	number: number;
	labels: ReadonlyArray<{ name: string } | string>;
	issue_field_values?: ApiFieldValue[];
}

const nameOfLabel = (label: { name: string } | string): string => (typeof label === 'string' ? label : label.name);

/** The names of the priority labels on an issue. */
export function priorityLabelsOf(issue: PriorityIssue, pc: PriorityContext): string[] {
	return issue.labels.map(nameOfLabel).filter(name => isPriorityLabel(name, pc));
}

/**
 * What an issue says about its priority: the task priority, or nothing. A value or a label that is not a priority of the project
 * reads as no priority and is reported through `ignored` (the caller turns it into a read notice). Two priority labels are an error
 * naming the issue.
 */
export function readPriority(
	issue: PriorityIssue,
	pc: PriorityContext,
	issueUrl: (number: number) => string,
	ignored: (text: string) => void
): string | undefined {
	const option = fieldPriorityName(issue.issue_field_values, pc);
	if (option !== undefined) {
		const priority = pc.fieldNames.taskPriority(option);
		if (priority === undefined) {
			ignored(
				`issue #${issue.number} has the value "${option}" in the issue field ${pc.settings.fieldName}, which is not a priority of this project (${listPriorities(pc)}); it reads as no priority. Change it on ${issueUrl(issue.number)}, or map it in strategy.options.priorityMap`
			);
		}
		return priority;
	}
	const labels = priorityLabelsOf(issue, pc);
	if (labels.length > 1) {
		throw new BackendDataError(
			'github',
			`issue #${issue.number}`,
			`issue #${issue.number} carries two priority labels (${labels.join(', ')})`,
			`Remove one of them on ${issueUrl(issue.number)}`
		);
	}
	const label = labels[0];
	if (label === undefined) return undefined;
	const priority = priorityOfLabel(label, pc);
	if (priority === undefined) {
		ignored(
			`issue #${issue.number} has the label "${label}", which is not a priority of this project (${listPriorities(pc)}); it reads as no priority. Fix the label on ${issueUrl(issue.number)}, or map it in strategy.options.priorityMap`
		);
	}
	return priority;
}
