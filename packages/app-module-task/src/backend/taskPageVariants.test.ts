import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEWS_DIR, generateTaskPage, taskPageFile } from '../../../../scripts/generate-task-page.mjs';

/*
 * The task page is an experiment: task-page.yaml is GENERATED from src/dsl-views/variants/* and holds one
 * AbTest with the current page and ten design variants. These tests are the contract every variant keeps,
 * for EVERY combination of its options, so that no design silently drops a feature of the page. See variants/_page.yaml.
 */

type Node = Record<string, unknown>;
const packageDir = join(import.meta.dirname, '../..');
const viewsDir = join(packageDir, 'src/dsl-views');

const parse = (text: string): Node => yaml.load(text) as Node;
const page = parse(readFileSync(taskPageFile(), 'utf8'));
const head = parse(readFileSync(join(import.meta.dirname, '__fixtures__/task-page.head.yaml'), 'utf8'));

const isNode = (value: unknown): value is Node => value !== null && typeof value === 'object' && !Array.isArray(value);
const sections = page.sections as Node[];
// The experiment sits in task:WidthFrame (the width dimension), the last section of the PageContent.
const frame = sections[sections.length - 1] as Node;
const switcher = (frame.items as Node[])[0] as Node;
interface Fragment {
	label: string;
	hint: string;
	view: unknown;
}
const variants = switcher.variants as Record<string, Fragment>;
const variantNames = Object.keys(variants);

// The dimensions shared by every design (see variants/_page.yaml). They appear in every design, some of them in several places,
// so their combinations are pinned instead of multiplied: see `pins` below.
const DIMENSIONS = ['task-title', 'task-header', 'task-controls'];

// Every combination of the options of a node: a nested switcher is replaced by the view of each of its choices. A switcher
// of a shared dimension is replaced by ONE choice: the one in `pins`, else its initial one.
function alternatives(value: unknown, pins: Record<string, string> = {}): unknown[] {
	if (Array.isArray(value)) {
		return value.reduce<unknown[][]>(
			(acc, item) => acc.flatMap(prefix => alternatives(item, pins).map(alt => [...prefix, alt])),
			[[]]
		);
	}
	if (!isNode(value)) {
		return [value];
	}
	if (value.$type === 'AbTest') {
		const choices = value.variants as Record<string, Fragment>;
		if (DIMENSIONS.includes(String(value.id))) {
			const chosen = pins[String(value.id)] ?? String(value.initial);
			return alternatives(choices[chosen]!.view, pins);
		}
		return Object.values(choices).flatMap(choice => alternatives(choice.view, pins));
	}
	return Object.entries(value).reduce<Node[]>(
		(acc, [key, item]) => acc.flatMap(prefix => alternatives(item, pins).map(alt => ({ ...prefix, [key]: alt }))),
		[{}]
	);
}

function walk(value: unknown, visit: (node: Node, ancestors: Node[]) => void, ancestors: Node[] = []): void {
	if (Array.isArray(value)) {
		value.forEach(item => walk(item, visit, ancestors));
	} else if (isNode(value)) {
		visit(value, ancestors);
		Object.values(value).forEach(item => walk(item, visit, [...ancestors, value]));
	}
}

const nodesOf = (tree: unknown): Node[] => {
	const found: Node[] = [];
	walk(tree, node => found.push(node));
	return found;
};
const stringsOf = (tree: unknown): string[] => {
	const found: string[] = [];
	const collect = (value: unknown): void => {
		if (typeof value === 'string') found.push(value);
		else if (Array.isArray(value)) value.forEach(collect);
		else if (isNode(value)) Object.values(value).forEach(collect);
	};
	collect(tree);
	return found;
};

/** Every option of every shared dimension, read from the first variant that declares it (the declarations are checked identical). */
const dimensionChoices = (() => {
	const found: Record<string, string[]> = {};
	for (const name of variantNames) {
		walk(variants[name]!.view, node => {
			if (node.$type === 'AbTest' && DIMENSIONS.includes(String(node.id)) && !found[String(node.id)]) {
				found[String(node.id)] = Object.keys(node.variants as object);
			}
		});
	}
	return found;
})();
const dimensionInitial: Record<string, string> = {};
walk(page, node => {
	if (node.$type === 'AbTest' && DIMENSIONS.includes(String(node.id)))
		dimensionInitial[String(node.id)] = String(node.initial);
});
/**
 * The pinned choices tried per design: every non-default option of every dimension alone, then all dimensions on their last and on
 * their second option. Each is combined with the design's FIRST own combination only (own options x dimensions would
 * multiply: the product is checked by parts, which is as strong because the dimensions touch other nodes than the options do).
 */
const pinSets: Array<{ label: string; pins: Record<string, string> }> = [
	...DIMENSIONS.flatMap(dim =>
		(dimensionChoices[dim] ?? [])
			.filter(c => c !== dimensionInitial[dim])
			.map(c => ({ label: `${dim}=${c}`, pins: { [dim]: c } }))
	),
	{ label: 'all-last', pins: Object.fromEntries(DIMENSIONS.map(d => [d, dimensionChoices[d]!.at(-1)!])) },
	{ label: 'all-second', pins: Object.fromEntries(DIMENSIONS.map(d => [d, dimensionChoices[d]![1]!])) },
];

/** Variant -> every resolved combination of its own options, the dimensions on their default. */
const baseCombinations: Array<{ name: string; index: number; tree: unknown }> = variantNames.flatMap(name =>
	alternatives(variants[name]!.view).map((tree, index) => ({ name, index, tree }))
);
/** Variant -> its first combination with the dimensions pinned (see `pinSets`). */
const dimensionCombinations = variantNames.flatMap(name =>
	pinSets.map(({ label, pins }) => ({
		name,
		index: label as unknown as number,
		tree: alternatives(variants[name]!.view, pins)[0],
	}))
);
const combinations: Array<{ name: string; index: number | string; tree: unknown }> = [
	...baseCombinations,
	...dimensionCombinations,
];
// A variant whose hint is still the placeholder 'TODO' has not been written yet: it is listed (skipped, visible in the run)
// instead of failing, and the contract applies the moment its hint is real.
const PENDING = variantNames.filter(n => variants[n]!.hint === 'TODO');
const written = combinations.filter(c => !PENDING.includes(c.name));
const each = written.map(c => [`${c.name}#${c.index}`, c.tree] as const);

describe('variants not written yet (placeholder hint "TODO")', () => {
	it.skipIf(PENDING.length === 0)(`are pending: ${PENDING.join(', ')}`, () => {
		/* The contract below runs for a variant as soon as its hint is not 'TODO'. */
	});
});

