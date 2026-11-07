import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

/*
 * The Tree page (src/dsl-views/tree-page.yaml, hand-written). With several projects it is an accordion
 * (task:ProjectAccordion over `projects` of GET /tree?allProjects=true); with one project, or per project, a table.
 * The A/B experiment that chose the accordion is gone: nothing here generates the page.
 */

type Node = Record<string, unknown>;
const file = join(import.meta.dirname, '..', 'dsl-views', 'tree-page.yaml');
const text = readFileSync(file, 'utf8');
const page = yaml.load(text) as Node;
const sections = page.sections as Node[];
const sources = page.$sources as Record<string, { url: string; params?: Record<string, string> }>;

const isNode = (value: unknown): value is Node => value !== null && typeof value === 'object' && !Array.isArray(value);
function nodesOf(value: unknown, found: Node[] = []): Node[] {
	if (Array.isArray(value)) value.forEach(item => nodesOf(item, found));
	else if (isNode(value)) {
		found.push(value);
		Object.values(value).forEach(item => nodesOf(item, found));
	}
	return found;
}
function stringsOf(value: unknown, found: string[] = []): string[] {
	if (typeof value === 'string') found.push(value);
	else if (Array.isArray(value)) value.forEach(item => stringsOf(item, found));
	else if (isNode(value)) Object.values(value).forEach(item => stringsOf(item, found));
	return found;
}

describe('tree-page.yaml', () => {
	it('is plain hand-written YAML: no generated marker, no anchors, no A/B switcher', () => {
		expect(text).not.toMatch(/GENERATED/);
		expect(text).not.toMatch(/(^|\s)[&*][A-Za-z0-9_-]+(\s|$)/m);
		expect(nodesOf(page).some(node => node.$type === 'AbTest' || node.$experiment !== undefined)).toBe(false);
	});

	it('renders the global scope as ONE accordion over the projects of the answer, guarded by that list', () => {
		const accordions = nodesOf(sections).filter(node => node.$type === 'task:ProjectAccordion');
		expect(accordions).toHaveLength(1);
		expect(accordions[0]).toEqual({ $type: 'task:ProjectAccordion', projects: '$sources.tree.projects' });
		// The `$if` sits on a stack around the component: on the component itself nothing renders while the list is absent.
		const holder = sections.find(section => nodesOf(section).includes(accordions[0]!))!;
		expect(holder.$type).toBe('VerticalStack');
		expect(holder.$if).toBe('$sources.tree.projects');
	});

	it('reads nothing of the removed designs (groups, overview, the other components)', () => {
		const all = stringsOf(sections).join('\n');
		expect(all).not.toMatch(/\.groups|\.overview/);
		expect(all).not.toMatch(/task:Project(MasterDetail|Picker|Cards|FlatTree)/);
	});

	it('keeps the per-project table after the accordion, for the per-project scope', () => {
		const table = sections.find(section => section.$type === 'DataTable')!;
		expect(table.$if).toBe('$sources.tree.project');
		expect(table.rows).toBe('$sources.tree.rows');
		expect(table.navigateTo).toBe('{href}');
		expect(sections.indexOf(table)).toBeGreaterThan(
			sections.findIndex(section => nodesOf(section).some(node => node.$type === 'task:ProjectAccordion'))
		);
	});

	it('keeps the task:project-header slot on the per-project address', () => {
		expect(sources['projectHeader']!.url).toBe('GET /api/slots/task:project-header');
		const chips = sections.find(section => section.$type === 'task:ChipRow')!;
		expect(chips.$if).toBe('$route.project');
		expect(nodesOf(chips).some(node => node.items === '$sources.projectHeader')).toBe(true);
	});

	it('every request keeps inlineErrors, and the tree has ONE source fed by scopeQuery (blank=true for an unknown project)', () => {
		expect(sources['tree']!.url).toContain('inlineErrors=true');
		expect(sources['tree']!.url).toContain('{query}');
		expect(sources['tree']!.params?.['query']).toBe('$source.projects.scopeQuery');
		// A source that waits for `projects` also names a $urlParam, else the shell leaves it stale on a link.
		expect(sources['tree']!.params?.['reload']).toBe('$urlParam.reload');
	});

	it('shows every message of the answer as a page-level badge, the unreadable summary as a warning', () => {
		const badges = sections.filter(section => section.$type === 'Badge');
		const bound = (field: string): Node | undefined => badges.find(badge => badge.label === field);
		// label -> the field its `$if` tests (the welcome text is shown when the registry is empty).
		const guards: Record<string, string> = {
			'$sources.tree.errorText': '$sources.tree.errorText',
			'$sources.projects.noProjectsText': '$sources.projects.noProjects',
			'$sources.projects.unknownProjectText': '$sources.projects.unknownProjectText',
			'$sources.projects.selectedProblem': '$sources.projects.selectedProblem',
			'$sources.tree.scopeText': '$sources.tree.scopeText',
		};
		for (const [field, guard] of Object.entries(guards)) {
			expect(bound(field), field).toBeDefined();
			expect(bound(field)!.$if, field).toBe(guard);
		}
		expect(bound('$sources.tree.warning')).toMatchObject({ $if: '$sources.tree.warning', variant: 'warning' });
		expect(badges.filter(badge => badge.label === '$sources.tree.warning')).toHaveLength(1);
	});

	it('the warning sits above the list but is only a summary: the reasons are in the list, not here', () => {
		const order = sections.map(section => (section.label as string | undefined) ?? String(section.$type));
		expect(order.indexOf('$sources.tree.warning')).toBeLessThan(order.indexOf('VerticalStack'));
	});

	it('has no back link, and every $sources reference names a source the page declares', () => {
		const all = stringsOf(sections).join('\n');
		expect(all).not.toMatch(/\b(back to|all projects$)/im);
		for (const match of all.matchAll(/\$sources\.(\w+)/g)) {
			expect(Object.keys(sources)).toContain(match[1]);
		}
	});

	it('uses only node types the shell knows', () => {
		const known = new Set(['PageHeader', 'ButtonLink', 'Badge', 'ExtensionSlot', 'DataTable', 'VerticalStack']);
		for (const node of nodesOf(sections)) {
			const type = String(node.$type ?? '');
			if (type === '') continue;
			expect(known.has(type) || type.startsWith('task:'), type).toBe(true);
		}
	});
});
