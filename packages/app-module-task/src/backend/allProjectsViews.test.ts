import { describe, it, expect } from 'vitest';
import type { ProjectOverview } from '@wadeck-app/task-service';

import { projectRows, WIDGET_LABEL_MAX } from './allProjectsViews.js';

function project(name: string, extra: Partial<ProjectOverview> = {}): ProjectOverview {
	return {
		id: 'abcd1234',
		name,
		path: `/work/${name}`,
		exists: true,
		open: 2,
		total: 5,
		byStatus: [],
		error: null,
		...extra,
	};
}

describe('projectRows: the label of the narrow dashboard widget (3 cells, about 300px of table)', () => {
	it('keeps a readable name that fits as it is, with the name as tooltip', () => {
		const [row] = projectRows([project('platform-redesign-2026')]);
		expect(row).toMatchObject({ label: 'platform-redesign-2026', labelTitle: 'platform-redesign-2026' });
	});

	it('cuts a longer name with an ellipsis at the limit, the tooltip keeps the full name', () => {
		const name = 'customer-onboarding-and-billing-platform';
		const [row] = projectRows([project(name)]);
		expect(String(row?.['label']).length).toBe(WIDGET_LABEL_MAX);
		expect(row?.['label']).toBe(`${name.slice(0, WIDGET_LABEL_MAX - 1)}…`);
		expect(row?.['labelTitle']).toBe(name);
	});

	it('an unreadable project keeps its gist inside the limit (the name gives way), the tooltip names the full reason', () => {
		const error =
			"layer 'x/config.yml': key 'nonsense_key' is not declared. Fix the config.yml named in the message.";
		const [row] = projectRows([project('broken-config-project', { error, open: null, total: null })]);
		expect(String(row?.['label']).length).toBeLessThanOrEqual(WIDGET_LABEL_MAX);
		expect(row?.['label']).toMatch(/…? \(invalid config\)$/);
		expect(row?.['labelTitle']).toBe(`broken-config-project: ${error}`);
		expect(row).toMatchObject({ openText: '-', totalText: '-', href: null, problem: error });
	});

	it('a short unreadable name is shown whole with its gist', () => {
		const [row] = projectRows([project('old', { error: 'x', exists: false, open: null, total: null })]);
		expect(row?.['label']).toBe('old (missing)');
	});
});