describe('the generated task-page.yaml', () => {
	it('is what the generator produces now (run "npm run views --workspace=packages/app-module-task" if not)', () => {
		expect(readFileSync(taskPageFile(), 'utf8').replace(/\r\n/g, '\n')).toBe(generateTaskPage());
	});

	it('has no YAML anchors or aliases (the compiler would have to expand them)', () => {
		expect(readFileSync(taskPageFile(), 'utf8')).not.toMatch(/(^|\s)[&*][A-Za-z0-9_-]+(\s|$)/m);
	});
});

describe('the experiment', () => {
	it('is ONE AbTest at the page root, inside the width frame, initial is "current", in the agreed order', () => {
		expect(sections.filter(s => s.$type === 'AbTest')).toHaveLength(0);
		expect(frame.$type).toBe('task:WidthFrame');
		expect(frame.items).toEqual([switcher]);
		// The frame owns the width: the PageContent must not cap it at its own 72rem centred column.
		expect(page.maxWidth).toBe('full');
		expect(switcher.$type).toBe('AbTest');
		expect(switcher.id).toBe('task-design');
		expect(switcher.initial).toBe('current');
		expect(variantNames).toEqual([
			'current',
			'github-a',
			'github-b',
			'gitlab-a',
			'gitlab-b',
			'jira-a',
			'jira-b',
			'linear-a',
			'linear-b',
			'notion-a',
			'notion-b',
		]);
	});

	it('names every variant and option with a label and a hint', () => {
		for (const name of variantNames) {
			expect(variants[name]!.label, `${name} label`).toMatch(/\S/);
			expect(variants[name]!.hint, `${name} hint`).toMatch(/\S/);
		}
		walk(page, node => {
			if (node.$type !== 'AbTest') return;
			for (const [key, choice] of Object.entries(node.variants as Record<string, Fragment>)) {
				expect(choice.label, `${String(node.id)}/${key} label`).toMatch(/\S/);
				expect(choice.hint, `${String(node.id)}/${key} hint`).toMatch(/\S/);
			}
			expect(Object.keys(node.variants as object), `${String(node.id)} initial`).toContain(node.initial);
			expect(node.label, `${String(node.id)} label`).toMatch(/\S/);
		});
	});

	it('nests at most 3 options per variant, each with 2 or 3 choices, ids unique and prefixed with the variant', () => {
		const ids = new Set<string>(['task-design', ...DIMENSIONS, 'task-width']);
		for (const name of variantNames) {
			// The same option may appear in several places of a variant (e.g. in both layouts of a sidebar option) as long as the
			// declaration is identical: the switcher shows one row for it. A different declaration under one id is a bug.
			const byId = new Map<string, Node>();
			walk(variants[name]!.view, node => {
				if (node.$type !== 'AbTest' || DIMENSIONS.includes(String(node.id))) return;
				const known = byId.get(String(node.id));
				if (known)
					expect(JSON.stringify(node), `option ${String(node.id)} declared twice differently`).toBe(
						JSON.stringify(known)
					);
				byId.set(String(node.id), node);
			});
			const options = [...byId.values()];
			expect(options.length, `${name} options`).toBeLessThanOrEqual(3);
			for (const option of options) {
				const id = String(option.id);
				expect(id.startsWith(`${name}-`), `${id} must start with ${name}-`).toBe(true);
				expect(id, `${id} charset`).toMatch(/^[A-Za-z0-9_-]+$/);
				expect(ids.has(id), `duplicate id ${id}`).toBe(false);
				ids.add(id);
				const choices = Object.keys(option.variants as object).length;
				expect(choices, `${id} choices`).toBeGreaterThanOrEqual(2);
				expect(choices, `${id} choices`).toBeLessThanOrEqual(3);
			}
		}
		expect(baseCombinations.filter(c => c.name === 'current')).toHaveLength(1);
		for (const name of variantNames) {
			expect(baseCombinations.filter(c => c.name === name).length, `${name} combinations`).toBeLessThanOrEqual(
				27
			);
		}
	});

	// The extension point task:project-header sits OUTSIDE the switcher too: every variant has it by construction.
	it('has the slot task:project-header outside the switcher, once, whatever the variant', () => {
		const slots = nodesOf(sections.slice(0, -1)).filter(n => n.$type === 'ExtensionSlot');
		expect(slots).toEqual([
			{ $type: 'ExtensionSlot', $if: '$sources.projectHeader', items: '$sources.projectHeader' },
		]);
		expect(sections[0]).toMatchObject({ $type: 'task:ChipRow', $if: '$route.project' });
		expect(page.$sources).toHaveProperty('projectHeader.url', 'GET /api/slots/task:project-header');
		// No variant draws a slot of its own (the one above would be doubled).
		for (const { name, tree } of combinations) {
			expect(
				nodesOf(tree).filter(n => n.$type === 'ExtensionSlot' && n.items === '$sources.projectHeader'),
				name
			).toEqual([]);
		}
	});

	it('keeps the notices OUTSIDE the switcher, so every variant has the same error and empty states', () => {
		const notices = sections.slice(1, -1);
		const labels = notices.map(s => `${String(s.$type)}:${String(s.label)}`);
		expect(labels).toEqual([
			'Badge:$sources.projects.noProjectsText',
			'Badge:$sources.projects.selectedProblem',
			'Badge:$sources.projects.unknownProjectText',
			'Badge:$sources.detail.errorText',
			'Badge:$sources.detail.warningText',
		]);
		expect(notices.map(s => s.$if)).toEqual([
			'$sources.projects.noProjects',
			'$sources.projects.selectedProblem',
			'$sources.projects.unknownProjectText',
			'$sources.detail.errorText',
			'$sources.detail.warningText',
		]);
	});
});

// With no task (unknown project, unreadable project, virtual project, task not found) the notices above the switcher say
// why; a variant must not also draw its empty frames ("Created: undefined", empty property panels).
describe('states without a task', () => {
	it.each(variantNames.filter(name => name !== 'current'))('%s draws nothing until the task is loaded', name => {
		const view = variants[name]!.view as Node;
		expect(view.$if, `${name}: the root of the variant needs $if: $sources.detail.task`).toBe(
			'$sources.detail.task'
		);
	});
});

