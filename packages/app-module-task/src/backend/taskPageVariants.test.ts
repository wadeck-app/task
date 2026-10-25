import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEWS_DIR, generateTaskPage, taskPageFile } from '../../../../scripts/generate-task-page.mjs';

/*
 * The task page is an experiment: task-page.yaml is GENERATED from src/dsl-views/variants/* and holds one
 * task:VariantSwitcher with the current page and ten design variants. These tests are the contract every variant keeps,
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
const switcher = sections.find(s => s.$type === 'task:VariantSwitcher') as Node;
interface Fragment {
	label: string;
	hint: string;
	view: unknown;
}
const variants = switcher.variants as Record<string, Fragment>;
const variantNames = Object.keys(variants);

// Every combination of the options of a node: a nested switcher is replaced by the view of each of its choices.
function alternatives(value: unknown): unknown[] {
	if (Array.isArray(value)) {
		return value.reduce<unknown[][]>(
			(acc, item) => acc.flatMap(prefix => alternatives(item).map(alt => [...prefix, alt])),
			[[]]
		);
	}
	if (!isNode(value)) {
		return [value];
	}
	if (value.$type === 'task:VariantSwitcher') {
		return Object.values(value.variants as Record<string, Fragment>).flatMap(choice => alternatives(choice.view));
	}
	return Object.entries(value).reduce<Node[]>(
		(acc, [key, item]) => acc.flatMap(prefix => alternatives(item).map(alt => ({ ...prefix, [key]: alt }))),
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

/** Variant -> every resolved combination of its options. */
const combinations: Array<{ name: string; index: number; tree: unknown }> = variantNames.flatMap(name =>
	alternatives(variants[name]!.view).map((tree, index) => ({ name, index, tree }))
);
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
	it('is ONE task:VariantSwitcher at the page root, initial is "current", in the agreed order', () => {
		expect(sections.filter(s => s.$type === 'task:VariantSwitcher')).toHaveLength(1);
		expect(sections[sections.length - 1]).toBe(switcher);
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
			if (node.$type !== 'task:VariantSwitcher') return;
			for (const [key, choice] of Object.entries(node.variants as Record<string, Fragment>)) {
				expect(choice.label, `${String(node.id)}/${key} label`).toMatch(/\S/);
				expect(choice.hint, `${String(node.id)}/${key} hint`).toMatch(/\S/);
			}
			expect(Object.keys(node.variants as object), `${String(node.id)} initial`).toContain(node.initial);
			expect(node.label, `${String(node.id)} label`).toMatch(/\S/);
		});
	});

	it('nests at most 3 options per variant, each with 2 or 3 choices, ids unique and prefixed with the variant', () => {
		const ids = new Set<string>(['task-design']);
		for (const name of variantNames) {
			// The same option may appear in several places of a variant (e.g. in both layouts of a sidebar option) as long as the
			// declaration is identical: the switcher shows one row for it. A different declaration under one id is a bug.
			const byId = new Map<string, Node>();
			walk(variants[name]!.view, node => {
				if (node.$type !== 'task:VariantSwitcher') return;
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
		expect(combinations.filter(c => c.name === 'current')).toHaveLength(1);
		for (const name of variantNames) {
			expect(combinations.filter(c => c.name === name).length, `${name} combinations`).toBeLessThanOrEqual(27);
		}
	});

	it('keeps the notices OUTSIDE the switcher, so every variant has the same error and empty states', () => {
		const labels = sections.slice(0, -1).map(s => `${String(s.$type)}:${String(s.label)}`);
		expect(labels).toEqual([
			'Badge:$sources.projects.noProjectsText',
			'Badge:$sources.projects.selectedProblem',
			'Badge:$sources.projects.unknownProjectText',
			'Badge:$sources.detail.errorText',
			'Badge:$sources.detail.warningText',
		]);
		expect(sections.slice(0, -1).map(s => s.$if)).toEqual([
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

describe('regression guard: "current" is the page as it was', () => {
	const headSections = head.sections as Node[];
	// The five notices moved to the page root (above the page header, which is the one visible difference in error states).
	const headNotices = headSections.slice(1, 6);
	const headRest = [headSections[0], ...headSections.slice(6)];

	it('the sources are unchanged and the actions are the old ones plus the quick actions', () => {
		expect(page.$sources).toEqual(head.$sources);
		const actions = page.$actions as Record<string, unknown>;
		const oldActions = head.$actions as Record<string, unknown>;
		for (const [name, spec] of Object.entries(oldActions)) {
			expect(actions[name], name).toEqual(spec);
		}
		expect(
			Object.keys(actions)
				.filter(n => !(n in oldActions))
				.sort()
		).toEqual(['addLabelTo', 'removeLabelChip', 'setStatusTo', 'setTypeTo']);
	});

	it('the notices are the old ones', () => {
		expect(sections.slice(0, -1)).toEqual(headNotices);
	});

	it('the view of "current" is the old page body, node for node', () => {
		const current = variants.current!.view as Node;
		expect(current.$type).toBe('VerticalStack');
		expect(current.gap).toBe('gap-4');
		expect(current.items).toEqual(headRest);
		expect(page.$type).toBe(head.$type);
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
				n => n.$type === 'Badge' && String(n.$if).startsWith(`$ctx.${name}Result`)
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
		if (!libExpected!.includes('VariantSwitcher')) {
			problems.push(
				`page root: task:VariantSwitcher is not exported by dsl-lib-task (EXPECTED: ${libExpected!.join(', ')})`
			);
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
				$type: 'task:VariantSwitcher',
				id: 't',
				label: 'T',
				initial: 'a',
				variants: { a: { label: 'A', hint: 'h', view: { $type: 'Badge', label: 'x' } } },
			},
		]);
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
