import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CardLayoutEditor } from './CardLayoutEditor.js';
import type { CardLayoutEditorProps } from './CardLayoutEditor.js';
import type { BoardColumnData } from './boardModel.js';

const columns = (): BoardColumnData[] => [
	{
		key: 'Doing',
		label: 'Doing',
		statuses: [{ name: 'doing' }, { name: 'review' }],
		count: 3,
		cards: [
			{
				id: 'a1',
				headline: 'A very long title that goes on and on so that it needs more than one line to be read in full',
				status: 'doing',
				priority: 'low',
				priorityText: 'Low',
			},
			{
				id: 'a2',
				headline: 'Assigned and urgent',
				status: 'doing',
				priority: 'urgent',
				priorityText: 'Urgent',
				assignee: 'Ada Lovelace',
				createdAt: '2026-11-01T09:00:00.000Z',
			},
			{ id: 'a3', headline: 'A child', status: 'review', parentId: 'a1', statusSince: '2026-11-10T09:00:00.000Z' },
		],
	},
];

function setup(extra: Partial<CardLayoutEditorProps> = {}) {
	const props: CardLayoutEditorProps = {
		layout: undefined,
		columns: columns(),
		busy: false,
		error: null,
		onSave: vi.fn(),
		onReset: vi.fn(),
		onCancel: vi.fn(),
		...extra,
	};
	render(<CardLayoutEditor {...props} />);
	return props;
}

const rows = (): HTMLElement[] => screen.getAllByTestId('card-editor-row');
const order = (): string[] => rows().map(row => row.getAttribute('data-field')!);
const shown = (): string[] =>
	rows()
		.filter(row => row.getAttribute('data-shown') === 'true')
		.map(row => row.getAttribute('data-field')!);
const previews = (): HTMLElement[] => screen.getAllByTestId('kanban-card-preview');