// The four dimensions every design shares (title, header, controls here; the width is task:WidthFrame). Each is a row of the
// same switcher in every design, with the option of today kept next to the proposals.
describe('the shared dimensions', () => {
	const declared = (id: string): Array<{ design: string; node: Node }> =>
		variantNames.flatMap(design => {
			const found: Node[] = [];
			walk(variants[design]!.view, node => {
				if (node.$type === 'AbTest' && node.id === id) found.push(node);
			});
			return found.map(node => ({ design, node }));
		});
	const choicesOf = (node: Node): Record<string, Fragment> => node.variants as Record<string, Fragment>;
	// What the dock shows of a row: the same in every design, or one design would silently have another row under the same id.
	const rowOf = (node: Node): unknown => ({
		label: node.label,
		initial: node.initial,
		choices: Object.entries(choicesOf(node)).map(([key, c]) => [key, c.label, c.hint]),
	});

	it.each(DIMENSIONS)('%s is in every design, and `current`, with one and the same row', id => {
		for (const design of variantNames) {
			expect(
				declared(id).filter(d => d.design === design),
				`${design} has no ${id}`
			).not.toEqual([]);
		}
		const [first, ...rest] = declared(id);
		for (const other of rest) expect(rowOf(other.node), `${id} in ${other.design}`).toEqual(rowOf(first!.node));
	});

	it.each([
		['task-title', 'clamp2', 'large', 4],
		['task-header', 'bar', 'beside', 3],
		['task-controls', 'inline', 'form', 3],
	])('%s: a compact default, the option of today kept, %i options', (id, initial, today, count) => {
		const node = declared(id)[0]!.node;
		expect(node.initial).toBe(initial);
		expect(Object.keys(choicesOf(node))).toContain(today);
		expect(Object.keys(choicesOf(node)).length).toBe(count);
		expect(node.initial, 'the default is a proposal, not the old behaviour').not.toBe(today);
	});

	it('task-title: no option prints a title bigger than text-2xl, and only the one of today shows the whole text unclamped', () => {
		const title = choicesOf(declared('task-title')[0]!.node);
		const texts = (choice: string): Node[] =>
			nodesOf(title[choice]!.view).filter(n => n.$type === 'task:TitleText');
		for (const [key, choice] of Object.entries(title)) {
			for (const t of nodesOf(choice.view).filter(n => n.$type === 'task:TitleText')) {
				expect(['sm', 'lg', 'xl', '2xl'], `${key}: size ${String(t.size)}`).toContain(t.size);
			}
		}
		expect(texts('clamp2')[0]).toMatchObject({
			text: '$sources.detail.task.title',
			size: 'xl',
			lines: 2,
			expandable: true,
		});
		expect(texts('oneline')[0]).toMatchObject({ lines: 1, tooltip: true });
		expect(texts('large')[0]).toMatchObject({ text: '$sources.detail.task.title', size: '2xl', lines: 0 });
		// short: the headline from the route, the whole title one fold away.
		expect(texts('short')[0]).toMatchObject({ text: '$sources.detail.titleShort' });
		const panel = nodesOf(title.short!.view).find(n => n.$type === 'task:Panel')!;
		expect(panel).toMatchObject({ $if: '$sources.detail.hasShortTitle', collapsible: true, defaultOpen: false });
		expect(nodesOf(panel).some(n => n.text === '$sources.detail.task.title')).toBe(true);
	});

	it('task-header: History and Children are always buttons, Delete stays reachable and is danger-outline, never the primary look', () => {
		const header = choicesOf(declared('task-header')[0]!.node);
		for (const [key, choice] of Object.entries(header)) {
			const links = nodesOf(choice.view).filter(n => n.$type === 'ButtonLink');
			const to = links.map(n => n.to);
			expect(to, key).toContain('$sources.detail.taskHrefs.history');
			expect(to, key).toContain('$sources.detail.taskHrefs.childrenList');
			const del = links.find(n => n.to === '$sources.detail.taskHrefs.deleteTasks');
			expect(del, `${key}: no way to the delete page`).toBeDefined();
			expect(del!.variant, key).toBe('danger-outline');
		}
		// Actions in a menu: Delete is inside the popover, the two others stay on the bar.
		const menu = header.menu!.view as Node;
		const popover = nodesOf(menu).find(n => n.$type === 'Popover')!;
		expect(nodesOf(popover).some(n => n.to === '$sources.detail.taskHrefs.deleteTasks')).toBe(true);
		const outside = nodesOf(menu).filter(n => n.$type === 'ButtonLink' && !nodesOf(popover).includes(n));
		expect(outside.map(n => n.to)).toEqual([
			'$sources.detail.taskHrefs.history',
			'$sources.detail.taskHrefs.childrenList',
		]);
	});

	it('task-header: the title sits in every option (the title dimension applies whatever the header)', () => {
		for (const [key, choice] of Object.entries(choicesOf(declared('task-header')[0]!.node))) {
			expect(
				nodesOf(choice.view).some(n => n.$type === 'AbTest' && n.id === 'task-title'),
				key
			).toBe(true);
		}
	});

	it('no design draws a PageHeader of its own for the title any more (it would be big and ignore the title row)', () => {
		for (const { name, index, tree } of combinations) {
			expect(
				nodesOf(tree).filter(n => n.$type === 'PageHeader'),
				`${name}#${index}`
			).toEqual([]);
		}
	});

	it('task-controls: wraps every status and type select; the old form is one option, the design own select the default', () => {
		const shared = parse(readFileSync(join(viewsDir, 'variants/_shared.yaml'), 'utf8'));
		for (const design of variantNames) {
			const tests = declared('task-controls').filter(d => d.design === design);
			expect(tests.length, design).toBeGreaterThan(0);
			for (const t of tests) {
				const choices = choicesOf(t.node);
				const inline = choices.inline!.view as Node;
				expect(inline.$type, design).toBe('task:ActionSelect');
				expect(choices.field!.view).toEqual({ ...inline, appearance: 'field' });
				const kind = inline.action === 'setStatusTo' ? 'status' : 'type';
				expect(choices.form!.view, `${design} ${kind}`).toEqual(shared[`form.${kind}`]);
			}
		}
		// No status or type select escapes the switcher.
		const bare: string[] = [];
		for (const design of variantNames) {
			const walkBare = (value: unknown, inside: boolean): void => {
				if (Array.isArray(value)) return value.forEach(v => walkBare(v, inside));
				if (!isNode(value)) return;
				const here = inside || (value.$type === 'AbTest' && value.id === 'task-controls');
				if (
					value.$type === 'task:ActionSelect' &&
					['setStatusTo', 'setTypeTo'].includes(String(value.action)) &&
					!inside
				) {
					bare.push(design);
				}
				Object.values(value).forEach(v => walkBare(v, here));
			};
			walkBare(variants[design]!.view, false);
		}
		expect(bare).toEqual([]);
	});

	it('the width is the task:WidthFrame component: no props but the page, the PageContent does not cap it', () => {
		expect(Object.keys(frame).sort()).toEqual(['$type', 'items']);
		expect(page.maxWidth).toBe('full');
	});

	it('is checked by parts: every option of every dimension alone, then all on their last and second option, per design', () => {
		const names = new Set(dimensionCombinations.map(c => String(c.index)));
		for (const dim of DIMENSIONS) {
			for (const choice of dimensionChoices[dim]!.filter(c => c !== dimensionInitial[dim])) {
				expect(names, `${dim}=${choice}`).toContain(`${dim}=${choice}`);
			}
		}
		expect(names).toContain('all-last');
		expect(names).toContain('all-second');
		expect(dimensionCombinations.every(c => c.tree !== undefined)).toBe(true);
	});
});

