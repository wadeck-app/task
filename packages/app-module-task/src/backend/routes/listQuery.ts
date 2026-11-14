// The filters and the order of GET /tasks: `priority=a,b`, `assignee=<name>`, `unassigned=true`, `available=true`, `order=<name>`.
// Parsing only: every rule (valid priorities, which filters exclude each other, the orderings that exist) is task-service's
// `listTasks`, whose errors reach the caller as a 400 with their hint.
import type { ListTasksInput } from '@wadeck-app/task-service';

import { RequestError } from '../errors.js';
import { booleanFlag, optionalQueryValue } from '../request.js';
import type { RouteRequest } from '../request.js';

type ListQuery = Pick<ListTasksInput, 'priorities' | 'assignee' | 'unassigned' | 'available' | 'order'>;

const FLAG_HINT = 'Use ?unassigned=true or ?available=true (or leave the flag out).';

/** `a,b` as a list; an empty entry (`a,,b`) is refused, never skipped. */
function commaList(name: string, value: string): string[] {
	const entries = value.split(',').map(entry => entry.trim());
	if (entries.some(entry => entry === '')) {
		throw new RequestError(
			400,
			`${name} has an empty entry: "${value}"`,
			`Give a comma separated list such as ?${name}=a,b without empty entries.`
		);
	}
	return entries;
}

/**
 * The list query of the request. With `conflictsWith` (the all-projects list, which cannot be filtered: priorities and the rest
 * belong to one project's config) any of these parameters is a 400 naming it, never silently ignored.
 */
export function listQueryFromRequest(query: RouteRequest['query'], conflictsWith?: string): ListQuery {
	const priority = optionalQueryValue(query, 'priority');
	const assignee = optionalQueryValue(query, 'assignee');
	const order = optionalQueryValue(query, 'order');
	const unassigned = booleanFlag(query, 'unassigned', FLAG_HINT);
	const available = booleanFlag(query, 'available', FLAG_HINT);
	if (conflictsWith !== undefined) {
		const used = [
			['priority', priority !== undefined],
			['assignee', assignee !== undefined],
			['unassigned', unassigned],
			['available', available],
			['order', order !== undefined],
		].find(([, present]) => present);
		if (used !== undefined) {
			throw new RequestError(
				400,
				`${String(used[0])} and ${conflictsWith} cannot be combined`,
				`The filters and the order belong to one project: use ?project=<id|name|alias> instead of ?${conflictsWith}=true.`
			);
		}
	}
	return {
		...(priority === undefined ? {} : { priorities: commaList('priority', priority) }),
		...(assignee === undefined ? {} : { assignee }),
		...(unassigned ? { unassigned } : {}),
		...(available ? { available } : {}),
		...(order === undefined ? {} : { order }),
	};
}
