import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ActionSelectEntry, LabelChipsEntry, SegmentedControlEntry } from './generated/entries.js';

/*
 * A view writes `params: { id: $route.id, projectParam: $sources.detail.projectParam }`. The action url is filled from
 * those values, so they must reach onAction RESOLVED: a literal `$route.id` produced POST /tasks/$route.id/status/...
 * in a real browser (the node must be resolved deeply, like dsl-ui ActionButton `@resolveDeep` params).
 */
// The page gives a handler per action name (what a Form's onSubmit calls); it publishes the resultKey. See compat/actions.ts.
const ctx = (handler: unknown): Record<string, unknown> => ({
	$route: { id: 'abc123' },
	// $sources.detail.x is ctx.detail.x in the renderer
	detail: { projectParam: 'p%201' },
	setStatusTo: handler,
	removeLabel: handler,
});
const params = { id: '$route.id', projectParam: '$sources.detail.projectParam' };

describe('the params of a component that runs an action', () => {
	it('ActionSelect runs the page handler of the action with the resolved params', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(
			<React.Fragment>
				{ActionSelectEntry.render({
					node: {
						$type: 'ActionSelect',
						options: [
							{ value: 'todo', label: 'todo' },
							{ value: 'done', label: 'done' },
						],
						value: 'todo',
						action: 'setStatusTo',
						valueParam: 'status',
						params,
					},
					registry: {},
					ctx: ctx(onAction),
				} as never)}
			</React.Fragment>
		);

		await userEvent.setup().selectOptions(screen.getByRole('combobox'), 'done');

		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(onAction).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'abc123', projectParam: 'p%201', status: 'done', statusEncoded: 'done' })
		);
	});

	it('LabelChips gives onAction the resolved params on removal', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(
			<React.Fragment>
				{LabelChipsEntry.render({
					node: { $type: 'LabelChips', labels: ['bug'], removeAction: 'removeLabel', params },
					registry: {},
					ctx: ctx(onAction),
				} as never)}
			</React.Fragment>
		);

		await userEvent.setup().click(screen.getByRole('button', { name: /bug/i }));

		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(onAction).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'abc123',
				projectParam: 'p%201',
				label: 'bug',
				labelEncoded: 'bug',
				labelKey: 'YnVn',
			})
		);
	});

	it('SegmentedControl gives onAction the resolved params', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(
			<React.Fragment>
				{SegmentedControlEntry.render({
					node: {
						$type: 'SegmentedControl',
						options: [
							{ value: 'todo', label: 'todo' },
							{ value: 'done', label: 'done' },
						],
						value: 'todo',
						action: 'setStatusTo',
						valueParam: 'status',
						params,
					},
					registry: {},
					ctx: ctx(onAction),
				} as never)}
			</React.Fragment>
		);

		await userEvent.setup().click(screen.getByRole('radio', { name: 'done' }));

		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(onAction).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'abc123', projectParam: 'p%201', status: 'done', statusEncoded: 'done' })
		);
	});
});
