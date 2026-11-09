// Task status <-> what GitLab holds (state and labels), read side. The map was checked against the project's statuses at load
// (gitlabOptions.checkOptionsAgainstProject), so a status always has exactly one representation; what can still go wrong is the
// DATA: an issue edited on GitLab into a combination no status maps. That is an error naming the issue and the fix, never a guess.
// GitLab has no close reason (unlike GitHub): two ways to end are told apart by a label.
import { BackendDataError } from '@wadeck-app/task-core';

import type { ProjectStatus } from '../kinds.js';
import type { StatusRule } from './gitlabOptions.js';

/** What decides the status of an issue. `labels` are names as GitLab holds them. */
export interface IssueState {
	iid: number;
	state: 'opened' | 'closed';
	labels: readonly string[];
}

interface Entry {
	status: string;
	state: 'open' | 'closed';
	/** Lower case, for comparisons (GitLab compares predefined names case-insensitively; a label title is matched the same way here). */
	label: string | undefined;
	/** As written in the config, for what is sent to GitLab. */
	labelName: string | undefined;
}

/** What GitLab must hold for a status. */
export interface StatusRepresentation {
	state: 'open' | 'closed';
	label: string | undefined;
}

export class StatusMapper {
	private readonly entries: Entry[];
	/** The labels that mean a status, lower case. */
	readonly statusLabels: ReadonlySet<string>;

	/** @param issueUrl the page of an issue on GitLab, for the fix a message gives. */
	constructor(
		statusMap: Readonly<Record<string, StatusRule>>,
		statuses: readonly ProjectStatus[],
		private readonly issueUrl: (iid: number) => string
	) {
		this.entries = statuses.map(status => {
			const rule = statusMap[status.name];
			if (rule === undefined) {
				throw new Error(
					`The status map has no entry for "${status.name}": it was not checked against the project`
				);
			}
			return {
				status: status.name,
				state: rule.state,
				label: rule.label?.toLowerCase(),
				labelName: rule.label,
			};
		});
		this.statusLabels = new Set(this.entries.flatMap(entry => (entry.label === undefined ? [] : [entry.label])));
	}

	/** What to write on GitLab to give an issue this status. Throws for a status the project does not have. */
	representation(status: string): StatusRepresentation {
		const entry = this.entries.find(candidate => candidate.status === status);
		if (entry === undefined) {
			throw new Error(
				`The status "${status}" is not mapped to GitLab (statuses of the project: ${this.entries.map(candidate => candidate.status).join(', ')})`
			);
		}
		return { state: entry.state, label: entry.labelName };
	}

	/** True when the status is one of the project's, mapped to GitLab. */
	knows(status: string): boolean {
		return this.entries.some(entry => entry.status === status);
	}

	isStatusLabel(name: string): boolean {
		return this.statusLabels.has(name.toLowerCase());
	}

	/** The status of an issue; throws BackendDataError when GitLab holds a combination that no status (or several) maps. */
	statusOf(issue: IssueState): string {
		const result = this.resolve(issue);
		if ('status' in result) return result.status;
		throw result.error;
	}

	/** Like {@link statusOf}, undefined instead of an error: for replaying the past of an issue, which passes through odd states. */
	tryStatusOf(issue: IssueState): string | undefined {
		const result = this.resolve(issue);
		return 'status' in result ? result.status : undefined;
	}

	private resolve(issue: IssueState): { status: string } | { error: BackendDataError } {
		const held = new Set(issue.labels.map(label => label.toLowerCase()));
		const subject = `issue #${issue.iid}`;
		const fail = (message: string, hint: string): { error: BackendDataError } => ({
			error: new BackendDataError('gitlab', subject, message, hint),
		});
		const state = issue.state === 'closed' ? 'closed' : 'open';
		const candidates = this.entries.filter(entry => entry.state === state);
		const labelled = candidates.filter(entry => entry.label !== undefined && held.has(entry.label));
		if (labelled.length > 1) {
			const names = issue.labels.filter(label => labelled.some(entry => entry.label === label.toLowerCase()));
			return fail(
				`${subject} carries two status labels (${names.join(', ')})`,
				`Remove one of them on ${this.issueUrl(issue.iid)}; the task status is the one that stays`
			);
		}
		if (labelled.length === 1) return { status: labelled[0]!.status };
		const bare = candidates.filter(entry => entry.label === undefined);
		if (bare.length >= 1) return { status: bare[0]!.status };
		if (candidates.length === 0) {
			return fail(
				`${subject} is ${issue.state}, and no status of the project maps that`,
				`Map a status to { state: ${state} } in strategy.options.statusMap, or change the issue on ${this.issueUrl(issue.iid)}`
			);
		}
		const needed = candidates.map(entry => entry.labelName!).join(', ');
		return fail(
			`${subject} is ${issue.state} but carries none of the labels that tell the statuses apart (${needed})`,
			`Add one of those labels on ${this.issueUrl(issue.iid)}, or map one of the ${state} statuses without a label`
		);
	}
}
