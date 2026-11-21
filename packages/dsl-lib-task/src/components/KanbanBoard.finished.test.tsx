import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AbExperiments } from '@wadeck-app/dsl-ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sortedColumns, sortedLayout } from '../kanban/boardFixtures.js';
import { FINISHED_FOR_OPTIONS } from '../kanban/boardModel.js';
import { deferred, FakeEventSource, jsonResponse, stubFetch } from '../testHelpers.js';
import { KanbanBoard } from './KanbanBoard.js';

// `board.finishedFor` (decision D23): how long a task in a finished (terminal) status stays on the board.

function answer(extra: Record<string, unknown> = {}, finishedFor: unknown = '1d') {
	return {
		columns: sortedColumns(),
		config: {
			isDefault: false,
			columns: sortedLayout().columns,
			...(finishedFor === undefined ? {} : { finishedFor }),
		},
		allStatuses: sortedLayout().allStatuses,
		version: 'f1',
		hasCards: true,
		...extra,
	};
}

let calls: ReturnType<typeof stubFetch>['calls'];

beforeEach(() => {
	FakeEventSource.reset();
	vi.stubGlobal('EventSource', FakeEventSource);
	window.localStorage.clear();
	calls = stubFetch(() => jsonResponse(answer())).calls;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** Contribution mode: the board fetches the answer (with its layout) itself. */
async function setup(extra: Partial<React.ComponentProps<typeof KanbanBoard>> = {}) {
	render(<KanbanBoard projectParam="p1" apiBase="/api/modules/task" {...extra} />);
	await screen.findByTestId('kanban-column-Doing');
}

const putBody = (): Record<string, unknown> => JSON.parse(calls.find(call => call.method === 'PUT')!.body!);
const LABELS = ['No limit', '1 hour', '4 hours', '8 hours', '1 day', '2 days', '7 days', '14 days'];

describe('finishedFor in the model', () => {
	it('offers No limit then the seven windows, in order', () => {
		expect(FINISHED_FOR_OPTIONS.map(option => option.label)).toEqual(LABELS);
		expect(FINISHED_FOR_OPTIONS.map(option => option.value)).toEqual([
			'none',
			'1h',
			'4h',
			'8h',
			'1d',
			'2d',
			'7d',
			'14d',
		]);
	});

	it('an unknown value in the answer is dropped: the controls say No limit', async () => {
		stubFetch(() => jsonResponse(answer({}, 'forever')));
		await setup();
		expect(screen.getByRole('combobox', { name: 'Finished tasks shown for' })).toHaveValue('none');
	});
});

describe('Configure columns: Show finished tasks for', () => {
	async function open() {
		const user = userEvent.setup();
		await setup();
		await user.click(screen.getByTestId('kanban-configure'));
		return user;
	}
	const select = (): HTMLElement => screen.getByRole('combobox', { name: 'Show finished tasks for' });

	it('one board-level select above the columns, starting from the stored value, with a muted hint', async () => {
		await open();
		expect(select()).toHaveValue('1d');
		expect(
			within(select())
				.getAllByRole('option')
				.map(option => option.textContent)
		).toEqual(LABELS);
		const editor = screen.getByTestId('columns-editor');
		const order = Array.from(
			editor.querySelectorAll(
				'select[aria-label="Show finished tasks for"], [data-testid="columns-editor-column"]'
			)
		);
		expect(order[0]).toBe(select());
		const hint = screen.getByText(
			'Applies to tasks in a finished (terminal) status, counted from the moment they became finished.'
		);
		expect(hint.className).toMatch(/\btext-muted\b/);
	});

	it('Save sends finishedFor in the same PUT as the columns', async () => {
		const user = await open();
		await user.selectOptions(select(), '2 days');
		await user.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1);
		expect(putBody()).toEqual({ columns: sortedLayout().columns, finishedFor: '2d' });
	});

	it('No limit leaves finishedFor out of the PUT', async () => {
		const user = await open();
		await user.selectOptions(select(), 'No limit');
		await user.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		expect(putBody()).toEqual({ columns: sortedLayout().columns });
	});

	it('the toolbar control is not drawn while the editor is open (one control with that role per view)', async () => {
		await open();
		expect(screen.queryByRole('combobox', { name: 'Finished tasks shown for' })).toBeNull();
	});
});

describe('the toolbar control "Finished tasks shown for"', () => {
	const toolbar = (): HTMLElement => screen.getByRole('combobox', { name: 'Finished tasks shown for' });

	it('saves at once with the current layout', async () => {
		const user = userEvent.setup();
		await setup();
		expect(toolbar()).toHaveValue('1d');
		await user.selectOptions(toolbar(), '7d');
		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		expect(putBody()).toEqual({ columns: sortedLayout().columns, finishedFor: '7d' });
	});

	it('No limit sends the columns only', async () => {
		const user = userEvent.setup();
		await setup();
		await user.selectOptions(toolbar(), 'none');
		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		expect(putBody()).toEqual({ columns: sortedLayout().columns });
	});

	it('is disabled and says so while saving; a refused save shows the route message and hint', async () => {
		const pending = deferred<Response>();
		stubFetch(call => (call.method === 'PUT' ? pending.promise : jsonResponse(answer())));
		const user = userEvent.setup();
		await setup();
		await user.selectOptions(toolbar(), '4h');

		expect(toolbar()).toBeDisabled();
		expect(screen.getByTestId('kanban-finished-pending')).toHaveTextContent('Saving');

		pending.resolve(jsonResponse({ error: 'board.finishedFor: "4h" is refused', hint: 'Use one of 1h, ...' }, 400));
		const alert = await screen.findByText(/The finished tasks setting was not saved/);
		expect(alert).toHaveTextContent('board.finishedFor');
		expect(alert).toHaveTextContent('Use one of 1h');
		expect(screen.queryByTestId('kanban-finished-pending')).toBeNull();
		expect(toolbar()).toBeEnabled();
	});

	it('a sort picked on the board keeps finishedFor in its PUT', async () => {
		const user = userEvent.setup();
		await setup();
		await user.click(screen.getByRole('button', { name: 'Sort column To do' }));
		await user.click(screen.getByRole('menuitemradio', { name: 'Priority' }));
		await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
		expect(putBody()['finishedFor']).toBe('1d');
	});

	it('is absent when read only, and when the answer has no layout', async () => {
		const first = render(<KanbanBoard projectParam="p1" apiBase="/api/modules/task" readOnly />);
		await screen.findByTestId('kanban-column-Doing');
		expect(screen.queryByRole('combobox', { name: 'Finished tasks shown for' })).toBeNull();
		first.unmount();

		stubFetch(() => jsonResponse({ columns: sortedColumns(), version: 'f1' }));
		await setup();
		expect(screen.queryByRole('combobox', { name: 'Finished tasks shown for' })).toBeNull();
	});

	it('is not a row of the A/B dock', async () => {
		render(
			<AbExperiments enabled>
				<KanbanBoard projectParam="p1" apiBase="/api/modules/task" />
			</AbExperiments>
		);
		await screen.findByTestId('kanban-column-Doing');
		expect(screen.getByRole('group', { name: 'Board columns: sort control' })).toBeInTheDocument();
		expect(screen.queryByRole('group', { name: /finished/i })).toBeNull();
	});
});

describe('finishedNote', () => {
	it('is ONE muted status line, under the hidden note when both exist', async () => {
		stubFetch(() =>
			jsonResponse(
				answer({
					hiddenNote: '1 task is in a status with no column and is not shown: parked (1).',
					finishedNote: '3 finished tasks older than 1 day are hidden.',
				})
			)
		);
		await setup();
		const line = screen.getByTestId('kanban-finished-note');
		expect(line).toHaveTextContent('3 finished tasks older than 1 day are hidden.');
		expect(line).toHaveAttribute('role', 'status');
		expect(line.className).toBe(screen.getByTestId('kanban-hidden-note').className);
		expect(screen.getByTestId('kanban-hidden-note').nextElementSibling).toBe(line);
	});

	it('the page gives the first one as a prop; null draws nothing', () => {
		const first = render(
			<KanbanBoard
				columns={sortedColumns()}
				projectParam="p1"
				apiBase="/api/modules/task"
				finishedNote="2 finished tasks have no date and are shown."
			/>
		);
		expect(screen.getByTestId('kanban-finished-note')).toHaveTextContent('no date');
		first.unmount();
		render(
			<KanbanBoard columns={sortedColumns()} projectParam="p1" apiBase="/api/modules/task" finishedNote={null} />
		);
		expect(screen.queryByTestId('kanban-finished-note')).toBeNull();
	});
});
