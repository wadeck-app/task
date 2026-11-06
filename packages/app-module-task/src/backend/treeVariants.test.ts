import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { generateTreePage, treePageFile } from '../../../../scripts/generate-tree-page.mjs';

/*
 * The global Tree page is an experiment: tree-page.yaml is GENERATED from src/dsl-views/tree-variants/* and holds one
 * AbTest with the current page and five designs for dozens of projects. These tests are the contract of
 * every variant, for EVERY combination of its options. See tree-variants/_page.yaml.
 */

type Node = Record<string, unknown>;
const parse = (text: string): Node => yaml.load(text) as Node;
const page = parse(readFileSync(treePageFile(), 'utf8'));
const head = parse(readFileSync(join(import.meta.dirname, '__fixtures__/tree-page.head.yaml'), 'utf8'));

const isNode = (value: unknown): value is Node => value !== null && typeof value === 'object' && !Array.isArray(value);
const sections = page.sections as Node[];
// The switcher sits in a stack that carries the `$if`: an `$if` on the switcher itself looped ("Maximum update depth") when a
// variant was chosen in the dev shell.
const wrapper = sections.find(
	s => s.$type === 'VerticalStack' && (s.items as Node[] | undefined)?.[0]?.$type === 'AbTest'
) as Node;
const switcher = (wrapper.items as Node[])[0]!;
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
	if (!isNode(value)) return [value];
	if (value.$type === 'AbTest') {
		return Object.values(value.variants as Record<string, Fragment>).flatMap(choice => alternatives(choice.view));
	}
	return Object.entries(value).reduce<Node[]>(
		(acc, [key, item]) => acc.flatMap(prefix => alternatives(item).map(alt => ({ ...prefix, [key]: alt }))),
		[{}]
	);
}