// Seen in github-b / github-a (sidebar): the PARENT label of a root task stood over nothing, as if the page had not loaded.
describe('a property row never stands empty', () => {
	it('every Parent row says "No parent" for a root task (or is only drawn when there is a parent)', () => {
		const rows: Array<{ id: string; row: Node }> = [];
		for (const { name, index, tree } of combinations) {
			for (const row of nodesOf(tree)) {
				if (row.$type === 'task:PropertyRow' && row.label === 'Parent')
					rows.push({ id: `${name}#${index}`, row });
			}
		}
		expect(rows.length).toBeGreaterThan(0);
		for (const { id, row } of rows) {
			const says = nodesOf(row.items).some(n => n.$if === '$sources.detail.noParent' && n.label === 'No parent');
			expect(says || row.$if === '$sources.detail.hasParent', `${id}: an empty Parent row for a root task`).toBe(
				true
			);
		}
	});
});

// Seen at 390 px in github-b: a 600-character title or description without a space ran thousands of pixels wide.
describe('long text cannot widen a design', () => {
	it('no design prints the task title through a component that does not break long words', () => {
		for (const { name, index, tree } of combinations) {
			for (const node of nodesOf(tree)) {
				// Raw titles go through task:TitleText (wraps anywhere); the page-wide frame also sets overflow-wrap.
				expect(node.$type, `${name}#${index}: title in ${String(node.$type)}`).not.toBe('PageHeader');
				if (node.title === '$sources.detail.task.title') {
					expect(['task:TitleText'], `${name}#${index}`).toContain(node.$type);
				}
			}
		}
	});
});

// Seen at 390 px in github-b: the status / project / date / blocked chips sat in a HorizontalStack, which never wraps, so each was
// squeezed to a few letters and the page grew wider than the screen. A row of several chips is a task:ChipRow.
describe('chips wrap', () => {
	it('no HorizontalStack holds several chips: a row of chips is a task:ChipRow', () => {
		const CHIPS = ['Badge', 'task:StatusBadge', 'RelativeDate', 'Tag'];
		for (const { name, index, tree } of combinations) {
			for (const node of nodesOf(tree)) {
				if (node.$type !== 'HorizontalStack' || !Array.isArray(node.items)) continue;
				const chips = (node.items as Node[]).filter(item => CHIPS.includes(String(item.$type)));
				expect(chips.length, `${name}#${index}: HorizontalStack of ${chips.length} chips`).toBeLessThanOrEqual(
					1
				);
			}
		}
	});
});

