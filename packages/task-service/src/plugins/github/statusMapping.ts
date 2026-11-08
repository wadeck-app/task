// Task status <-> what GitHub holds (state, close reason, labels), read side. The map was checked against the project's statuses at
// load (githubOptions.checkOptionsAgainstProject), so a status always has exactly one representation; what can still go wrong is
// the DATA: an issue edited on GitHub into a state no status maps. That is an error naming the issue and the fix, never a guess.
import { BackendDataError } from '@wadeck-app/task-core';

import type { ProjectStatus } from '../kinds.js';
import { effectiveReason } from './githubOptions.js';
import type { CloseReason, StatusRule } from './githubOptions.js';

/** What decides the status of an issue. `labels` are names as GitHub holds them. */
export interface IssueState {
	number: number;
	state: 'open' | 'closed';
	stateReason: string | null;
	labels: readonly string[];
}

interface Entry {
	status: string;
	state: 'open' | 'closed';
	reason: CloseReason | undefined;
	label: string | undefined;
}

const REASON_WORDS: Record<string, string> = {
	completed: 'completed',
	not_planned: 'not planned',
	duplicate: 'a duplicate',
};

export class StatusMapper {
	private readonly entries: Entry[];
	/** The labels that mean a status, lower case. */
	readonly statusLabels: ReadonlySet<string>;

	/**
	 * @param issueUrl the page of an issue on GitHub, for the fix a message gives.
	 */
	constructor(
		statusMap: Readonly<Record<string, StatusRule>>,
		statuses: readonly ProjectStatus[],
		private readonly issueUrl: (number: number) => string
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
				reason: effectiveReason(rule, status.outcome),
				label: rule.label?.toLowerCase(),
			};
		});
		this.statusLabels = new Set(this.entries.flatMap(entry => (entry.label === undefined ? [] : [entry.label])));
	}

	isStatusLabel(name: string): boolean {
		return this.statusLabels.has(name.toLowerCase());
	}

	/** The status of an issue; throws BackendDataError when GitHub holds a state that no status (or several) maps. */
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
		const subject = `issue #${issue.number}`;
		const fail = (message: string, hint: string): { error: BackendDataError } => ({
			error: new BackendDataError('github', subject, message, hint),
		});

		const closed = issue.state === 'closed';
		const reason = closed ? (issue.stateReason ?? 'completed') : undefined;
		const candidates = this.entries.filter(
			entry => entry.state === issue.state && (!closed || entry.reason === reason)
		);
		if (candidates.length === 0) {
			const word = REASON_WORDS[reason ?? ''] ?? String(reason);
			return fail(
				`${subject} is closed as ${word}, and no status of the project maps that`,
				`Add a terminal status for it to the project config and to strategy.options.statusMap with { state: closed, reason: ${reason} }, or reopen ${this.issueUrl(issue.number)}`
			);
		}
		const labelled = candidates.filter(entry => entry.label !== undefined && held.has(entry.label));
		if (labelled.length > 1) {
			const names = issue.labels.filter(label => labelled.some(entry => entry.label === label.toLowerCase()));
			return fail(
				`${subject} carries two status labels (${names.join(', ')})`,
				`Remove one of them on ${this.issueUrl(issue.number)}; the task status is the one that stays`
			);
		}
		if (labelled.length === 1) return { status: labelled[0]!.status };
		const bare = candidates.filter(entry => entry.label === undefined);
		if (bare.length >= 1) return { status: bare[0]!.status };
		const needed = candidates.map(entry => entry.label!).join(', ');
		return fail(
			`${subject} is closed as ${REASON_WORDS[reason ?? ''] ?? String(reason)} but carries none of the labels that tell the statuses apart (${needed})`,
			`Add one of those labels on ${this.issueUrl(issue.number)}, or map one of the statuses without a label`
		);
	}
}