function walk(value: unknown, visit: (node: Node) => void): void {
	if (Array.isArray(value)) value.forEach(item => walk(item, visit));
	else if (isNode(value)) {
		visit(value);
		Object.values(value).forEach(item => walk(item, visit));
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

// The component each design is built on.
const COMPONENT: Record<string, string> = {
	accordion: 'task:ProjectAccordion',
	'master-detail': 'task:ProjectMasterDetail',
	picker: 'task:ProjectPicker',
	cards: 'task:ProjectCards',
	flat: 'task:ProjectFlatTree',
};
const designs = variantNames.filter(name => name !== 'current');
const combinations = designs.flatMap(name =>
	alternatives(variants[name]!.view).map((tree, index) => [`${name}#${index}`, name, tree] as const)
);

describe('the generated tree-page.yaml', () => {
	it('is what the generator produces now (run "npm run views --workspace=packages/app-module-task" if not)', () => {
		expect(readFileSync(treePageFile(), 'utf8').replace(/\r\n/g, '\n')).toBe(generateTreePage());
	});

	it('has no YAML anchors or aliases', () => {
		expect(readFileSync(treePageFile(), 'utf8')).not.toMatch(/(^|\s)[&*][A-Za-z0-9_-]+(\s|$)/m);
	});
});

describe('the experiment', () => {
	it('is ONE AbTest, initial "current", the five designs in the agreed order, only on the global scope', () => {
		expect(nodesOf(sections).filter(s => s.$type === 'AbTest' && s.id === 'task-tree-design')).toHaveLength(1);
		expect(switcher.id).toBe('task-tree-design');
		expect(switcher.initial).toBe('current');
		expect(wrapper.$if).toBe('$sources.tree.groups');
		expect(switcher).not.toHaveProperty('$if');
		expect(variantNames).toEqual(['current', 'accordion', 'master-detail', 'picker', 'cards', 'flat']);
	});

	it('every variant says what it is (label and a real hint)', () => {
		for (const name of variantNames) {
			expect(variants[name]!.label.length, name).toBeGreaterThan(2);
			expect(variants[name]!.hint.length, name).toBeGreaterThan(20);
		}
	});

	it('option switchers are nested in their variant, named <variant>-<option>, with unique ids and 2-3 choices', () => {
		const ids = new Set<string>();
		for (const name of designs) {
			for (const node of nodesOf(variants[name]!.view).filter(n => n.$type === 'AbTest')) {
				const id = String(node.id);
				expect(id.startsWith(`${name}-`), id).toBe(true);
				expect(ids.has(id), `duplicate id ${id}`).toBe(false);
				ids.add(id);
				expect(Object.keys(node.variants as object).length, id).toBeGreaterThanOrEqual(2);
				expect(Object.keys(node.variants as object).length, id).toBeLessThanOrEqual(3);
			}
		}
		expect(ids.has('task-tree-design')).toBe(false);
	});
});

describe('current', () => {
	it('is the page as shipped: same sources, same nodes around the switcher, the groups slot inside it', () => {
		expect(page.$sources).toEqual(head.$sources);
		const rebuilt = sections.flatMap(section =>
			section === wrapper ? [{ ...(variants['current']!.view as Node), $if: wrapper.$if }] : [section]
		);
		expect(rebuilt).toEqual(head.sections);
	});
});

describe('every design, for every combination of its options', () => {
	it.each(combinations)(
		'%s: uses its component on the capped overview, nothing else of the data',
		(_label, name, tree) => {
			const used = nodesOf(tree).filter(n => String(n.$type).startsWith('task:') && n.$type !== 'AbTest');
			expect(used.map(n => n.$type)).toContain(COMPONENT[name]);
			const main = used.find(n => n.$type === COMPONENT[name])!;
			expect(main.projects).toBe('$sources.tree.overview.projects');
		}
	);

	it.each(combinations)('%s: has no back link and no source of its own', (_label, _name, tree) => {
		const text = stringsOf(tree).join('\n');
		expect(text).not.toMatch(/\b(back to|all projects$)/im);
		expect(nodesOf(tree).some(n => '$sources' in n || '$actions' in n)).toBe(false);
		// Any $sources reference stays on the sources the page declares.
		for (const match of text.matchAll(/\$sources\.(\w+)/g)) {
			expect(Object.keys(head.$sources as object)).toContain(match[1]);
		}
	});

	it.each(combinations)('%s: only known node types', (_label, _name, tree) => {
		const known = new Set([
			'VerticalStack',
			'HorizontalStack',
			'Section',
			'Badge',
			'ButtonLink',
			'ExtensionSlot',
			'DataTable',
		]);
		for (const node of nodesOf(tree)) {
			const type = String(node.$type ?? '');
			if (type === '') continue;
			expect(known.has(type) || type.startsWith('task:'), type).toBe(true);
		}
	});
});

describe('what stays outside the switcher (every variant inherits it)', () => {
	it('the failure, empty-registry, unknown and unreadable messages are page-level badges, not part of a variant', () => {
		const outside = stringsOf(sections.filter(s => s !== wrapper));
		for (const expected of [
			'$sources.tree.errorText',
			'$sources.projects.noProjectsText',
			'$sources.projects.unknownProjectText',
			'$sources.projects.selectedProblem',
			'$sources.tree.warning',
		]) {
			expect(outside, expected).toContain(expected);
		}
		for (const name of variantNames) {
			expect(stringsOf(variants[name]!.view), name).not.toContain('$sources.tree.errorText');
		}
	});

	it('the per-project table stays after the switcher, for the per-project scope', () => {
		const index = sections.indexOf(wrapper);
		const after = sections.slice(index + 1);
		expect(after.some(s => s.$type === 'DataTable' && s.$if === '$sources.tree.project')).toBe(true);
	});

	it('every request of the page keeps inlineErrors and the scope query', () => {
		const sources = page.$sources as Record<string, { url: string }>;
		expect(sources['tree']!.url).toContain('inlineErrors=true');
		expect(sources['tree']!.url).toContain('{query}');
	});
});