describe('regression guard: "current" is the page as it was', () => {
	// The one change to the feedback of the old page: the error and undelivered-events badges of the action results
	// became task:Notice (same label, same condition, but the text wraps instead of running off the screen).
	const asNotices = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(asNotices);
		if (!isNode(value)) return value;
		const mapped = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, asNotices(item)]));
		const isResult =
			typeof value.label === 'string' && /^\$ctx\.\w+Result\.(errorText|undeliveredText)$/.test(value.label);
		return value.$type === 'Badge' && isResult ? { ...mapped, $type: 'task:Notice' } : mapped;
	};
	const headSections = asNotices(head.sections) as Node[];
	// The five notices moved to the page root (above the page header, which is the one visible difference in error states).
	const headNotices = headSections.slice(1, 6);
	const headRest = [headSections[0], ...headSections.slice(6)];

	it('the sources are unchanged and the actions are the old ones plus the quick actions', () => {
		// The one added source is the extension point (see 'has the slot task:project-header').
		const { projectHeader, ...sources } = page.$sources as Record<string, unknown>;
		expect(projectHeader).toBeDefined();
		expect(sources).toEqual(head.$sources);
		const actions = page.$actions as Record<string, unknown>;
		const oldActions = head.$actions as Record<string, unknown>;
		for (const [name, spec] of Object.entries(oldActions)) {
			expect(actions[name], name).toEqual(spec);
		}
		expect(
			Object.keys(actions)
				.filter(n => !(n in oldActions))
				.sort()
		).toEqual(['addLabelTo', 'removeLabelChip', 'removeLinkRow', 'setStatusTo', 'setTypeTo']);
	});

	it('the notices are the old ones', () => {
		expect(sections.slice(1, -1)).toEqual(headNotices);
	});

	it('the view of "current" is the old page body, node for node', () => {
		const current = variants.current!.view as Node;
		expect(current.$type).toBe('VerticalStack');
		expect(current.gap).toBe('gap-4');
		// The deliberate changes since the head: the flat Links table became the relation groups (next test), and the three
		// dimensions replaced the page header and the Status / Type forms (compared by the tests of 'the shared dimensions').
		const isDimension = (n: Node): boolean => n.$type === 'AbTest' && DIMENSIONS.includes(String(n.id));
		const withoutDimensions = (items: Node[]): Node[] =>
			items
				.filter(n => n.$type !== 'PageHeader' && !(n.$type === 'AbTest' && n.id === 'task-header'))
				.map(n =>
					n.title === 'Status' || n.title === 'Type'
						? {
								...n,
								items: (n.items as Node[]).filter(
									i =>
										!isDimension(i) &&
										!(
											i.$type === 'Form' &&
											(i.onSubmit === '$ctx.setStatus' || i.$if === '$sources.detail.hasTypes')
										)
								),
							}
						: n
				);
		// The chips row of the old page is a task:ChipRow now (a HorizontalStack never wraps: see 'chips wrap').
		const wrapping = (n: Node): Node => (n.$type === 'HorizontalStack' ? { ...n, $type: 'task:ChipRow' } : n);
		const expected = withoutDimensions(structuredClone(headRest) as Node[]).map(wrapping);
		const links = expected.find(n => n.title === 'Links') as Node;
		links.items = (links.items as Node[]).filter(n => n.$type !== 'DataTable');
		const actual = withoutDimensions(current.items as Node[]);
		expect(actual).toEqual(expected.map(n => (n.title === 'Links' ? actual.find(c => c.title === 'Links') : n)));
		expect(page.$type).toBe(head.$type);
	});

	it('the Links section of "current" shows the groups of GET /tasks/:id/links instead of the flat table, keeping its feedback and forms', () => {
		const current = variants.current!.view as Node;
		const section = (current.items as Node[]).find(n => n.title === 'Links') as Node;
		const headLinks = (headSections.find(n => n.title === 'Links') as Node).items as Node[];
		const items = section.items as Node[];
		const flat = headLinks.findIndex(n => n.$type === 'DataTable');
		expect(items.slice(0, flat)).toEqual(headLinks.slice(0, flat));
		// The answer of the x of a row (removeLinkRow, own result key) is shown right above the groups.
		expect(items.slice(flat, flat + 4)).toEqual([
			{
				$type: 'task:Notice',
				$if: '$ctx.linkRowResult.errorText',
				label: '$ctx.linkRowResult.errorText',
				variant: 'danger',
			},
			{
				$type: 'task:Notice',
				$if: '$ctx.linkRowResult.undeliveredText',
				label: '$ctx.linkRowResult.undeliveredText',
				variant: 'warning',
			},
			{ $type: 'ExtensionSlot', $if: '$sources.links.hasLinks', items: '$sources.links.groupSections' },
			{ $type: 'Badge', $if: '$sources.links.noLinks', label: 'No links', variant: 'info' },
		]);
		expect(items.slice(flat + 4)).toEqual(headLinks.slice(flat + 1));
	});

	it('no variant lists the links as one flat table or row list any more: every one renders the relation groups', () => {
		for (const { name, index, tree } of combinations) {
			const strings = stringsOf(tree);
			expect(strings, `${name}#${index} still reads the flat rows`).not.toContain('$sources.links.rows');
			const consumes = strings.includes('$sources.links.groupSections');
			const showsLinks = strings.some(x => x.startsWith('$sources.links.'));
			if (showsLinks) expect(consumes, `${name}#${index} reads $sources.links but not the groups`).toBe(true);
		}
	});

	it('the shared fragments equal the matching nodes of the old page', () => {
		const shared = parse(readFileSync(join(viewsDir, 'variants/_shared.yaml'), 'utf8'));
		const section = (title: string): Node[] => (headSections.find(s => s.title === title) as Node).items as Node[];
		expect(shared['form.status'] as Node, 'form.status').toEqual(section('Status').find(n => n.$type === 'Form'));
		expect(shared['form.addLabel']).toEqual(section('Labels').filter(n => n.$type === 'Form')[0]);
		expect(shared['form.removeLabel']).toEqual(section('Labels').filter(n => n.$type === 'Form')[1]);
		expect(shared['form.meta']).toEqual(section('Metadata').find(n => n.$type === 'Form'));
		expect(shared['form.setParent']).toEqual(section('Hierarchy').filter(n => n.$type === 'Form')[0]);
		expect(shared['form.detachParent']).toEqual(section('Hierarchy').filter(n => n.$type === 'Form')[1]);
		expect(shared['form.addLink']).toEqual(section('Links').filter(n => n.$type === 'Form')[0]);
		expect(shared['form.removeLink']).toEqual(section('Links').filter(n => n.$type === 'Form')[1]);
		expect(shared['form.type']).toEqual(section('Type').filter(n => n.$type === 'Form')[0]);
		expect(shared['form.typeFree']).toEqual(section('Type').filter(n => n.$type === 'Form')[1]);
		for (const [name, title] of [
			['status', 'Status'],
			['type', 'Type'],
			['label', 'Labels'],
			['meta', 'Metadata'],
			['parent', 'Hierarchy'],
			['link', 'Links'],
		] as const) {
			const badges = section(title).filter(
				n => n.$type === 'task:Notice' && String(n.$if).startsWith(`$ctx.${name}Result`)
			);
			expect((shared[`feedback.${name}`] as Node).items, `feedback.${name}`).toEqual(badges);
		}
	});
});

describe('sources', () => {
	it('are fed by projectQuery (never an empty query: the shell keeps the last answer of a skipped source)', () => {
		const sources = page.$sources as Record<string, { params?: Record<string, unknown> }>;
		for (const name of ['detail', 'tree', 'links']) {
			expect(sources[name]!.params?.query, name).toBe('$source.projects.projectQuery');
		}
	});
});

describe('the remove button of a link row', () => {
	const actions = page.$actions as Record<string, { url: string; resultKey: string; reloadSources: boolean }>;

	it('runs removeLinkRow: the ids come from the row (the shell substitutes nothing else), the answer goes to the link feedback', () => {
		const action = actions['removeLinkRow']!;
		// {target} is percent-encoded by the named handler (<key>Encoded): a vanished task id typed by hand may hold any character.
		expect(action.url).toBe(
			'DELETE /api/modules/task/tasks/{id}/links?project={projectParam}&type={type}&target={targetEncoded}&inlineErrors=true'
		);
		// Its own key: the link forms may be folded away (their feedback with them), the groups never are.
		expect(action.resultKey).toBe('linkRowResult');
		expect(action.reloadSources).toBe(true);
	});
});

describe('quick actions', () => {
	const actions = page.$actions as Record<string, { url: string; resultKey: string; reloadSources: boolean }>;

	it.each([
		// The value is also offered percent-encoded as <key>Encoded (the shell does not encode the placeholders of a named handler).
		['setStatusTo', 'status', '{statusEncoded}', 'statusResult'],
		['setTypeTo', 'type', '{typeEncoded}', 'typeResult'],
		['addLabelTo', 'labels', '{labelEncoded}', 'labelResult'],
	])(
		'%s carries its value in the URL path (the shell sends no body), the project and inlineErrors',
		(name, segment, placeholder, resultKey) => {
			const action = actions[name]!;
			expect(action.url).toBe(
				`POST /api/modules/task/tasks/{id}/${segment}/${placeholder}?project={projectParam}&inlineErrors=true`
			);
			expect(action.resultKey).toBe(resultKey);
			expect(action.reloadSources).toBe(true);
		}
	);
});

describe('label removal by key', () => {
	const actions = page.$actions as Record<string, { url: string }>;

	// Labels with "/" or "%" cannot travel in a path (app-core answers 404), so removal uses the base64url key route.
	it.each(['removeLabel', 'removeLabelChip'])('%s calls the label-keys route', name => {
		expect(actions[name]!.url).toContain('DELETE /api/modules/task/tasks/{id}/label-keys/{label');
	});

	it('every LabelChips with a remove action is given the keys of the labels', () => {
		const chips: Node[] = [];
		walk(page, node => {
			if (node.$type === 'task:LabelChips' && node.removeAction !== undefined) chips.push(node);
		});
		expect(chips.length).toBeGreaterThan(0);
		for (const chip of chips) {
			expect(chip.removeAction).toBe('removeLabelChip');
			expect(chip.labelKeys).toBe('$sources.detail.labelKeys');
		}
	});
});

