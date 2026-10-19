import type { DeletePlan, DeleteSelector } from './deleteTasks.js';
import { parseDeleteFilter } from './deleteTasks.js';

/** What the caller asked to delete, before it is checked: every selector the user may have given. */
export interface DeleteSelection {
	/** Task ids or prefixes. `undefined` = not given; `[]` = given but empty. */
	ids?: readonly string[];
	/** Delete every task. `false` counts as not given. */
	all?: boolean;
	/** `<field>=<glob>[,<glob>]` expression. */
	filter?: string;
}

/**
 * Why a {@link DeleteSelection} selects nothing usable:
 * - `none`: no selector was given.
 * - `all-and-filter`: `all` and `filter` both given.
 * - `ids-with-all-or-filter`: `ids` given together with `all` or `filter`.
 * - `empty-ids`: `ids` given but empty.
 */
export type DeleteSelectionProblem = 'none' | 'all-and-filter' | 'ids-with-all-or-filter' | 'empty-ids';

/**
 * Applies the one-selector rule of a delete request: exactly one of `ids`, `all`, `filter`.
 * A problem is returned (the wording belongs to the caller: flags for the CLI, JSON fields for HTTP);
 * a malformed `filter` throws {@link InvalidDeleteFilterError}.
 */
export function selectDeleteTargets(
	selection: DeleteSelection
): { selector: DeleteSelector } | { problem: DeleteSelectionProblem } {
	const { ids, filter } = selection;
	const all = selection.all === true;
	if (all && filter !== undefined) return { problem: 'all-and-filter' };
	if (ids !== undefined && (all || filter !== undefined)) return { problem: 'ids-with-all-or-filter' };
	if (all) return { selector: { kind: 'all' } };
	if (filter !== undefined) return { selector: parseDeleteFilter(filter) };
	if (ids === undefined) return { problem: 'none' };
	if (ids.length === 0) return { problem: 'empty-ids' };
	return { selector: { kind: 'ids', ids: [...ids] } };
}

/**
 * Sentences about the side effects of a deletion, shared by the preview (`would`) and the outcome (`did`).
 * Ids that matched no task are not part of it: how to warn about them depends on the caller.
 */
export function describeDeleteEffects(plan: DeletePlan, tense: 'would' | 'did'): string[] {
	const effects: string[] = [];
	if (plan.orphanCount > 0) {
		effects.push(
			tense === 'would'
				? `${plan.orphanCount} child task(s) would become root tasks (their parent is deleted).`
				: `${plan.orphanCount} child task(s) became root tasks (their parent was deleted).`
		);
	}
	if (plan.danglingLinkCount > 0) {
		effects.push(
			tense === 'would'
				? `${plan.danglingLinkCount} link(s) pointing to deleted tasks would be removed.`
				: `${plan.danglingLinkCount} link(s) pointing to deleted tasks were removed.`
		);
	}
	return effects;
}
