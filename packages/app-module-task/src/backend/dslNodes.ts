// DSL nodes built by the routes, for the places where a view has to repeat a block once per project (a view cannot
// loop). The view renders the list with `ExtensionSlot` (`items: $sources.<key>.<list>`), which draws the nodes as is.
//
// Only the types below are used: they are registered by every shell version that renders this module, and a node of
// another type would show "Unknown component type" in the page instead of failing here.

/** A DSL node as the renderer reads it. */
export interface DslNode {
	$type: string;
	[prop: string]: unknown;
}

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

/**
 * Text for a string prop of a node. The renderer reads a string starting with "$" as an expression on the page context
 * (`$ctx.x`, `$sources.y`), so a project named "$ctx.x" would show something else than its name: a zero-width space in
 * front makes it plain text. Rows inside a table are data, not props, and need no such care.
 */
export function literal(text: string): string {
	return text.startsWith('$') ? `${ZERO_WIDTH_SPACE}${text}` : text;
}

/**
 * Columns of the task table of a project section. `mono` and `nowrap` are honoured by newer shells only (the installed
 * one rebuilds YAML columns from `key` and `label`); they are harmless before.
 */
const TASK_COLUMNS = [
	{ key: 'label', label: 'Task' },
	{ key: 'id', label: 'ID', mono: true, nowrap: true, width: 32 },
	{ key: 'status', label: 'Status', nowrap: true, width: 32 },
] as const;

/** A titled block for one project: a link to the page of that project, then its table (a row click opens the task). */
export function projectTasksSection(input: {
	title: string;
	linkLabel: string;
	linkTo: string;
	rows: readonly object[];
	emptyMessage: string;
}): DslNode {
	return {
		$type: 'Section',
		title: literal(input.title),
		items: [
			{ $type: 'ButtonLink', label: literal(input.linkLabel), to: input.linkTo, size: 'sm' },
			{
				$type: 'DataTable',
				rows: input.rows,
				emptyMessage: input.emptyMessage,
				navigateTo: '{href}',
				columns: TASK_COLUMNS,
			},
		],
	};
}
