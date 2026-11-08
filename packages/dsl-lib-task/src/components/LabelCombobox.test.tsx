import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, jsonResponse, stubFetch } from '../testHelpers.js';
import { resetReported } from '../reportOnce.js';
import { configureTaskUi, resetTaskUiConfig } from '../runtime-config.js';
import { LabelCombobox } from './LabelCombobox.js';

const COUNTS = [
	{ label: 'billing', count: 7 },
	{ label: 'bug', count: 12 },
	{ label: 'ui', count: 3 },
	{ label: 'backend', count: 1 },
];

beforeEach(() => configureTaskUi({ apiBase: '/api/modules/task' }));
afterEach(() => {
	resetTaskUiConfig();
	resetReported();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function setup(
	props: Partial<React.ComponentProps<typeof LabelCombobox>> = {},
	answer: Response | (() => Response) = jsonResponse(COUNTS)
) {
	const fetchStub = stubFetch(() => (typeof answer === 'function' ? answer() : answer.clone()));
	const onAction = vi.fn().mockResolvedValue(undefined);
	const utils = render(
		<LabelCombobox
			labels={['ui']}
			addAction="addLabel"
			removeAction="removeLabel"
			params={{ id: 't1' }}
			projectParam="p1"
			onAction={onAction}
			{...props}
		/>
	);
	return { ...fetchStub, onAction, ...utils };
}

/** Clicks the "+ Add" chip and returns the input of its popover. */
async function openAdd(user: ReturnType<typeof userEvent.setup>): Promise<HTMLInputElement> {
	await user.click(screen.getByRole('button', { name: 'Add label' }));
	return screen.getByRole('combobox') as HTMLInputElement;
}

describe('LabelCombobox', () => {
	it('draws one chip per label and removes one through the key route, like LabelChips', async () => {
		const { onAction } = setup({ labels: ['ui', 'a/b'] });

		expect(screen.getAllByTestId('label-chip')).toHaveLength(2);
		await userEvent.setup().click(screen.getByRole('button', { name: 'Remove label a/b' }));

		expect(onAction).toHaveBeenCalledWith('removeLabel', {
			id: 't1',
			label: 'a/b',
			labelKey: Buffer.from('a/b', 'utf8').toString('base64url'),
		});
	});

	it('shows a "+ Add" chip, not an input; the popover opens on click with a named, focused combobox', async () => {
		setup();

		expect(screen.queryByRole('combobox')).toBeNull();
		const input = await openAdd(userEvent.setup());

		expect(input).toHaveAccessibleName('Add a label');
		expect(input).toHaveFocus();
		expect(input).toHaveAttribute('aria-autocomplete', 'list');
		expect(screen.getByRole('dialog', { name: 'Add label' })).toContainElement(input);
	});

	it('does not fetch before the popover opens, then loads the project labels with their count, without the current labels', async () => {
		const { calls } = setup();
		expect(calls).toHaveLength(0);

		await openAdd(userEvent.setup());

		const options = await screen.findAllByRole('option');
		expect(calls[0]!.url.pathname).toBe('/api/modules/task/labels');
		expect(calls[0]!.url.searchParams.get('project')).toBe('p1');
		expect(options.map(o => o.textContent)).toEqual([
			expect.stringContaining('bug'),
			expect.stringContaining('billing'),
			expect.stringContaining('backend'),
		]);
		expect(options[0]).toHaveTextContent('12');
		expect(screen.queryByRole('option', { name: /\bui\b/ })).toBeNull();
	});

	it('draws the suggestions BELOW the input, in the flow', async () => {
		setup();

		const input = await openAdd(userEvent.setup());
		const list = await screen.findByRole('listbox');

		expect(input.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.getByTestId('suggest-results').className).not.toMatch(/\babsolute\b/);
	});

	it('shows skeleton rows while the labels load', async () => {
		const gate = deferred<Response>();
		stubFetch(() => gate.promise);
		render(<LabelCombobox labels={[]} addAction="a" onAction={vi.fn()} />);

		await openAdd(userEvent.setup());

		expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'true');
		expect(screen.getAllByTestId('suggest-skeleton').length).toBeGreaterThan(0);
		await act(async () => gate.resolve(jsonResponse(COUNTS)));
		await screen.findAllByRole('option');
	});

	it('uses the suggestions prop and does not fetch', async () => {
		const { calls } = setup({ suggestions: [{ label: 'x1', count: 2 }] });

		await openAdd(userEvent.setup());

		expect(await screen.findByRole('option', { name: /x1/ })).toBeInTheDocument();
		expect(calls).toHaveLength(0);
	});

	it('filters as you type, case-insensitively, prefix matches first', async () => {
		setup();
		const user = userEvent.setup();
		const input = await openAdd(user);
		await screen.findAllByRole('option');

		await user.type(input, 'B');

		const names = screen.getAllByRole('option').map(o => o.textContent ?? '');
		expect(names[0]).toContain('bug');
		expect(names.some(n => n.includes('billing'))).toBe(true);
		expect(names.some(n => n.includes('Create'))).toBe(true);
	});

	it('creates the typed label on Enter when nothing matches, label in the body, and closes', async () => {
		const { onAction } = setup();
		const user = userEvent.setup();
		const input = await openAdd(user);
		await screen.findAllByRole('option');

		await user.type(input, 'brand new{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
		expect(onAction).toHaveBeenCalledWith('addLabel', { id: 't1' }, { body: { label: 'brand new' } });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});

	it('Enter on a typed prefix with no highlight adds the first suggestion, not the raw prefix ("bil" must not create "bil" while "billing" exists)', async () => {
		const { onAction } = setup();
		const user = userEvent.setup();
		const input = await openAdd(user);
		await screen.findAllByRole('option');

		await user.type(input, 'bil{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
		expect(onAction.mock.calls[0]![2]).toEqual({ body: { label: 'billing' } });
	});

	it('the raw text is still created by moving to the Create row (ArrowDown past the suggestions)', async () => {
		const { onAction } = setup();
		const user = userEvent.setup();
		const input = await openAdd(user);
		await screen.findAllByRole('option');

		await user.type(input, 'bil');
		const rows = screen.getAllByRole('option');
		const create = rows.length - 1;
		expect(rows[create]).toHaveTextContent('Create "bil"');
		for (let step = 0; step <= create; step++) await user.keyboard('{ArrowDown}');
		await user.keyboard('{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
		expect(onAction.mock.calls[0]![2]).toEqual({ body: { label: 'bil' } });
	});

	it('adds the highlighted suggestion on Enter', async () => {
		const { onAction } = setup();
		const user = userEvent.setup();
		const input = await openAdd(user);
		await screen.findAllByRole('option');

		await user.type(input, 'b{ArrowDown}{ArrowDown}');
		expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1]!.id);
		await user.keyboard('{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(onAction.mock.calls[0]![2]).toEqual({ body: { label: 'billing' } });
	});

	it('adds a suggestion with a click', async () => {
		const { onAction } = setup();
		const user = userEvent.setup();
		await openAdd(user);

		await user.click(await screen.findByRole('option', { name: /backend/ }));

		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(onAction.mock.calls[0]![2]).toEqual({ body: { label: 'backend' } });
	});

	it('offers a Create row only when no label matches exactly, and uses the existing casing on an exact match', async () => {
		const { onAction } = setup();
		const user = userEvent.setup();
		const input = await openAdd(user);
		await screen.findAllByRole('option');

		await user.type(input, 'nothing');
		expect(screen.getByRole('option', { name: /Create "nothing"/ })).toBeInTheDocument();
		await user.clear(input);
		await user.type(input, 'BILLING');
		expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
		await user.keyboard('{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(onAction.mock.calls[0]![2]).toEqual({ body: { label: 'billing' } });
	});

	it('refuses a label the task already has, whatever the case, and says so', async () => {
		const { onAction } = setup();
		const user = userEvent.setup();
		const input = await openAdd(user);
		await user.type(input, 'UI{Enter}');

		expect(await screen.findByRole('alert')).toHaveTextContent('already has the label "UI"');
		expect(onAction).not.toHaveBeenCalled();
	});

	it('submits once on a double Enter and on Enter followed by a blur', async () => {
		const gate = deferred<void>();
		const onAction = vi.fn().mockReturnValue(gate.promise);
		setup({ onAction });
		const user = userEvent.setup();
		const input = await openAdd(user);
		await user.type(input, 'zed');

		await user.keyboard('{Enter}{Enter}');
		fireEvent.blur(input);
		await act(async () => gate.resolve());

		expect(onAction).toHaveBeenCalledTimes(1);
	});

	it('keeps the text and the popover open when the action fails', async () => {
		const onAction = vi.fn().mockResolvedValue({ error: 'x', status: 400 });
		setup({ onAction });
		const user = userEvent.setup();
		const input = await openAdd(user);
		await user.type(input, 'zed{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(input.value).toBe('zed');
		expect(screen.getByRole('dialog')).toBeInTheDocument();
	});

	it('closes the popover with Escape (focus back on "+ Add") and on an outside click', async () => {
		setup();
		const user = userEvent.setup();
		await openAdd(user);
		await screen.findAllByRole('option');

		await user.keyboard('{Escape}');
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(screen.getByRole('button', { name: 'Add label' })).toHaveFocus();
		await openAdd(user);
		await screen.findByRole('listbox');
		fireEvent.pointerDown(document.body);

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});

	it('shows a failed load in the list and still lets the typed label be created', async () => {
		const { onAction } = setup({}, () => jsonResponse({ error: 'unknown project', hint: 'use the id' }, 404));
		const user = userEvent.setup();
		const input = await openAdd(user);

		expect(await screen.findByRole('alert')).toHaveTextContent('unknown project');
		await user.type(input, 'fresh{Enter}');
		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(onAction.mock.calls[0]![2]).toEqual({ body: { label: 'fresh' } });
	});

	it('aborts the label request when it unmounts', async () => {
		const { calls, unmount } = setup();
		await openAdd(userEvent.setup());
		await waitFor(() => expect(calls).toHaveLength(1));

		unmount();

		expect(calls[0]!.signal?.aborted).toBe(true);
	});

	it('draws chips only when read-only, and the empty text when there is nothing', () => {
		const { unmount } = render(
			<LabelCombobox labels={['ui']} addAction="a" removeAction="r" readOnly onAction={vi.fn()} />
		);
		expect(screen.queryByRole('combobox')).toBeNull();
		expect(screen.queryByRole('button')).toBeNull();
		unmount();

		render(<LabelCombobox labels={[]} readOnly emptyText="No labels" />);
		expect(screen.getByText('No labels')).toBeInTheDocument();
	});

	it('keeps the popover inside a narrow screen', async () => {
		setup();
		await openAdd(userEvent.setup());

		await screen.findAllByRole('option');
		expect(screen.getByRole('dialog').className).toContain('max-w-[calc(100vw-1rem)]');
	});
});

describe('LabelCombobox: focus after an add (the popover closes by design)', () => {
	it('closes after a successful add and puts the focus back on "+ Add"', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		const input = await openAdd(user);
		await user.type(input, 'brand-new{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(screen.getByRole('button', { name: 'Add label' })).toHaveFocus();
	});

	it('stays open on a failure, with the typed text', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();
		onAction.mockResolvedValue({ error: 'refused', status: 400 });

		const input = await openAdd(user);
		await user.type(input, 'brand-new{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
		expect(screen.getByRole('dialog')).toBeInTheDocument();
		expect(screen.getByRole('combobox')).toHaveValue('brand-new');
	});
});
