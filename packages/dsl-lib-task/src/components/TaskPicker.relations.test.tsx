import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, stubFetch } from '../testHelpers.js';
import { resetReported } from '../reportOnce.js';
import { configureTaskUi, resetTaskUiConfig } from '../runtime-config.js';
import { CONTROL_H } from '../ui/tokens.js';
import { TaskPicker } from './TaskPicker.js';

const ROWS = [{ id: 'aaaa1111', headline: 'Fix login loop', status: 'todo', statusText: 'todo', tone: 'neutral' }];
const CHOICES = [
	{ value: 'blockedBy', label: 'Blocked by' },
	{ value: 'blocks', label: 'Blocks' },
	{ value: 'duplicateOf', label: 'Duplicate of' },
];

beforeEach(() => configureTaskUi({ apiBase: '/api/modules/task' }));
afterEach(() => {
	resetTaskUiConfig();
	resetReported();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function setup(props: Partial<React.ComponentProps<typeof TaskPicker>> = {}) {
	stubFetch(() => jsonResponse(ROWS));
	const onAction = vi.fn().mockResolvedValue(undefined);
	render(
		<TaskPicker
			action="addLink"
			params={{ id: 't1' }}
			projectParam="p1"
			choices={CHOICES}
			choiceKey="type"
			choiceLabel="Relation"
			ariaLabel="Task to link"
			onAction={onAction}
			{...props}
		/>
	);
	return onAction;
}

describe('TaskPicker relation choices with icons', () => {
	it('draws one radio button per relation, each with an icon; the first is checked', () => {
		setup({ choiceStyle: 'icons', heading: 'Link to another task' });

		const group = screen.getByRole('radiogroup', { name: 'Relation' });
		const radios = screen.getAllByRole('radio');
		expect(radios.map(r => r.textContent)).toEqual(['Blocked by', 'Blocks', 'Duplicate of']);
		for (const radio of radios) {
			expect(radio.querySelector('svg')).not.toBeNull();
			expect(radio.className).toContain(CONTROL_H);
		}
		expect(radios[0]).toHaveAttribute('aria-checked', 'true');
		expect(group.querySelector('select')).toBeNull();
		expect(screen.getByText('Link to another task')).toBeInTheDocument();
	});

	it('the chosen relation travels with the picked task', async () => {
		const user = userEvent.setup();
		const onAction = setup({ choiceStyle: 'icons' });

		await user.click(screen.getByRole('radio', { name: 'Duplicate of' }));
		expect(screen.getByRole('radio', { name: 'Duplicate of' })).toHaveAttribute('aria-checked', 'true');
		expect(screen.getByRole('radio', { name: 'Blocked by' })).toHaveAttribute('aria-checked', 'false');
		await user.click(screen.getByRole('combobox', { name: 'Task to link' }));
		await user.click(await screen.findByRole('option', { name: /Fix login loop/ }));

		await waitFor(() =>
			expect(onAction).toHaveBeenCalledWith(
				'addLink',
				{ id: 't1' },
				{ body: { target: 'aaaa1111', type: 'duplicateOf' } }
			)
		);
	});
});

describe('TaskPicker row layout', () => {
	it('puts the relation select (with the icon of the chosen relation) and the search on ONE flex row', async () => {
		const user = userEvent.setup();
		setup({ layout: 'row' });

		const select = screen.getByRole('combobox', { name: 'Relation' });
		const search = screen.getByRole('combobox', { name: 'Task to link' });
		expect(select.parentElement!.parentElement).toBe(search.parentElement!.parentElement);
		expect(select.parentElement!.parentElement!.className).toContain('flex-wrap');
		expect(screen.getByTestId('task-picker-choice-icon')).toBeInTheDocument();
		expect(select.className).toContain(CONTROL_H);
		expect(search.className).toContain(CONTROL_H);

		await user.selectOptions(select, 'blocks');
		expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Relation' }).value).toBe('blocks');
	});

	it('the stack layout (default) keeps the select above the search', () => {
		setup();

		const select = screen.getByRole('combobox', { name: 'Relation' });
		expect(screen.queryByTestId('task-picker-choice-icon')).toBeNull();
		expect(select.className).toContain('w-full');
	});
});
