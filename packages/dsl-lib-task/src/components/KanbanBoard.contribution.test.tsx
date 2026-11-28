import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleColumns } from '../kanban/boardFixtures.js';
import { FakeEventSource, jsonResponse, stubFetch } from '../testHelpers.js';
import type { FetchCall } from '../testHelpers.js';
import { KanbanBoard } from './KanbanBoard.js';

function answer(extra: Record<string, unknown> = {}) {
	return { columns: sampleColumns(), version: 'v1', hasCards: true, emptyText: null, warning: null, ...extra };
}

beforeEach(() => {
	FakeEventSource.reset();
	vi.stubGlobal('EventSource', FakeEventSource);
	window.localStorage.clear();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** The host page of a contribution gives no columns and no action. */
function setup(extra: Partial<React.ComponentProps<typeof KanbanBoard>> = {}) {
	return render(<KanbanBoard projectParam="p1" apiBase="/api/modules/task" {...extra} />);
}

const column = (status: string): HTMLElement => screen.getByTestId(`kanban-column-${status}`);

/** Drags card `id` and drops it on the drop band of `status` (the bands exist only while a card is dragged). */
function dragTo(id: string, status: string): void {
	const card = document.querySelector(`[data-card-id="${id}"]`) as HTMLElement;
	const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => id), effectAllowed: '', dropEffect: '' };
	fireEvent.dragStart(card, { dataTransfer });
	const target = screen.getByTestId(`kanban-drop-area-${status}`);
	fireEvent.dragOver(target, { dataTransfer });
	fireEvent.drop(target, { dataTransfer });
	fireEvent.dragEnd(card, { dataTransfer });
}

