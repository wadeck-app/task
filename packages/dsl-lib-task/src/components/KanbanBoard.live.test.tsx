import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleColumns } from '../kanban/boardFixtures.js';
import { FakeEventSource, jsonResponse, stubFetch } from '../testHelpers.js';
import { KanbanBoard } from './KanbanBoard.js';

function boardAt(version: string, headline: string) {
	const columns = sampleColumns();
	columns[0]!.cards[0]!.headline = headline;
	return { columns, version, hasCards: true };
}

beforeEach(() => {
	FakeEventSource.reset();
	vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function setup(extra: Partial<React.ComponentProps<typeof KanbanBoard>> = {}) {
	return render(
		<KanbanBoard
			columns={sampleColumns()}
			version="v1"
			projectParam="p 1"
			moveAction="moveCard"
			apiBase="/api/modules/task"
			defaultVariant="columns"
			onAction={vi.fn()}
			{...extra}
		/>
	);
}

describe('KanbanBoard live', () => {
	it('opens an EventSource on the events route of the project, and closes it on unmount', () => {
		const { unmount } = setup();

		expect(FakeEventSource.last().url).toBe('/api/modules/task/board/events?project=p%201');
		unmount();
		expect(FakeEventSource.last().closed).toBe(true);
	});

	it('uses eventsPath and boardPath when given', async () => {
		const { calls } = stubFetch(() => jsonResponse(boardAt('v2', 'x')));
		setup({ eventsPath: '/e', boardPath: '/b' });
		expect(FakeEventSource.last().url).toBe('/api/modules/task/e?project=p%201');

		act(() => FakeEventSource.last().emit('version', 'v2'));

		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]!.url.pathname).toBe('/api/modules/task/b');
	});

	it('shows reconnecting until the stream opens, then live', () => {
		setup();
		expect(screen.getByTestId('kanban-live')).toHaveTextContent(/reconnecting/i);

		act(() => FakeEventSource.last().emit('open'));

		expect(screen.getByTestId('kanban-live')).toHaveTextContent(/^live$/i);
	});

	it('a version event with a new value refetches once and replaces the cards', async () => {
		const { calls } = stubFetch(() => jsonResponse(boardAt('v2', 'Write the better spec')));
		setup();
		act(() => FakeEventSource.last().emit('open'));

		act(() => FakeEventSource.last().emit('version', 'v2'));

		await waitFor(() => expect(screen.getByText('Write the better spec')).toBeInTheDocument());
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url.searchParams.get('project')).toBe('p 1');
	});

	it('reads the version from a JSON event too', async () => {
		const { calls } = stubFetch(() => jsonResponse(boardAt('v2', 'x')));
		setup();

		act(() => FakeEventSource.last().emit('version', JSON.stringify({ version: 'v2' })));

		await waitFor(() => expect(calls).toHaveLength(1));
	});

	it('a version event with the current value does not refetch', async () => {
		const { calls } = stubFetch(() => jsonResponse(boardAt('v1', 'x')));
		setup();

		act(() => FakeEventSource.last().emit('version', 'v1'));
		await act(async () => {
			await Promise.resolve();
		});

		expect(calls).toHaveLength(0);
	});

	it('the same new version twice in a row refetches once', async () => {
		const { calls } = stubFetch(() => jsonResponse(boardAt('v2', 'x')));
		setup();

		act(() => {
			FakeEventSource.last().emit('version', 'v2');
			FakeEventSource.last().emit('version', 'v2');
		});

		await waitFor(() => expect(calls).toHaveLength(1));
		await act(async () => {
			await Promise.resolve();
		});
		expect(calls).toHaveLength(1);
	});

	it('aborts the previous refetch when a newer version arrives', async () => {
		const { calls } = stubFetch(() => new Promise<Response>(() => undefined));
		setup();

		act(() => FakeEventSource.last().emit('version', 'v2'));
		await waitFor(() => expect(calls).toHaveLength(1));
		act(() => FakeEventSource.last().emit('version', 'v3'));
		await waitFor(() => expect(calls).toHaveLength(2));

		expect(calls[0]!.signal?.aborted).toBe(true);
		expect(calls[1]!.signal?.aborted).toBe(false);
	});

	it('a failed refetch keeps the old cards and shows one actionable line', async () => {
		stubFetch(() => jsonResponse({ error: 'Project unreadable', hint: 'Fix config.yml' }, 500));
		setup();

		act(() => FakeEventSource.last().emit('version', 'v2'));

		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent('Project unreadable');
		expect(alert).toHaveTextContent('Fix config.yml');
		expect(screen.getByText('Write the spec')).toBeInTheDocument();
	});

	it('an answer that is not a board is reported, the old cards stay', async () => {
		stubFetch(() => jsonResponse({ version: 'v2' }));
		setup();

		act(() => FakeEventSource.last().emit('version', 'v2'));

		expect(await screen.findByRole('alert')).toHaveTextContent(/columns/i);
		expect(screen.getByText('Write the spec')).toBeInTheDocument();
	});

	it('the error goes away after the next good refetch', async () => {
		let fail = true;
		stubFetch(() => (fail ? jsonResponse({ error: 'boom' }, 500) : jsonResponse(boardAt('v3', 'Fresh'))));
		setup();
		act(() => FakeEventSource.last().emit('version', 'v2'));
		await screen.findByRole('alert');

		fail = false;
		act(() => FakeEventSource.last().emit('version', 'v3'));

		await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
		expect(screen.getByText('Fresh')).toBeInTheDocument();
	});

	it('does not replace the cards while one is being dragged, and applies the answer when the drag ends', async () => {
		stubFetch(() => jsonResponse(boardAt('v2', 'Renamed under your hand')));
		setup();
		const card = document.querySelector('[data-card-id="aaa11111"]') as HTMLElement;
		fireEvent.dragStart(card, { dataTransfer: { setData: vi.fn(), effectAllowed: '' } });

		act(() => FakeEventSource.last().emit('version', 'v2'));
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 20));
		});
		expect(screen.queryByText('Renamed under your hand')).toBeNull();
		expect(document.querySelector('[data-card-id="aaa11111"]')).toBe(card);

		fireEvent.dragEnd(card);

		expect(await screen.findByText('Renamed under your hand')).toBeInTheDocument();
	});
});

