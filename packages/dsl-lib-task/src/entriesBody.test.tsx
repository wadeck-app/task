import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, stubFetch } from './testHelpers.js';
import { InlineTextEntry, TaskPickerEntry } from './generated/entries.js';
import { configureTaskUi, resetTaskUiConfig } from './runtime-config.js';

/*
 * The new components send their value in a JSON body. Through the generated entry the page's ctx.onAction must receive
 * the RESOLVED params and the body, because the entry defaults onAction to pageActionHandler(ctx).
 */
beforeEach(() => configureTaskUi({ apiBase: '/api/modules/task' }));
afterEach(() => {
	resetTaskUiConfig();
	vi.unstubAllGlobals();
});

describe('entries of the components that send a body', () => {
	it('TaskPicker resolves its params and hands ctx.onAction the body', async () => {
		stubFetch(() =>
			jsonResponse([
				{ id: 'x1', headline: 'Pick me', status: 'todo', statusText: 'todo', tone: 'neutral', href: '/x' },
			])
		);
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(
			<React.Fragment>
				{TaskPickerEntry.render({
					node: {
						$type: 'TaskPicker',
						action: 'setParent',
						ariaLabel: 'Parent',
						params: { id: '$route.id' },
					},
					registry: {},
					ctx: { $route: { id: 'abc123' }, onAction },
				} as never)}
			</React.Fragment>
		);

		await userEvent.setup().click(screen.getByRole('combobox'));
		await userEvent.setup().click(await screen.findByRole('option'));

		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(onAction).toHaveBeenCalledWith('setParent', { id: 'abc123' }, { body: { target: 'x1' } });
	});

	it('InlineText sends the new text in the body', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(
			<React.Fragment>
				{InlineTextEntry.render({
					node: { $type: 'InlineText', value: 'old', action: 'setTitle', params: { id: '$route.id' } },
					registry: {},
					ctx: { $route: { id: 'abc123' }, onAction },
				} as never)}
			</React.Fragment>
		);
		const user = userEvent.setup();

		await user.click(screen.getByRole('button'));
		await user.clear(screen.getByRole('textbox'));
		await user.type(screen.getByRole('textbox'), 'new{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(onAction).toHaveBeenCalledWith('setTitle', { id: 'abc123' }, { body: { value: 'new' } });
	});
});
