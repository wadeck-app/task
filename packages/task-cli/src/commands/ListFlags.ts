// The flags of `task list` and the way they read their values: parsing only, the rules (valid statuses, priorities, orders, limits)
// are task-service's. Shared with `task next`, which takes the same --status / --priority / --order / --fresh.
import { LIST_LIMIT_MAX } from '@wadeck-app/task-service';

/** A flag value that is missing, or starts with "-" (the next flag, not a value): said once, the same way for every flag. */
export function valueProblem(flag: string, value: string | undefined): string | undefined {
	if (value === undefined) return `${flag} requires a value`;
	if (value.startsWith('-'))
		return `${flag} requires a value, found ${JSON.stringify(value)} (a value cannot start with "-")`;
	return undefined;
}

/** A value flag typed twice is refused (the second value would silently win or be lost). */
export function repeatedProblem(flag: string, alreadyGiven: boolean): string | undefined {
	return alreadyGiven
		? `${flag} was given twice: give it once (several values go in one list, for example ${flag} a,b)`
		: undefined;
}

/** `a,b` to ['a', 'b']; a blank entry (`a,,b`, `,`) is a problem sentence, never dropped silently. */
export function parseCommaList(flag: string, value: string): string[] | string {
	const items = value.split(',').map(item => item.trim());
	if (items.some(item => item === '')) {
		return `${flag} ${JSON.stringify(value)} has an empty entry: give names separated by single commas, for example ${flag} a,b`;
	}
	return items;
}

/** The flags `task list` and `task next` share. */
export interface SelectionFlags {
	statuses?: string[];
	priorities?: string[];
	order?: string;
	fresh: boolean;
}

/** The list-only flags that select and cut. */
export interface ListFlags extends SelectionFlags {
	assignee?: string;
	unassigned: boolean;
	available: boolean;
	limit?: number;
}

/** The new flags of a list that were typed, in the order typed (for the conflict messages). */
export function dispatchFlagsUsed(flags: ListFlags): string[] {
	return [
		...(flags.statuses === undefined ? [] : ['--status']),
		...(flags.assignee === undefined ? [] : ['--assignee']),
		...(flags.unassigned ? ['--unassigned'] : []),
		...(flags.available ? ['--available'] : []),
		...(flags.priorities === undefined ? [] : ['--priority']),
		...(flags.order === undefined ? [] : ['--order']),
		...(flags.limit === undefined ? [] : ['--limit']),
		...(flags.fresh ? ['--fresh'] : []),
	];
}

/**
 * Reads one of the shared selection flags at `rest[index]`. Returns undefined when `rest[index]` is not one of them, `{ consumed }` (the
 * extra arguments taken) when it was applied to `flags`, or `{ problem }`.
 */
export function readSelectionFlag(
	rest: string[],
	index: number,
	flags: SelectionFlags
): { consumed: number } | { problem: string } | undefined {
	const arg = rest[index]!;
	if (arg === '--fresh') {
		flags.fresh = true;
		return { consumed: 0 };
	}
	if (arg !== '--status' && arg !== '--priority' && arg !== '--order') return undefined;
	const value = rest[index + 1];
	const problem = valueProblem(arg, value);
	if (problem !== undefined) return { problem };
	const repeated = repeatedProblem(
		arg,
		arg === '--order'
			? flags.order !== undefined
			: arg === '--status'
				? flags.statuses !== undefined
				: flags.priorities !== undefined
	);
	if (repeated !== undefined) return { problem: repeated };
	if (arg === '--order') {
		flags.order = value!;
		return { consumed: 1 };
	}
	const list = parseCommaList(arg, value!);
	if (typeof list === 'string') return { problem: list };
	if (arg === '--status') flags.statuses = list;
	else flags.priorities = list;
	return { consumed: 1 };
}

/** Reads one of the list-only flags (`--assignee`, `--unassigned`, `--available`, `--limit`) at `rest[index]`; same answer as {@link readSelectionFlag}. */
export function readListOnlyFlag(
	rest: string[],
	index: number,
	flags: ListFlags
): { consumed: number } | { problem: string } | undefined {
	const arg = rest[index]!;
	if (arg === '--unassigned') {
		flags.unassigned = true;
		return { consumed: 0 };
	}
	if (arg === '--available') {
		flags.available = true;
		return { consumed: 0 };
	}
	if (arg !== '--assignee' && arg !== '--limit') return undefined;
	const value = rest[index + 1];
	const problem = valueProblem(arg, value);
	if (problem !== undefined) return { problem };
	const repeated = repeatedProblem(
		arg,
		arg === '--assignee' ? flags.assignee !== undefined : flags.limit !== undefined
	);
	if (repeated !== undefined) return { problem: repeated };
	if (arg === '--assignee') {
		if (value!.trim() === '') return { problem: '--assignee requires a name, found a blank one' };
		flags.assignee = value!;
		return { consumed: 1 };
	}
	if (!/^\d+$/.test(value!) || Number(value) < 1 || Number(value) > LIST_LIMIT_MAX) {
		return { problem: `--limit ${JSON.stringify(value)} is not a whole number from 1 to ${LIST_LIMIT_MAX}` };
	}
	flags.limit = Number(value);
	return { consumed: 1 };
}
