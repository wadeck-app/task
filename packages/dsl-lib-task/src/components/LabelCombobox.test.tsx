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
	return { ...fetchStub, onAction, ...utils, input: screen.getByRole('combobox') as HTMLInputElement };
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

	it('is a combobox with a named input and a collapsed popup', () => {
		const { input } = setup();

		expect(input).toHaveAccessibleName('Add a label');
		expect(input).toHaveAttribute('aria-expanded', 'false');
		expect(input).toHaveAttribute('aria-autocomplete', 'list');
	});

	it('loads the project labels on focus and lists them with their count, without the current labels', async () => {
		const { calls, input } = setup();

		await userEvent.setup().click(input);

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

	it('shows skeleton rows while the labels load', async () => {
		const gate = deferred<Response>();
		stubFetch(() => gate.promise);
		render(<LabelCombobox labels={[]} addAction="a" onAction={vi.fn()} />);

		await userEvent.setup().click(screen.getByRole('combobox'));

		expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'true');
		expect(screen.getAllByTestId('label-skeleton').length).toBeGreaterThan(0);
		await act(async () => gate.resolve(jsonResponse(COUNTS)));
		await screen.findAllByRole('option');
	});

	it('uses the suggestions prop and does not fetch', async () => {
		const { calls, input } = setup({ suggestions: [{ label: 'x1', count: 2 }] });

		await userEvent.setup().click(input);

		expect(await screen.findByRole('option', { name: /x1/ })).toBeInTheDocument();
		expect(calls).toHaveLength(0);
	});

	it('filters as you type, case-insensitively, prefix matches first', async () => {
		const { input } = setup();
		const user = userEvent.setup();
		await user.click(input);
		await screen.findAllByRole('option');

		await user.type(input, 'B');

		const names = screen.getAllByRole('option').map(o => o.textContent ?? '');
		expect(names[0]).toContain('bug');
		expect(names.some(n => n.includes('billing'))).toBe(true);
		expect(names.some(n => n.includes('Create'))).toBe(true);
	});

	it('creates the typed label on Enter with no highlighted suggestion, label in the body', async () => {
		const { input, onAction } = setup();
		const user = userEvent.setup();
		await user.click(input);
		await screen.findAllByRole('option');

		await user.type(input, 'brand new{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
		expect(onAction).toHaveBeenCalledWith('addLabel', { id: 't1' }, { body: { label: 'brand new' } });
		await waitFor(() => expect(input.value).toBe(''));
	});

	it('adds the highlighted suggestion on Enter', async () => {
		const { input, onAction } = setup();
		const user = userEvent.setup();
		await user.click(input);
		await screen.findAllByRole('option');

		await user.type(input, 'b{ArrowDown}{ArrowDown}');
		expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1]!.id);
		await user.keyboard('{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(onAction.mock.calls[0]![2]).toEqual({ body: { label: 'billing' } });
	});

	it('adds a suggestion with a click', async () => {
		const { input, onAction } = setup();
		const user = userEvent.setup();
		await user.click(input);

		await user.click(await screen.findByRole('option', { name: /backend/ }));

		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(onAction.mock.calls[0]![2]).toEqual({ body: { label: 'backend' } });
	});

	it('offers a Create row only when no label matches exactly, and uses the existing casing on an exact match', async () => {
		const { input, onAction } = setup();
		const user = userEvent.setup();
		await user.click(input);
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
		const { input, onAction } = setup();
		const user = userEvent.setup();
		await user.click(input);
		await user.type(input, 'UI{Enter}');

		expect(await screen.findByRole('alert')).toHaveTextContent('already has the label "UI"');
		expect(onAction).not.toHaveBeenCalled();
	});

	it('submits once on a double Enter and on Enter followed by a blur', async () => {
		const gate = deferred<void>();
		const onAction = vi.fn().mockReturnValue(gate.promise);
		const { input } = setup({ onAction });
		const user = userEvent.setup();
		await user.click(input);
		await user.type(input, 'zed');

		await user.keyboard('{Enter}{Enter}');
		fireEvent.blur(input);
		await act(async () => gate.resolve());

		expect(onAction).toHaveBeenCalledTimes(1);
	});

	it('keeps the text when the action fails', async () => {
		const onAction = vi.fn().mockResolvedValue({ error: 'x', status: 400 });
		const { input } = setup({ onAction });
		const user = userEvent.setup();
		await user.click(input);
		await user.type(input, 'zed{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(input.value).toBe('zed');
	});

	it('closes the list with Escape and on an outside click', async () => {
		const { input } = setup();
		const user = userEvent.setup();
		await user.click(input);
		await screen.findAllByRole('option');

		await user.keyboard('{Escape}');
		expect(screen.queryByRole('listbox')).toBeNull();
		await user.type(input, 'b');
		await screen.findByRole('listbox');
		fireEvent.pointerDown(document.body);

		await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
	});

	it('shows a failed load in the list and still lets the typed label be created', async () => {
		const { input, onAction } = setup({}, () =>
			jsonResponse({ error: 'unknown project', hint: 'use the id' }, 404)
		);
		const user = userEvent.setup();
		await user.click(input);

		expect(await screen.findByRole('alert')).toHaveTextContent('unknown project');
		await user.type(input, 'fresh{Enter}');
		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(onAction.mock.calls[0]![2]).toEqual({ body: { label: 'fresh' } });
	});

	it('aborts the label request when it unmounts', async () => {
		const { calls, input, unmount } = setup();
		await userEvent.setup().click(input);
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

	it('keeps the list inside a narrow screen', async () => {
		const { input } = setup();
		await userEvent.setup().click(input);

		await screen.findAllByRole('option');
		expect(screen.getByTestId('label-popup').className).toContain('max-w-[calc(100vw-1rem)]');
	});
});