describe('KanbanBoard polling fallback', () => {
	it('polls every pollSeconds when EventSource does not exist, and says so', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('EventSource', undefined);
		const { calls } = stubFetch(() => jsonResponse(boardAt('v2', 'Polled')));
		setup({ pollSeconds: 5 });
		expect(screen.getByTestId('kanban-live')).toHaveTextContent(/polling/i);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4_999);
		});
		expect(calls).toHaveLength(0);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2);
		});

		expect(calls).toHaveLength(1);
		expect(screen.getByText('Polled')).toBeInTheDocument();
	});

	it('defaults to every 20 seconds', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('EventSource', undefined);
		const { calls } = stubFetch(() => jsonResponse(boardAt('v1', 'x')));
		setup();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(19_999);
		});
		expect(calls).toHaveLength(0);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2);
		});
		expect(calls).toHaveLength(1);
	});

	it('falls back to polling after repeated stream errors and closes the stream', async () => {
		vi.useFakeTimers();
		const { calls } = stubFetch(() => jsonResponse(boardAt('v2', 'Polled')));
		setup({ pollSeconds: 5 });
		const source = FakeEventSource.last();

		act(() => source.emit('error'));
		expect(screen.getByTestId('kanban-live')).toHaveTextContent(/reconnecting/i);
		act(() => source.emit('error'));
		act(() => source.emit('error'));

		expect(source.closed).toBe(true);
		expect(screen.getByTestId('kanban-live')).toHaveTextContent(/polling/i);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_001);
		});
		expect(calls).toHaveLength(1);
	});

	it('an opened stream resets the error count', () => {
		setup();
		const source = FakeEventSource.last();

		act(() => source.emit('error'));
		act(() => source.emit('error'));
		act(() => source.emit('open'));
		act(() => source.emit('error'));
		act(() => source.emit('error'));

		expect(source.closed).toBe(false);
	});

	it('stops polling on unmount', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('EventSource', undefined);
		const { calls } = stubFetch(() => jsonResponse(boardAt('v2', 'x')));
		const { unmount } = setup({ pollSeconds: 5 });
		unmount();

		await vi.advanceTimersByTimeAsync(30_000);

		expect(calls).toHaveLength(0);
	});

	it('a pollSeconds that is not a positive number is reported and 20 is used', () => {
		vi.stubGlobal('EventSource', undefined);
		setup({ pollSeconds: 0 });

		expect(screen.getByText(/pollSeconds/)).toBeInTheDocument();
	});
});

describe('KanbanBoard without a project', () => {
	it('says projectParam is missing instead of opening a stream for nothing', () => {
		setup({ projectParam: '' });

		expect(FakeEventSource.instances).toHaveLength(0);
		expect(screen.getByText(/projectParam/)).toBeInTheDocument();
	});
});