describe('KanbanBoard contribution mode: loading its own data', () => {
	it('says "Loading board", fetches the board of the project, then draws it', async () => {
		const { calls } = stubFetch(() => jsonResponse(answer()));
		setup();

		expect(screen.getByText('Loading board')).toBeInTheDocument();
		await waitFor(() => expect(document.querySelector('[data-card-id="aaa11111"]')).not.toBeNull());
		expect(screen.queryByText('Loading board')).toBeNull();
		expect(calls[0]!.url.pathname).toBe('/api/modules/task/tasks/board');
		expect(calls[0]!.url.searchParams.get('project')).toBe('p1');
		expect(calls[0]!.method).toBe('GET');
	});

	it('uses boardPath', async () => {
		const { calls } = stubFetch(() => jsonResponse(answer()));
		setup({ boardPath: '/other/board' });

		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]!.url.pathname).toBe('/api/modules/task/other/board');
	});

	it('a failure is a message with the fix, not a blank board and not "No tasks"', async () => {
		stubFetch(() => jsonResponse({ error: 'Project unreadable', hint: 'Fix config.yml' }, 500));
		setup();

		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent('could not be loaded');
		expect(alert).toHaveTextContent('Project unreadable');
		expect(alert).toHaveTextContent('Fix config.yml');
		expect(alert).toHaveTextContent(/reload/i);
		expect(screen.queryByText('Loading board')).toBeNull();
		expect(screen.queryByText('No tasks yet')).toBeNull();
	});

	it('a problem that already ends with a full stop is not followed by a second one before our own sentence', async () => {
		stubFetch(() => jsonResponse({ error: 'The board key is wrong.', hint: 'Fix config.yml.' }, 400));
		setup();

		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent('The board key is wrong. Fix config.yml. Reload the page');
		expect(alert.textContent).not.toContain('..');
	});

	it('after a failed load the stream still brings the board when the version changes', async () => {
		let fail = true;
		stubFetch(() => (fail ? jsonResponse({ error: 'boom' }, 500) : jsonResponse(answer({ version: 'v2' }))));
		setup();
		await screen.findByRole('alert');

		fail = false;
		act(() => FakeEventSource.last().emit('version', 'v2'));

		await waitFor(() => expect(document.querySelector('[data-card-id="aaa11111"]')).not.toBeNull());
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('a {blank: true} answer shows nothing: no cards, no empty text, no loading line', async () => {
		const { calls } = stubFetch(() => jsonResponse({ blank: true }));
		setup();

		await waitFor(() => expect(calls).toHaveLength(1));
		await waitFor(() => expect(screen.queryByText('Loading board')).toBeNull());
		expect(screen.queryByText('No tasks yet')).toBeNull();
		expect(document.querySelector('[data-card-id]')).toBeNull();
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('opens the stream at mount and a new version refetches', async () => {
		const { calls } = stubFetch(() => jsonResponse(answer()));
		setup();
		await waitFor(() => expect(calls).toHaveLength(1));

		act(() => FakeEventSource.last().emit('version', 'v9'));

		await waitFor(() => expect(calls).toHaveLength(2));
	});

	it('aborts the first fetch on unmount', async () => {
		const { calls } = stubFetch(() => new Promise<Response>(() => undefined));
		const { unmount } = setup();
		await waitFor(() => expect(calls).toHaveLength(1));

		unmount();

		expect(calls[0]!.signal?.aborted).toBe(true);
	});

	it('shows the warning of the answer as one notice above the board', async () => {
		stubFetch(() => jsonResponse(answer({ warning: '2 tasks have a status the config does not list: old' })));
		setup();

		expect(await screen.findByText(/status the config does not list/)).toBeInTheDocument();
		expect(document.querySelector('[data-card-id="aaa11111"]')).not.toBeNull();
	});

	it('links to the Tasks page when the answer gives tasksHref', async () => {
		stubFetch(() => jsonResponse(answer({ tasksHref: '/modules/task/tasks/p/p1' })));
		setup();

		const link = await screen.findByRole('link', { name: /Open in Tasks/ });
		expect(link).toHaveAttribute('href', '/modules/task/tasks/p/p1');
	});

	it('no link without tasksHref', async () => {
		stubFetch(() => jsonResponse(answer()));
		setup();
		await waitFor(() => expect(document.querySelector('[data-card-id]')).not.toBeNull());

		expect(screen.queryByRole('link', { name: /Open in Tasks/ })).toBeNull();
	});

	it('an empty board shows the emptyText of the answer', async () => {
		const columns = sampleColumns().map(c => ({ ...c, cards: [], count: 0, hiddenCount: 0 }));
		stubFetch(() => jsonResponse(answer({ columns, emptyText: 'Nothing planned here' })));
		setup();

		expect(await screen.findByText('Nothing planned here')).toBeInTheDocument();
	});

	it('a readOnly answer disables the moves', async () => {
		stubFetch(() => jsonResponse(answer({ readOnly: true })));
		setup();
		await waitFor(() => expect(document.querySelector('[data-card-id]')).not.toBeNull());

		expect(screen.queryByRole('button', { name: /Move/ })).toBeNull();
	});
});

describe('KanbanBoard contribution mode: the move is a request of its own', () => {
	function server(handler: (call: FetchCall) => Response | Promise<Response>) {
		return stubFetch(call => (call.method === 'POST' ? handler(call) : jsonResponse(answer())));
	}

	async function loaded(extra: Partial<React.ComponentProps<typeof KanbanBoard>> = {}) {
		setup(extra);
		await waitFor(() => expect(document.querySelector('[data-card-id="aaa11111"]')).not.toBeNull());
	}

	it('POSTs {status} as JSON to the status route of the card', async () => {
		const { calls } = server(() => jsonResponse({ task: {} }));
		await loaded();

		dragTo('aaa11111', 'doing');

		await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true));
		const post = calls.find(c => c.method === 'POST')!;
		expect(post.url.pathname).toBe('/api/modules/task/tasks/aaa11111/status');
		expect(post.url.searchParams.get('project')).toBe('p1');
		expect(post.headers['content-type']).toBe('application/json');
		expect(JSON.parse(post.body!)).toEqual({ status: 'doing' });
	});

	it('movePath is a template with {id}', async () => {
		const { calls } = server(() => jsonResponse({}));
		await loaded({ movePath: '/x/{id}/to' });

		dragTo('aaa11111', 'doing');

		await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true));
		expect(calls.find(c => c.method === 'POST')!.url.pathname).toBe('/api/modules/task/x/aaa11111/to');
	});

	it('moves the card at once, then refetches the board', async () => {
		let postCalls = 0;
		const { calls } = stubFetch(call => {
			if (call.method === 'POST') {
				postCalls += 1;
				return jsonResponse({});
			}
			if (postCalls === 0) {
				return jsonResponse(answer());
			}
			const columns = sampleColumns();
			const card = columns[0]!.cards.shift()!;
			columns[1]!.cards.unshift({ ...card, status: 'doing' });
			return jsonResponse(answer({ columns, version: 'v2' }));
		});
		await loaded();

		dragTo('aaa11111', 'doing');

		await waitFor(() => expect(column('doing').querySelector('[data-card-id="aaa11111"]')).not.toBeNull());
		await waitFor(() => expect(calls.filter(c => c.method === 'GET').length).toBeGreaterThanOrEqual(2));
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('an error answer puts the card back and shows its message and hint', async () => {
		server(() => jsonResponse({ error: 'status done needs a resolution', hint: 'Set one first' }, 409));
		await loaded();

		dragTo('aaa11111', 'done');

		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent('aaa11111');
		expect(alert).toHaveTextContent('status done needs a resolution');
		expect(alert).toHaveTextContent('Set one first');
		expect(column('todo').querySelector('[data-card-id="aaa11111"]')).not.toBeNull();
		expect(column('done').querySelector('[data-card-id="aaa11111"]')).toBeNull();
	});

	it('a body that is not JSON is reported with the status', async () => {
		server(() => new Response('Bad gateway', { status: 502 }));
		await loaded();

		dragTo('aaa11111', 'done');

		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent(/not moved/i);
		expect(alert).toHaveTextContent('502');
		expect(column('todo').querySelector('[data-card-id="aaa11111"]')).not.toBeNull();
	});

	it('an unreachable server is reported with the fix', async () => {
		server(() => Promise.reject(new TypeError('Failed to fetch')));
		await loaded();

		dragTo('aaa11111', 'done');

		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent(/could not reach/i);
		expect(alert).toHaveTextContent(/app-core is running/i);
		expect(column('todo').querySelector('[data-card-id="aaa11111"]')).not.toBeNull();
	});

	it('the Move menu works the same way', async () => {
		const { calls } = server(() => jsonResponse({}));
		await loaded();

		fireEvent.click(screen.getByRole('button', { name: 'Move aaa11111 to another status' }));
		fireEvent.click(screen.getByRole('menuitem', { name: 'done' }));

		await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true));
		expect(JSON.parse(calls.find(c => c.method === 'POST')!.body!)).toEqual({ status: 'done' });
	});

	it('in page mode (moveAction given) no request of its own is made', async () => {
		const onAction = vi.fn().mockResolvedValue(undefined);
		const { calls } = stubFetch(() => jsonResponse(answer()));
		render(
			<KanbanBoard
				columns={sampleColumns()}
				projectParam="p1"
				moveAction="moveCard"
				apiBase="/api/modules/task"
				onAction={onAction}
			/>
		);

		dragTo('aaa11111', 'doing');

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
		expect(calls.filter(c => c.method === 'POST')).toHaveLength(0);
	});
});

describe('KanbanBoard projectParam is raw and encoded once', () => {
	it('a value with "/" is encoded once in the stream url and once in the board query', async () => {
		const { calls } = stubFetch(() => jsonResponse(answer()));
		setup({ projectParam: 'a/b c' });

		expect(FakeEventSource.last().url).toBe('/api/modules/task/board/events?project=a%2Fb%20c');
		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]!.url.searchParams.get('project')).toBe('a/b c');
		expect(calls[0]!.url.search).toBe('?project=a%2Fb+c');
	});

	it('the move request carries it the same way', async () => {
		const { calls } = stubFetch(call => (call.method === 'POST' ? jsonResponse({}) : jsonResponse(answer())));
		setup({ projectParam: 'a/b' });
		await waitFor(() => expect(document.querySelector('[data-card-id="aaa11111"]')).not.toBeNull());

		dragTo('aaa11111', 'doing');

		await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true));
		expect(calls.find(c => c.method === 'POST')!.url.search).toBe('?project=a%2Fb');
	});
});
