import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, jsonResponse, stubFetch } from '../testHelpers.js';
import { resetReported } from '../reportOnce.js';
import { configureTaskUi, resetTaskUiConfig } from '../runtime-config.js';
import { TaskPicker } from './TaskPicker.js';

const ROWS = [
	{
		id: 'aaaa1111',
		headline: 'Fix login loop',
		status: 'in-progress',
		statusText: 'in progress',
		tone: 'info',
		href: '/x/aaaa1111',
	},
	{
		id: 'bbbb2222',
		headline: 'Write docs',
		status: 'todo',
		statusText: 'todo',
		tone: 'neutral',
		href: '/x/bbbb2222',
	},
	{ id: 'cccc3333', headline: 'Ship it', status: 'done', statusText: 'done', tone: 'success', href: '/x/cccc3333' },
];

beforeEach(() => configureTaskUi({ apiBase: '/api/modules/task' }));
afterEach(() => {
	resetTaskUiConfig();
	resetReported();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function setup(props: Partial<React.ComponentProps<typeof TaskPicker>> = {}, rows: unknown = ROWS) {
	const fetchStub = stubFetch(() => jsonResponse(rows));
	const onAction = vi.fn().mockResolvedValue(undefined);
	const utils = render(
		<TaskPicker
			action="setParent"
			params={{ id: 't1' }}
			projectParam="p1"
			ariaLabel="Parent task"
			onAction={onAction}
			{...props}
		/>
	);
	return { ...fetchStub, onAction, ...utils, input: screen.getByRole('combobox') as HTMLInputElement };
}

describe('TaskPicker', () => {
	it('is a combobox with a collapsed listbox popup and a name', () => {
		const { input } = setup();

		expect(screen.getByRole('combobox', { name: 'Parent task' })).toBe(input);
		expect(input).toHaveAttribute('aria-expanded', 'false');
		expect(input).toHaveAttribute('aria-autocomplete', 'list');
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('searches on focus with an empty query, the limit and the project, and lists id, headline and status', async () => {
		const { calls, input } = setup();

		await userEvent.setup().click(input);

		await screen.findByRole('listbox');
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url.pathname).toBe('/api/modules/task/tasks/search');
		expect(calls[0]!.url.searchParams.get('q')).toBe('');
		expect(calls[0]!.url.searchParams.get('limit')).toBe('8');
		expect(calls[0]!.url.searchParams.get('project')).toBe('p1');
		const options = await screen.findAllByRole('option');
		expect(options).toHaveLength(3);
		expect(options[0]).toHaveTextContent('aaaa1111');
		expect(options[0]).toHaveTextContent('Fix login loop');
		expect(options[0]).toHaveTextContent('in progress');
		expect(options[0]!.querySelector('[data-tone="info"]')).not.toBeNull();
		expect(input).toHaveAttribute('aria-expanded', 'true');
	});

	it('shows skeleton rows while loading, never a blank popover', async () => {
		const gate = deferred<Response>();
		stubFetch(() => gate.promise);
		render(<TaskPicker action="a" onAction={vi.fn()} ariaLabel="Parent task" />);

		await userEvent.setup().click(screen.getByRole('combobox'));

		expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'true');
		expect(screen.getAllByTestId('task-picker-skeleton').length).toBeGreaterThanOrEqual(3);
		await act(async () => gate.resolve(jsonResponse(ROWS)));
		await screen.findAllByRole('option');
		expect(screen.queryByTestId('task-picker-skeleton')).toBeNull();
	});

	it('debounces typing by 150 ms and searches once with the last text', async () => {
		vi.useFakeTimers();
		const { calls, input } = setup();
		fireEvent.focus(input);
		await act(async () => vi.advanceTimersByTime(0));
		expect(calls).toHaveLength(1);

		fireEvent.change(input, { target: { value: 'a' } });
		fireEvent.change(input, { target: { value: 'ab' } });
		fireEvent.change(input, { target: { value: 'abc' } });
		await act(async () => vi.advanceTimersByTime(149));
		expect(calls).toHaveLength(1);
		await act(async () => vi.advanceTimersByTime(1));

		expect(calls).toHaveLength(2);
		expect(calls[1]!.url.searchParams.get('q')).toBe('abc');
	});

	it('aborts the stale request and ignores its late answer', async () => {
		const first = deferred<Response>();
		const second = deferred<Response>();
		const queue = [first, second];
		const { calls } = stubFetch(() => queue.shift()!.promise);
		render(<TaskPicker action="a" onAction={vi.fn()} debounceMs={0} ariaLabel="Parent task" />);
		const input = screen.getByRole('combobox');

		fireEvent.focus(input);
		await waitFor(() => expect(calls).toHaveLength(1));
		fireEvent.change(input, { target: { value: 'x' } });
		await waitFor(() => expect(calls).toHaveLength(2));

		expect(calls[0]!.signal?.aborted).toBe(true);
		expect(calls[1]!.signal?.aborted).toBe(false);
		await act(async () => second.resolve(jsonResponse([ROWS[1]])));
		await act(async () => first.resolve(jsonResponse([ROWS[0]])));
		const options = await screen.findAllByRole('option');
		expect(options).toHaveLength(1);
		expect(options[0]).toHaveTextContent('Write docs');
	});

	it('sends the exclusions and drops excluded ids from the answer too', async () => {
		const { calls, input } = setup({ excludeIds: ['t1', 'aaaa1111'], excludeDescendantsOf: 't1' });

		await userEvent.setup().click(input);

		const options = await screen.findAllByRole('option');
		expect(calls[0]!.url.searchParams.get('exclude')).toBe('t1,aaaa1111');
		expect(calls[0]!.url.searchParams.get('excludeDescendantsOf')).toBe('t1');
		expect(options).toHaveLength(2);
		expect(screen.queryByText('Fix login loop')).toBeNull();
	});

	it('moves the highlight with the arrows (aria-activedescendant) and picks with Enter, sending the id in the body', async () => {
		const { input, onAction } = setup();
		const user = userEvent.setup();
		await user.click(input);
		await screen.findAllByRole('option');

		const first = screen.getAllByRole('option')[0]!;
		expect(input).toHaveAttribute('aria-activedescendant', first.id);
		expect(first).toHaveAttribute('aria-selected', 'true');
		await user.keyboard('{ArrowDown}{ArrowDown}');
		expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[2]!.id);
		await user.keyboard('{ArrowUp}');
		expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1]!.id);
		await user.keyboard('{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
		expect(onAction).toHaveBeenCalledWith('setParent', { id: 't1' }, { body: { target: 'bbbb2222' } });
	});

	it('uses bodyKey for the body field', async () => {
		const { input, onAction } = setup({ bodyKey: 'parent' });
		const user = userEvent.setup();
		await user.click(input);
		await screen.findAllByRole('option');
		await user.keyboard('{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(onAction).toHaveBeenCalledWith('setParent', { id: 't1' }, { body: { parent: 'aaaa1111' } });
	});

	it('picks with a click on a row', async () => {
		const { input, onAction } = setup();
		const user = userEvent.setup();
		await user.click(input);

		await user.click((await screen.findAllByRole('option'))[2]!);

		await waitFor(() => expect(onAction).toHaveBeenCalled());
		expect(onAction.mock.calls[0]![2]).toEqual({ body: { target: 'cccc3333' } });
	});

	it('stays busy until the action resolved, then clears its input and closes', async () => {
		const gate = deferred<void>();
		const onAction = vi.fn().mockReturnValue(gate.promise);
		const { input } = setup({ onAction });
		const user = userEvent.setup();
		await user.click(input);
		await user.type(input, 'fix');
		await screen.findAllByRole('option');
		await user.keyboard('{Enter}');

		expect(screen.getByRole('listbox')).toBeInTheDocument();
		expect(input).toHaveAttribute('aria-busy', 'true');
		await act(async () => gate.resolve());

		await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
		expect(input.value).toBe('');
		expect(input).toHaveAttribute('aria-expanded', 'false');
		expect(input).not.toHaveAttribute('aria-busy');
	});

	it('submits once when Enter is pressed twice or Enter is followed by a blur', async () => {
		const gate = deferred<void>();
		const onAction = vi.fn().mockReturnValue(gate.promise);
		const { input } = setup({ onAction });
		const user = userEvent.setup();
		await user.click(input);
		await screen.findAllByRole('option');

		await user.keyboard('{Enter}{Enter}');
		fireEvent.blur(input);
		await act(async () => gate.resolve());

		expect(onAction).toHaveBeenCalledTimes(1);
	});

	it('keeps the typed text and closes when the action fails', async () => {
		const onAction = vi.fn().mockResolvedValue({ error: 'conflict', status: 409 });
		const { input } = setup({ onAction });
		const user = userEvent.setup();
		await user.click(input);
		await user.type(input, 'fix');
		await screen.findAllByRole('option');
		await user.keyboard('{Enter}');

		await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
		expect(input.value).toBe('fix');
	});

	it('closes with Escape and keeps the text; reopens when typing again', async () => {
		const { input } = setup();
		const user = userEvent.setup();
		await user.click(input);
		await user.type(input, 'fi');
		await screen.findAllByRole('option');

		await user.keyboard('{Escape}');

		expect(screen.queryByRole('listbox')).toBeNull();
		expect(input.value).toBe('fi');
		await user.type(input, 'x');
		expect(await screen.findByRole('listbox')).toBeInTheDocument();
	});

	it('closes on a click outside', async () => {
		const { input } = setup();
		const user = userEvent.setup();
		await user.click(input);
		await screen.findAllByRole('option');

		fireEvent.pointerDown(document.body);

		await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
	});

	it('says there is no match, as a status', async () => {
		const { input } = setup({}, []);
		const user = userEvent.setup();
		await user.click(input);
		await user.type(input, 'zzz');

		const status = await screen.findByRole('status');
		expect(status).toHaveTextContent('No match');
		expect(status).toHaveTextContent('zzz');
		await user.keyboard('{Enter}');
	});

	it('shows the route error with its hint as an alert', async () => {
		stubFetch(() => jsonResponse({ error: 'unknown project', hint: 'use the project id' }, 404));
		render(<TaskPicker action="a" onAction={vi.fn()} ariaLabel="Parent task" />);

		await userEvent.setup().click(screen.getByRole('combobox'));

		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent('unknown project');
		expect(alert).toHaveTextContent('use the project id');
	});

	it('shows a network failure as an alert', async () => {
		stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
		render(<TaskPicker action="a" onAction={vi.fn()} ariaLabel="Parent task" />);

		await userEvent.setup().click(screen.getByRole('combobox'));

		expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
	});

	it('has a clear button only when clearable and there is text', async () => {
		const first = setup({ clearable: true });
		const user = userEvent.setup();
		expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
		await user.type(first.input, 'ab');

		await user.click(screen.getByRole('button', { name: 'Clear' }));

		expect(first.input.value).toBe('');
	});

	it('has no clear button when not clearable', async () => {
		const { input } = setup();
		await userEvent.setup().type(input, 'ab');

		expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
	});

	it('keeps rows on one line and the popup inside a narrow screen', async () => {
		const { input } = setup();
		await userEvent.setup().click(input);

		const options = await screen.findAllByRole('option');
		expect(screen.getByTestId('task-picker-popup').className).toContain('max-w-[calc(100vw-1rem)]');
		expect(options[0]!.querySelector('.truncate')).not.toBeNull();
	});

	it('is disabled with a reason and says so once when there is no action handler', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		stubFetch(() => jsonResponse([]));
		render(<TaskPicker action="setParent" ariaLabel="Parent task" />);

		expect(screen.getByRole('combobox')).toBeDisabled();
		expect(error).toHaveBeenCalledTimes(1);
	});

	it('does nothing on Enter when there is no row', async () => {
		const { input, onAction } = setup({}, []);
		const user = userEvent.setup();
		await user.click(input);
		await screen.findByRole('status');

		await user.keyboard('{Enter}');

		expect(onAction).not.toHaveBeenCalled();
	});
});
