// DSL nodes built by the routes, for the places where a view has to repeat a block (a view cannot loop). The view renders the
// list with `ExtensionSlot` (`items: $sources.<key>.<list>`), which draws the nodes as is.
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

/** Name of the page action (`$actions`) the remove button of a link row runs. */
export const REMOVE_LINK_ROW_ACTION = 'removeLinkRow';

/**
 * One link group (relation label, count, the linked tasks) as a `task:TaskRowList`: the id and title are a link to the
 * linked task, and a button beside it removes the link without retyping relation and target (each row carries its
 * `removeParams`). A DataTable could not do both: a row action with a url leaves `{id}` unsubstituted in the installed
 * shell, and a table with row actions has no row click. The relation is the section title, so rows drop their `meta`.
 */
export function linkGroupSection(input: { label: string; rows: ReadonlyArray<Record<string, unknown>> }): DslNode {
	return {
		$type: 'Section',
		title: literal(`${input.label} (${input.rows.length})`),
		items: [
			{
				$type: 'task:TaskRowList',
				rows: input.rows.map(({ meta: _meta, ...row }: Record<string, unknown>) => row),
				appearance: 'table',
				density: 'compact',
				removeAction: REMOVE_LINK_ROW_ACTION,
				removeLabel: 'Remove link',
			},
		],
	};
}
