import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, stubFetch } from '../testHelpers.js';
import { resetReported } from '../reportOnce.js';
import { configureTaskUi, resetTaskUiConfig } from '../runtime-config.js';
import { PropertyPopover } from './PropertyPopover.js';
import { TaskPicker } from './TaskPicker.js';

beforeEach(() => configureTaskUi({ apiBase: '/api/modules/task' }));
afterEach(() => {
	resetTaskUiConfig();
	resetReported();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const ROWS = [
	{ id: 'aaaa1111', headline: 'Fix login loop', status: 'todo', statusText: 'todo', tone: 'neutral' },
	{ id: 'bbbb2222', headline: 'Write docs', status: 'todo', statusText: 'todo', tone: 'neutral' },
];

function follows(first: Element, second: Element): boolean {
	return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('TaskPicker layout: results never cover what is typed', () => {
	it('draws the results in the flow after the input, never absolutely positioned over it', async () => {
		stubFetch(() => jsonResponse(ROWS));
		render(<TaskPicker action="setParent" ariaLabel="Parent" onAction={vi.fn()} />);
		const user = userEvent.setup();
		const input = screen.getByRole('combobox', { name: 'Parent' });

		await user.type(input, 'fix');
		const popup = await screen.findByTestId('task-picker-popup');
		await screen.findByRole('option', { name: /Fix login loop/ });

		expect(follows(input, popup)).toBe(true);
		expect(follows(input, screen.getByRole('listbox'))).toBe(true);
		expect(popup.className).not.toMatch(/\babsolute\b/);
		expect(popup.className).not.toMatch(/\bfixed\b/);
		expect(input).toHaveValue('fix');
		expect(input).toBeVisible();
	});

	it('shows "No match" below the input and keeps the typed text readable', async () => {
		stubFetch(() => jsonResponse([]));
		render(<TaskPicker action="setParent" ariaLabel="Parent" onAction={vi.fn()} />);
		const user = userEvent.setup();
		const input = screen.getByRole('combobox', { name: 'Parent' });

		await user.type(input, 'asd');
		const status = await screen.findByRole('status');

		expect(status).toHaveTextContent('No match for "asd"');
		expect(follows(input, status)).toBe(true);
		expect(input).toHaveValue('asd');
	});

	it('shows the loading rows below the input as well', async () => {
		stubFetch(() => new Promise<Response>(() => undefined));
		render(<TaskPicker action="setParent" ariaLabel="Parent" onAction={vi.fn()} />);
		const user = userEvent.setup();
		const input = screen.getByRole('combobox', { name: 'Parent' });

		await user.click(input);

		const rows = await screen.findAllByTestId('task-picker-skeleton');
		expect(follows(input, rows[0]!)).toBe(true);
	});

	it('keeps the input pinned on top of the popover while the results scroll', async () => {
		stubFetch(() => jsonResponse(ROWS));
		render(<TaskPicker action="setParent" ariaLabel="Parent" onAction={vi.fn()} />);
		await userEvent.setup().click(screen.getByRole('combobox', { name: 'Parent' }));

		expect(screen.getByTestId('task-picker-search').className).toMatch(/\bsticky\b/);
		expect(screen.getByTestId('task-picker-search').className).toMatch(/\btop-0\b/);
	});

	it('keyboard flow: type, ArrowDown, Enter picks; focus never leaves the input', async () => {
		stubFetch(() => jsonResponse(ROWS));
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(<TaskPicker action="setParent" params={{ id: 't1' }} ariaLabel="Parent" onAction={onAction} />);
		const user = userEvent.setup();
		const input = screen.getByRole('combobox', { name: 'Parent' });

		await user.type(input, 'w');
		await screen.findByRole('option', { name: /Write docs/ });
		await user.keyboard('{ArrowDown}');
		expect(input).toHaveFocus();
		await user.keyboard('{Enter}');

		await waitFor(() =>
			expect(onAction).toHaveBeenCalledWith('setParent', { id: 't1' }, { body: { target: 'bbbb2222' } })
		);
	});

	it('inside a PropertyPopover the search input has the focus as soon as the popover opens, so typing lands in it', async () => {
		stubFetch(() => jsonResponse([]));
		render(
			<PropertyPopover
				label="Parent"
				valueText="none"
				items={<TaskPicker action="setParent" ariaLabel="Find parent" onAction={vi.fn()} />}
			/>
		);
		const user = userEvent.setup();

		await user.click(screen.getByRole('button', { name: 'Parent: none' }));
		expect(screen.getByRole('combobox', { name: 'Find parent' })).toHaveFocus();
		await user.keyboard('asd');

		expect(screen.getByRole('combobox', { name: 'Find parent' })).toHaveValue('asd');
		expect(await screen.findByRole('status')).toHaveTextContent('No match for "asd"');
	});

	it('inside a PropertyPopover the panel contains the input and its results, and scrolls instead of clipping', async () => {
		stubFetch(() => jsonResponse(ROWS));
		render(
			<PropertyPopover
				label="Parent"
				valueText="none"
				items={<TaskPicker action="setParent" ariaLabel="Find parent" onAction={vi.fn()} />}
			/>
		);
		const user = userEvent.setup();

		await user.click(screen.getByRole('button', { name: 'Parent: none' }));
		const input = screen.getByRole('combobox', { name: 'Find parent' });
		await user.type(input, 'fix');
		const popup = await screen.findByTestId('task-picker-popup');
		const panel = screen.getByTestId('property-popover-panel');

		expect(panel).toContainElement(input);
		expect(panel).toContainElement(popup);
		expect(panel.className).toMatch(/overflow-y-auto/);
		expect(panel.className).toMatch(/max-h-/);
		// The panel is a bottom sheet on narrow screens.
		expect(panel.className).toMatch(/max-sm:fixed/);
		expect(panel.className).toMatch(/max-sm:bottom-0/);
	});
});