// A logical feature of the page -> the actions that can provide it. A variant keeps every feature in every combination.
const LOGICAL_ACTIONS: Record<string, string[]> = {
	status: ['setStatus', 'setStatusTo'],
	type: ['setType', 'setTypeTo'],
	'label add': ['addLabel', 'addLabelTo'],
	'label remove': ['removeLabel', 'removeLabelChip'],
	meta: ['setMeta'],
	'parent set': ['setParent'],
	'parent detach': ['removeParent'],
	'link add': ['addLink'],
	'link remove': ['removeLink'],
};
const NAVIGATION: Record<string, string> = {
	history: '$sources.detail.taskHrefs.history',
	children: '$sources.detail.taskHrefs.childrenList',
	'delete entry': '$sources.detail.taskHrefs.deleteTasks',
};
// The page as shipped has no way to the delete page; the variants add it.
const NAVIGATION_EXEMPT: Record<string, string[]> = { current: ['delete entry'] };
// linkResult: the add / remove link forms. linkRowResult (the x of a link row) is checked next to the groups it belongs to, below.
const RESULT_KEYS = ['statusResult', 'typeResult', 'labelResult', 'metaResult', 'parentResult', 'linkResult'];

describe.each(each)('variant combination %s', (id, tree) => {
	const name = id.split('#')[0]!;
	const strings = new Set(stringsOf(tree));

	it.each(Object.entries(LOGICAL_ACTIONS))('keeps the feature "%s"', (feature, names) => {
		const wired = names.filter(n => strings.has(n) || strings.has(`$ctx.${n}`));
		expect(wired, `${id} has no way to ${feature} (expected one of ${names.join(', ')})`).not.toEqual([]);
	});

	it.each(Object.entries(NAVIGATION))('links to the %s page', (feature, target) => {
		if (NAVIGATION_EXEMPT[name]?.includes(feature)) return;
		expect(strings.has(target), `${id} has no link to ${feature} (${target})`).toBe(true);
	});

	it.each(RESULT_KEYS)('shows the error and the undelivered-events badges of %s', key => {
		// A message that wraps (task:Notice) stands for a Badge in a narrow column: same label, same condition.
		const badges = nodesOf(tree).filter(n => n.$type === 'Badge' || n.$type === 'task:Notice');
		for (const field of ['errorText', 'undeliveredText']) {
			expect(
				badges.some(b => b.label === `$ctx.${key}.${field}`),
				`${id}: no Badge showing $ctx.${key}.${field}`
			).toBe(true);
		}
	});

	it.each(RESULT_KEYS)('shows the feedback of %s once, not in two places', key => {
		// Two copies behind opposite flags (hasType / noType, ...) are never on screen together.
		const flagOf = (cond: unknown): { positive: boolean; name: string } | null => {
			const m = /^\$sources\.detail\.(has|no)([A-Z]\w*)$/.exec(String(cond));
			return m ? { positive: m[1] === 'has', name: m[2]! } : null;
		};
		const exclusive = (a: Node[], b: Node[]): boolean =>
			a.some(x =>
				b.some(y => {
					const fx = flagOf(x.$if);
					const fy = flagOf(y.$if);
					return (
						fx !== null &&
						fy !== null &&
						fx.name.replace(/s$/, '') === fy.name.replace(/s$/, '') &&
						fx.positive !== fy.positive
					);
				})
			);
		const found: Array<{ node: Node; chain: Node[] }> = [];
		walk(tree, (node, ancestors) => {
			if (node.$type === 'Badge' || node.$type === 'task:Notice')
				found.push({ node, chain: [...ancestors, node] });
		});
		for (const field of ['errorText', 'undeliveredText']) {
			const shown = found.filter(f => f.node.label === `$ctx.${key}.${field}`);
			for (const [i, a] of shown.entries()) {
				for (const b of shown.slice(i + 1)) {
					expect(
						exclusive(a.chain, b.chain),
						`${id}: $ctx.${key}.${field} is shown in two places at once`
					).toBe(true);
				}
			}
		}
	});

	it('shows the feedback of a link row removal next to the link groups: never folded, never hidden with the groups, only when set', () => {
		const slots: Array<{ node: Node; ancestors: Node[] }> = [];
		walk(tree, (node, ancestors) => {
			if (node.$type === 'ExtensionSlot' && node.items === '$sources.links.groupSections')
				slots.push({ node, ancestors });
		});
		expect(slots.length, `${id}: the link groups are drawn at most once`).toBeLessThanOrEqual(1);
		// No groups (linear-a with its relations hidden): no x to press, nothing to report.
		if (slots.length === 0) return;
		const slot = slots[0]!;
		const hiddenWhenFolded = (a: Node): boolean =>
			a.$type === 'Form' || a.collapsible === true || a.defaultOpen === false;
		for (const field of ['errorText', 'undeliveredText']) {
			const label = `$ctx.linkRowResult.${field}`;
			const found: Array<{ node: Node; ancestors: Node[] }> = [];
			walk(tree, (node, ancestors) => {
				if (node.$type === 'task:Notice' && node.label === label) found.push({ node, ancestors });
			});
			expect(found, `${id}: one Notice for ${label}`).toHaveLength(1);
			const notice = found[0]!;
			// An empty block never shows: the Notice itself is the conditional node.
			expect(notice.node.$if, `${id}: ${label} shows only when the answer holds it`).toBe(label);
			// A fold the groups share (a collapsible 'Linked items' panel) hides both together; any other fold hides only the Notice.
			expect(
				notice.ancestors.filter(a => hiddenWhenFolded(a) && !slot.ancestors.includes(a)),
				`${id}: ${label} sits in a folded container the link groups are not in`
			).toEqual([]);
			expect(
				notice.ancestors.filter(a => String(a.$if ?? '').includes('$sources.links.')),
				`${id}: ${label} vanishes with the groups (last link removed)`
			).toEqual([]);
			// Same container as the groups: the parent of the Notice holds the groups slot.
			const parent = notice.ancestors[notice.ancestors.length - 1]!;
			expect(
				nodesOf(parent).includes(slot.node),
				`${id}: ${label} is not in the container of the link groups`
			).toBe(true);
		}
	});

	it('shows what the queue did not receive, and the failure of an action, in a node that wraps (never a plain Badge)', () => {
		// The replay text of an undelivered event is one long command with a JSON payload: a Badge keeps one line and
		// runs off its column (seen in gitlab-a and, to the screen edge, in current).
		const result = /^\$ctx\.\w+\.(undeliveredText|errorText)$/;
		const plain = nodesOf(tree).filter(
			n => n.$type !== 'task:Notice' && typeof n.label === 'string' && result.test(n.label)
		);
		expect(
			plain.map(n => `${String(n.$type)} ${String(n.label)}`),
			`${id}`
		).toEqual([]);
	});

	it('only uses actions the page declares', () => {
		const declared = Object.keys(page.$actions as object);
		for (const s of strings) {
			const m = /^\$ctx\.([A-Za-z]+)$/.exec(s);
			if (m && /^(set|add|remove)[A-Z]/.test(m[1]!)) expect(declared, `${id}: ${s}`).toContain(m[1]);
		}
	});

	it('has no link that leads back (the breadcrumb carries the context)', () => {
		const kept = new Set(Object.values(NAVIGATION));
		for (const node of nodesOf(tree)) {
			expect(node.$type, `${id}: BackLink`).not.toBe('BackLink');
			if (node.$type === 'ButtonLink') {
				expect(String(node.label), `${id}: ${String(node.label)}`).not.toMatch(
					/^(Back\b|All (projects|tasks)\b)/i
				);
				// A page link goes to a feature (history, children, delete, another task), never to a list.
				if (typeof node.to === 'string' && node.to.startsWith('$sources.detail.taskHrefs.'))
					expect(kept.has(node.to)).toBe(true);
			}
		}
		for (const gone of ['allProjectsHref', 'globalHrefs', 'tasksHref', 'taskHrefs.detail', 'detail.hrefs.tasks']) {
			expect(
				[...strings].some(s => s.includes(gone)),
				`${id}: ${gone}`
			).toBe(false);
		}
	});

	it('guards every FieldSelect behind $if and gives a placeholder to the selects that act on an existing item', () => {
		walk(tree, (node, ancestors) => {
			if (node.$type !== 'FieldSelect') return;
			const form = [...ancestors].reverse().find(a => a.$type === 'Form');
			expect(form?.$if, `${id}: FieldSelect "${String(node.label)}" is not inside a Form with $if`).toBeTruthy();
			if (node.bind === 'label') expect(node.placeholder, `${id}: remove-label select`).toBeTruthy();
		});
	});

	it('truncates title columns and keeps short-code columns on one line', () => {
		for (const node of nodesOf(tree)) {
			if (node.$type !== 'DataTable') continue;
			for (const column of node.columns as Array<Record<string, unknown>>) {
				if (column.key === 'titleText') expect(column.truncate, `${id}: titleText`).toBe(true);
				if (['id', 'status', 'created', 'time'].includes(String(column.key))) {
					expect(column.nowrap, `${id}: column ${String(column.key)}`).toBe(true);
				}
			}
		}
	});

	it('declares no source or action of its own: the page level ones are the only ones', () => {
		expect(
			nodesOf(tree).some(n => '$sources' in n || '$actions' in n),
			id
		).toBe(false);
	});

	it('reads its data only from the sources of the page', () => {
		for (const s of strings) {
			const m = /^$sources.([A-Za-z]+)/.exec(s);
			if (m) expect(['projects', 'detail', 'tree', 'links'], `${id}: ${s}`).toContain(m[1]);
		}
	});
});

