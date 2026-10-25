import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

/*
 * The installed shell (app-core-cli 094, dsl-renderer 175) does not export coerceProp, resolveExpressionsDeep,
 * coerceDate, coerceStringList. A strict mock of the renderer without them stands for it: the generated entries must
 * still render, because they take those helpers from compat/dslRenderer.ts.
 */
vi.mock('@wadeck-app/dsl-renderer', async importOriginal => {
	const actual = await importOriginal<Record<string, unknown>>();
	const { coerceProp: _a, resolveExpressionsDeep: _b, coerceDate: _c, coerceStringList: _d, ...older } = actual;
	return older;
});

describe('the generated entries on a renderer without the coercion helpers', () => {
	it('render a component whose props go through coerceProp', async () => {
		const { StatusBadgeEntry, LabelChipsEntry } = await import('../generated/entries.js');

		render(
			<React.Fragment>
				{StatusBadgeEntry.render({
					node: { $type: 'StatusBadge', label: 'done', tone: 'success' },
					registry: {},
					ctx: {},
				} as never)}
				{LabelChipsEntry.render({
					node: { $type: 'LabelChips', labels: ['bug'], readOnly: true },
					registry: {},
					ctx: {},
				} as never)}
			</React.Fragment>
		);

		expect(screen.getByTestId('status-badge')).toHaveTextContent('done');
		expect(screen.getByText('bug')).toBeInTheDocument();
	});

	it('still ignore a value of the wrong kind instead of crashing', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { StatusBadgeEntry } = await import('../generated/entries.js');

		render(
			<React.Fragment>
				{StatusBadgeEntry.render({
					node: { $type: 'StatusBadge', label: { oops: 1 } },
					registry: {},
					ctx: {},
				} as never)}
			</React.Fragment>
		);

		expect(screen.getByTestId('status-badge')).toHaveTextContent('');
	});
});