describe('CardLayoutEditor', () => {
	it('lists all seven fields: the usual card shown first, the others hidden after', () => {
		setup();
		expect(order()).toEqual(['id', 'priority', 'assignee', 'status', 'created', 'statusSince', 'parent']);
		expect(shown()).toEqual(['id', 'priority', 'assignee', 'status']);
		expect(screen.getByRole('checkbox', { name: 'Show created' })).not.toBeChecked();
		expect(screen.getByRole('checkbox', { name: 'Show priority' })).toBeChecked();
	});

	it('shows three different cards in the preview, real ones first', () => {
		setup();
		expect(previews()).toHaveLength(3);
		expect(previews().map(card => card.getAttribute('data-card-id')).sort()).toEqual(['a1', 'a2', 'a3']);
		expect(screen.queryByText(/^Sample$/)).toBeNull();
		// The real cards are labelled with their id, not as samples.
		expect(screen.getByTestId('card-editor-preview')).toHaveTextContent('a2');
	});

	it('completes the preview with cards labelled Sample when the board has too few', () => {
		setup({ columns: columns().map(column => ({ ...column, cards: column.cards.slice(0, 1) })) });
		expect(previews()).toHaveLength(3);
		expect(screen.getAllByText('Sample')).toHaveLength(2);
	});

	it('the preview follows the draft: hiding the priority removes it from the three cards', async () => {
		const user = userEvent.setup();
		setup();
		expect(within(screen.getByTestId('card-editor-preview')).getAllByTestId('card-field-priority').length).toBeGreaterThan(0);
		await user.click(screen.getByRole('checkbox', { name: 'Show priority' }));
		expect(within(screen.getByTestId('card-editor-preview')).queryAllByTestId('card-field-priority')).toEqual([]);
		expect(shown()).toEqual(['id', 'assignee', 'status']);
		expect(order()[3]).toBe('priority');
	});

	it('showing a hidden field appends it to the shown ones and the preview draws it', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(screen.getByRole('checkbox', { name: 'Show parent' }));
		expect(shown()).toEqual(['id', 'priority', 'assignee', 'status', 'parent']);
		expect(within(screen.getByTestId('card-editor-preview')).getByTestId('card-field-parent')).toHaveTextContent('a1');
	});

	it('moves a field earlier or later with buttons, and says so in the live region', async () => {
		const user = userEvent.setup();
		setup();
		await user.click(screen.getByRole('button', { name: 'Move priority earlier' }));
		expect(shown()).toEqual(['priority', 'id', 'assignee', 'status']);
		expect(screen.getByTestId('card-editor-announce')).toHaveTextContent('Priority moved to position 1 of 4');
		await user.click(screen.getByRole('button', { name: 'Move priority later' }));
		expect(shown()).toEqual(['id', 'priority', 'assignee', 'status']);
		expect(screen.getByTestId('card-editor-announce')).toHaveTextContent('Priority moved to position 2 of 4');
	});

	it('the border moves are disabled, and so are those of a hidden field', () => {
		setup();
		expect(screen.getByRole('button', { name: 'Move id earlier' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Move status later' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Move created earlier' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Move created later' })).toBeDisabled();
	});

	it('keeps the keyboard focus on the moved row after a move', async () => {
		const user = userEvent.setup();
		setup();
		const button = screen.getByRole('button', { name: 'Move priority later' });
		button.focus();
		await user.keyboard('{Enter}');
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move priority later' }));
		// At the end of the list the later button is disabled: the focus goes to the earlier one of the same field.
		await user.keyboard('{Enter}');
		expect(shown()).toEqual(['id', 'assignee', 'status', 'priority']);
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move priority earlier' }));
	});

	it('offers a style only for the fields that have some, and the preview follows it', async () => {
		const user = userEvent.setup();
		setup();
		expect(screen.queryByRole('combobox', { name: 'Style of id' })).toBeNull();
		const select = screen.getByRole('combobox', { name: 'Style of assignee' });
		expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['Text', 'Initials']);
		await user.selectOptions(select, 'initials');
		const preview = within(screen.getByTestId('card-editor-preview'));
		expect(preview.getAllByTestId('card-field-assignee')[0]).toHaveAttribute('data-style', 'initials');
	});

	it('the style of a hidden field is disabled', () => {
		setup({ layout: { titleLines: 2, fields: [{ field: 'id', style: '' }] } });
		expect(screen.getByRole('combobox', { name: 'Style of priority' })).toBeDisabled();
		expect(screen.getByRole('combobox', { name: 'Style of priority' })).toHaveValue('pill');
		// A field with no style has no select, shown or not.
		expect(screen.queryByRole('combobox', { name: 'Style of created' })).toBeNull();
	});

	it('title lines: 1, 2 or 3, drawn in the preview', async () => {
		const user = userEvent.setup();
		setup();
		const select = screen.getByRole('combobox', { name: 'Title lines' });
		expect(select).toHaveValue('2');
		await user.selectOptions(select, '3');
		for (const title of within(screen.getByTestId('card-editor-preview')).getAllByTestId('kanban-card-title')) {
			expect(title).toHaveClass('line-clamp-3');
		}
	});

	it('Save sends the shown fields in order, the style only when not the default, and the title lines', async () => {
		const user = userEvent.setup();
		const props = setup();
		await user.selectOptions(screen.getByRole('combobox', { name: 'Style of assignee' }), 'initials');
		await user.click(screen.getByRole('checkbox', { name: 'Show id' }));
		await user.click(screen.getByRole('checkbox', { name: 'Show created' }));
		await user.selectOptions(screen.getByRole('combobox', { name: 'Title lines' }), '1');
		await user.click(screen.getByRole('button', { name: 'Save' }));
		expect(props.onSave).toHaveBeenCalledWith({
			titleLines: 1,
			fields: [{ field: 'priority' }, { field: 'assignee', style: 'initials' }, { field: 'status' }, { field: 'created' }],
		});
	});

	it('every field hidden is valid: it saves a title-only card', async () => {
		const user = userEvent.setup();
		const props = setup();
		for (const field of ['id', 'priority', 'assignee', 'status']) {
			await user.click(screen.getByRole('checkbox', { name: `Show ${field}` }));
		}
		await user.click(screen.getByRole('button', { name: 'Save' }));
		expect(props.onSave).toHaveBeenCalledWith({ titleLines: 2, fields: [] });
	});

	it('starts from the stored layout', () => {
		setup({
			layout: {
				titleLines: 3,
				fields: [
					{ field: 'parent', style: '' },
					{ field: 'priority', style: 'dot' },
				],
			},
		});
		expect(shown()).toEqual(['parent', 'priority']);
		expect(screen.getByRole('combobox', { name: 'Title lines' })).toHaveValue('3');
		expect(screen.getByRole('combobox', { name: 'Style of priority' })).toHaveValue('dot');
	});

	it('Reset to the usual card calls onReset, and is disabled when the card is already the usual one', async () => {
		const user = userEvent.setup();
		const first = setup();
		expect(screen.getByRole('button', { name: 'Reset to the usual card' })).toBeDisabled();
		expect(first.onReset).not.toHaveBeenCalled();
		cleanup();
		const props = setup({ layout: { titleLines: 1, fields: [] } });
		await user.click(screen.getByRole('button', { name: 'Reset to the usual card' }));
		expect(props.onReset).toHaveBeenCalledTimes(1);
	});

	it('Cancel calls onCancel', async () => {
		const user = userEvent.setup();
		const props = setup();
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(props.onCancel).toHaveBeenCalledTimes(1);
	});

	it('shows the refused save as an alert, with the text it was given', () => {
		setup({ error: 'The cards were not saved: board.card.fields[0].style: "huge" is not a style of priority. Valid: pill, text, dot.' });
		expect(screen.getByRole('alert')).toHaveTextContent('"huge" is not a style of priority');
	});

	it('disables every control and says Saving while it saves', () => {
		setup({ busy: true });
		expect(screen.getByRole('button', { name: 'Saving' })).toBeDisabled();
		expect(screen.getByRole('checkbox', { name: 'Show priority' })).toBeDisabled();
		expect(screen.getByRole('combobox', { name: 'Title lines' })).toBeDisabled();
	});

	it('explains the status Auto style and that a preview card can be a sample', () => {
		setup();
		expect(screen.getByTestId('card-editor')).toHaveTextContent('Auto shows the status only in a column that holds several statuses.');
	});
});