// Constructs the installed shell (dsl-ui 175) does not support: a variant using one would break the page if it were chosen.
describe.each(each)('175 compatibility of %s', (id, tree) => {
	const DENIED_TYPES = ['ActionButton', 'Tabs', 'PageTabs'];

	it('uses no node or construct that only exists in dsl-ui >= 240', () => {
		walk(tree, (node, ancestors) => {
			expect(
				DENIED_TYPES,
				`${id}: ${String(node.$type)} needs dsl-ui >= 240 / has children the 175 shell cannot render`
			).not.toContain(node.$type);
			if (node.$type === 'Drawer')
				expect(node.open, `${id}: a literal open Drawer cannot be closed`).not.toBe(true);
			if ('bind' in node) {
				expect(
					ancestors.some(a => a.$type === 'Form'),
					`${id}: bind outside a Form (dsl-ui >= 240)`
				).toBe(true);
			}
		});
		for (const s of stringsOf(tree)) {
			if (s.startsWith('$')) expect(s, `${id}: negation expression`).not.toMatch(/(^|[\s(&|])!(?!=)/);
		}
	});
});

// Built-in node types the installed shell is known to render: the ones the pages already use plus those the design doc
// (section 3) verified on 175. Adding a type here is a decision: check it in the installed shell first.
const BUILTIN_175 = new Set([
	// dsl-ui AbTest (dev dock; production renders the initial variant only).
	'AbTest',
	'PageContent',
	'PageHeader',
	'PageSection',
	'Section',
	'Card',
	'HorizontalStack',
	'VerticalStack',
	'Collapsible',
	'Divider',
	'Badge',
	'Tag',
	'ChipButton',
	'FieldReadOnly',
	'Markdown',
	'RelativeDate',
	'Progress',
	'StatTile',
	'Popover',
	'Dialog',
	'DataTable',
	'ExtensionSlot',
	'Form',
	'FieldSelect',
	'FieldText',
	'FieldTextarea',
	'ButtonSave',
	'ButtonAction',
	'ButtonLink',
	'Breadcrumb',
	...nodesOf(head)
		.map(n => n.$type)
		.filter((t): t is string => typeof t === 'string'),
]);

describe('node types', () => {
	const libExpected = ((): string[] | null => {
		const file = join(import.meta.dirname, '../../../dsl-lib-task/test/libEntries.test.ts');
		if (!existsSync(file)) return null;
		const match = /const EXPECTED = \[([\s\S]*?)\];/.exec(readFileSync(file, 'utf8'));
		return match ? [...match[1]!.matchAll(/'(\w+)'/g)].map(m => m[1]!) : null;
	})();

	it('every $type is a built-in known to the installed shell or a task:<Name> the dsl-lib exports', () => {
		expect(libExpected, 'packages/dsl-lib-task/test/libEntries.test.ts EXPECTED list not found').not.toBeNull();
		const problems: string[] = [];
		// The fork task:VariantSwitcher is gone: the native dsl-ui AbTest is used, and the lib must not export a copy.
		if (libExpected!.includes('VariantSwitcher')) {
			problems.push('dsl-lib-task still exports VariantSwitcher: the native AbTest replaces it');
		}
		for (const { name, index, tree } of combinations) {
			for (const node of nodesOf(tree)) {
				const type = node.$type;
				if (typeof type !== 'string') continue;
				if (type.startsWith('task:')) {
					if (!libExpected!.includes(type.slice(5)))
						problems.push(
							`${name}#${index}: ${type} is not exported by dsl-lib-task (EXPECTED: ${libExpected!.join(', ')})`
						);
				} else if (!BUILTIN_175.has(type)) {
					problems.push(
						`${name}#${index}: ${type} is not a known 175 built-in (see BUILTIN_175 in this test)`
					);
				}
			}
		}
		expect([...new Set(problems)]).toEqual([]);
	});
});

describe('the generator reports what is wrong, with the fix', () => {
	function scratch(files: Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), 'task-variants-'));
		mkdirSync(join(dir, 'variants'));
		const base: Record<string, string> = {
			'_page.yaml':
				'$sources: {}\n$type: PageContent\n$notices: []\n$experiment: { id: t, label: T, initial: a, variants: [a] }\n',
			'_shared.yaml': 'x: { $type: Badge, label: x }\n',
			'a.yaml': 'label: A\nhint: h\nview: { $use: x }\n',
			...files,
		};
		for (const [name, text] of Object.entries(base)) writeFileSync(join(dir, 'variants', name), text);
		return dir;
	}

	it('expands $use and keeps the verbatim head', () => {
		const out = generateTaskPage(scratch({}));
		expect(out).toContain('$sources: {}');
		expect(parse(out).sections).toEqual([
			{
				$type: 'AbTest',
				id: 't',
				label: 'T',
				initial: 'a',
				variants: { a: { label: 'A', hint: 'h', view: { $type: 'Badge', label: 'x' } } },
			},
		]);
	});

	it('puts the experiment in the `items` of $wrap and merges $page into the PageContent', () => {
		const out = parse(
			generateTaskPage(
				scratch({
					'_page.yaml':
						'$type: PageContent\n$page: { maxWidth: full }\n$wrap: { $type: task:WidthFrame }\n$notices: []\n$experiment: { id: t, label: T, initial: a, variants: [a] }\n',
				})
			)
		);
		expect(out.maxWidth).toBe('full');
		const [wrapper] = out.sections as Node[];
		expect(wrapper).toMatchObject({ $type: 'task:WidthFrame' });
		expect((wrapper!.items as Node[]).map(n => n.$type)).toEqual(['AbTest']);
	});

	it('wraps every status / type task:ActionSelect of a design in the task-controls switcher, the design own one as default', () => {
		const select = (action: string): string =>
			`{ $type: task:ActionSelect, action: ${action}, appearance: pill, options: o, value: v }`;
		const out = parse(
			generateTaskPage(
				scratch({
					'_shared.yaml': [
						'x: { $type: Badge, label: x }',
						'form.status: { $type: Form, onSubmit: $ctx.setStatus }',
						'form.type: { $type: Form, onSubmit: $ctx.setType }',
						`ctl.status.default: ${select('setStatusTo')}`,
						`ctl.type.default: ${select('setTypeTo')}`,
					].join('\n'),
					'a.yaml': `label: A\nhint: h\nview: { $type: VerticalStack, items: [${select('setStatusTo')}, ${select('setTypeTo')}, { $use: ctl.status }, { $type: task:ActionSelect, action: other }] }\n`,
				})
			)
		);
		const view = (out.sections as Node[])[0] as Node;
		const items = ((view.variants as Record<string, Fragment>).a!.view as Node).items as Node[];
		expect(items.map(n => [n.$type, n.id])).toEqual([
			['AbTest', 'task-controls'],
			['AbTest', 'task-controls'],
			// An explicit $use: ctl.status is the same switcher, not wrapped twice.
			['AbTest', 'task-controls'],
			['task:ActionSelect', undefined],
		]);
		const status = items[0]!.variants as Record<string, Fragment>;
		expect(Object.keys(status)).toEqual(['inline', 'field', 'form']);
		expect(items[0]!.initial).toBe('inline');
		expect(status.inline!.view).toMatchObject({ action: 'setStatusTo', appearance: 'pill' });
		expect(status.field!.view).toMatchObject({ action: 'setStatusTo', appearance: 'field' });
		expect(status.form!.view).toEqual({ $type: 'Form', onSubmit: '$ctx.setStatus' });
		expect(((items[1]!.variants as Record<string, Fragment>).form!.view as Node).onSubmit).toBe('$ctx.setType');
		expect(((items[2]!.variants as Record<string, Fragment>).inline!.view as Node).action).toBe('setStatusTo');
	});

	it.each([
		[
			'an unknown $use',
			{ 'a.yaml': 'label: A\nhint: h\nview: { $use: nope }\n' },
			/unknown \$use "nope".*Shared fragments: x/s,
		],
		[
			'a $use cycle',
			{ '_shared.yaml': 'x: { $use: y }\ny: { $use: x }\n', 'a.yaml': 'label: A\nhint: h\nview: { $use: x }\n' },
			/cycle x -> y -> x/,
		],
		['a $use with other keys', { 'a.yaml': 'label: A\nhint: h\nview: { $use: x, label: z }\n' }, /no other key/],
		['a fragment without hint', { 'a.yaml': 'label: A\nview: { $type: Badge }\n' }, /missing: hint/],
		[
			'a missing variant file',
			{
				'_page.yaml':
					'$type: PageContent\n$notices: []\n$experiment: { id: t, label: T, initial: a, variants: [a, b] }\n',
			},
			/b\.yaml.*is missing/s,
		],
		[
			'a duplicate variant',
			{
				'_page.yaml':
					'$type: PageContent\n$notices: []\n$experiment: { id: t, label: T, initial: a, variants: [a, a] }\n',
			},
			/listed twice/,
		],
		['an unlisted fragment file', { 'zzz.yaml': 'label: Z\nhint: h\nview: {}\n' }, /zzz\.yaml.*not listed/s],
		[
			'an initial that is not a variant',
			{
				'_page.yaml':
					'$type: PageContent\n$notices: []\n$experiment: { id: t, label: T, initial: q, variants: [a] }\n',
			},
			/initial "q"/,
		],
	])('%s', (_label, files, message) => {
		expect(() => generateTaskPage(scratch(files))).toThrow(message);
	});

	it('every error tells where to read how a variant is added', () => {
		expect(() => generateTaskPage(scratch({ 'a.yaml': 'label: A\n' }))).toThrow(/_page\.yaml/);
	});

	it('the real folder lists exactly the fragment files it contains', () => {
		const files = readdirSync(join(DEFAULT_VIEWS_DIR, 'variants')).filter(f => f.endsWith('.yaml'));
		expect(files.sort()).toEqual(['_page.yaml', '_shared.yaml', ...variantNames.map(n => `${n}.yaml`)].sort());
	});
});
