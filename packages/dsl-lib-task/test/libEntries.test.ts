// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTaskLibEntries } from '../src/index.js';
import { LIB_ENTRIES, SRC_DIR } from '../scripts/paths.js';

/*
 * The component names the module registers as "task:<name>". Frozen here on purpose: adding or dropping a component
 * changes every view's contract with the shell, so it must be a visible edit.
 */
// @formatter:off
const EXPECTED = [
	'ActionSelect',
	'BreadcrumbTrail',
	'ChipRow',
	'KeyValueList',
	'LabelChips',
	'Notice',
	'Panel',
	'ProgressSummary',
	'PropertyList',
	'PropertyRow',
	'SegmentedControl',
	'SplitLayout',
	'StatusBadge',
	'TabPanels',
	'TaskRowList',
	'Timeline',
	'VariantSwitcher',
];
// @formatter:on

describe('createTaskLibEntries', () => {
	const entries = createTaskLibEntries({ apiBase: '/api/modules/task', routeBase: '/modules/task' });

	it('exports exactly the components the module ships', () => {
		expect(entries.map(e => e.name).sort()).toEqual(EXPECTED);
	});

	it('matches the components imported by the generated entries, so the list in index.ts cannot go stale', () => {
		const imported = [
			...fs.readFileSync(LIB_ENTRIES, 'utf8').matchAll(/from\s+'\.\.\/components\/(\w+)\.js'/g),
		].map(m => m[1]);
		expect(entries.map(e => e.name).sort()).toEqual(imported.sort());
	});

	it('has a source file with a @registryCategory tag for every component, and no component file the entries miss', () => {
		const dir = path.join(SRC_DIR, 'components');
		const sources = fs.readdirSync(dir).filter(f => /^[A-Z]\w+\.tsx$/.test(f) && !f.endsWith('.test.tsx'));
		const tagged = sources.filter(f => fs.readFileSync(path.join(dir, f), 'utf8').includes('@registryCategory'));
		expect(tagged.map(f => f.replace('.tsx', '')).sort()).toEqual(EXPECTED);
		expect(sources, 'a component file without @registryCategory is not registered').toHaveLength(tagged.length);
	});

	it('declares the keys of each component, so a misspelt key in a view is reported', () => {
		for (const entry of entries) {
			expect(entry.knownKeys?.length, `${entry.name} has no knownKeys`).toBeGreaterThan(0);
		}
	});
});
