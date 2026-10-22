import { literal, projectTasksSection } from './dslNodes.js';

describe('literal', () => {
	it('leaves a text that cannot be read as an expression alone', () => {
		expect(literal('alpha')).toBe('alpha');
		expect(literal('')).toBe('');
		expect(literal('cost in $')).toBe('cost in $');
	});

	it('puts a zero-width space in front of a text starting with "$", which the renderer would evaluate otherwise', () => {
		const shown = literal('$sources.projects');
		expect(shown.startsWith('$')).toBe(false);
		expect(shown.replace(String.fromCodePoint(0x200b), '')).toBe('$sources.projects');
	});
});

describe('projectTasksSection', () => {
	const section = projectTasksSection({
		title: 'alpha (1 task)',
		linkLabel: 'Open the tree of alpha',
		linkTo: '/modules/task/tree?project=x',
		rows: [{ id: 'a1', label: 'one', status: 'backlog', href: '/h' }],
		emptyMessage: 'No open tasks',
	});

	// Types the shell registers: another one would show "Unknown component type" in the page.
	it('uses only Section, ButtonLink and DataTable', () => {
		const types: string[] = [];
		const visit = (node: unknown): void => {
			if (Array.isArray(node)) return node.forEach(visit);
			if (node === null || typeof node !== 'object') return;
			const record = node as Record<string, unknown>;
			if (typeof record['$type'] === 'string') types.push(record['$type']);
			if (Array.isArray(record['items'])) visit(record['items']);
		};
		visit(section);
		expect(types).toEqual(['Section', 'ButtonLink', 'DataTable']);
	});

	it('gives the table a row click through the href of each row, and a column per label/id/status', () => {
		const table = (section['items'] as Record<string, unknown>[])[1]!;
		expect(table['navigateTo']).toBe('{href}');
		expect((table['columns'] as { key: string }[]).map(column => column.key)).toEqual(['label', 'id', 'status']);
	});
});
