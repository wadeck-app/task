import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleColumns } from '../kanban/boardFixtures.js';
import { FakeEventSource, jsonResponse, stubFetch } from '../testHelpers.js';
import { KanbanBoard } from './KanbanBoard.js';

let onAction: ReturnType<typeof vi.fn<(...args: any[]) => unknown>>;

beforeEach(() => {
	FakeEventSource.reset();
	vi.stubGlobal('EventSource', FakeEventSource);
	window.localStorage.clear();
	onAction = vi.fn<(...args: any[]) => unknown>().mockResolvedValue(undefined);
	stubFetch(() => jsonResponse({ columns: sampleColumns(), version: 'v1' }));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function setup(extra: Partial<React.ComponentProps<typeof KanbanBoard>> = {}) {
	return render(
		<KanbanBoard
			columns={sampleColumns()}
			version="v1"
			projectParam="p1"
			moveAction="moveCard"
			apiBase="/api/modules/task"
			onAction={onAction}
			{...extra}
		/>
	);
}

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

describe('KanbanBoard widths', () => {
	it('columns share the width and shrink to a minimum, they do not have a fixed width', () => {
		setup();

		for (const status of ['todo', 'doing', 'done']) {
			const classes = screen.getByTestId(`kanban-column-${status}`).className;
			expect(classes).toMatch(/\bflex-1\b/);
			expect(classes).toMatch(/\bmin-w-\[1[3-9]rem\]/);
			expect(classes).not.toMatch(/\bw-(60|72)\b/);
		}
	});

	it('the strip scrolls sideways beyond the minimum widths and is never wider than its container', () => {
		setup();

		const strip = screen.getByTestId('kanban-strip');
		expect(strip.className).toMatch(/overflow-x-auto/);
		expect(strip.className).toMatch(/\bmin-w-0\b/);
		expect(strip.className).toMatch(/\bmax-w-full\b/);
	});

	describe('scroll hint', () => {
		function measure(scrollWidth: number, clientWidth: number): void {
			vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth);
			vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(clientWidth);
		}

		it('says so when the columns do not fit', () => {
			measure(1400, 900);
			setup();

			expect(screen.getByTestId('kanban-scroll-hint')).toHaveTextContent(/scroll sideways/i);
		});

		it('is absent when everything fits', () => {
			measure(900, 900);
			setup();

			expect(screen.queryByTestId('kanban-scroll-hint')).toBeNull();
		});
	});
});

describe('KanbanBoard failed move message (no page action)', () => {
	/** Contribution mode: the component posts the move itself and is the only place that says why it failed. */
	function contribution(post: () => Response) {
		stubFetch(call =>
			call.method === 'POST' ? post() : jsonResponse({ columns: sampleColumns(), version: 'v1' })
		);
		render(<KanbanBoard projectParam="p1" apiBase="/api/modules/task" />);
	}

	it('is one alert that stays until dismissed', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		contribution(() => jsonResponse({ error: 'status done needs a resolution' }, 409));
		await waitFor(() => expect(document.querySelector('[data-card-id="aaa11111"]')).not.toBeNull());

		dragTo('aaa11111', 'done');

		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent('status done needs a resolution');
		await vi.advanceTimersByTimeAsync(60_000);
		expect(screen.getAllByRole('alert')).toHaveLength(1);
		expect(screen.queryByTestId('kanban-move-failed')).toBeNull();

		fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }));

		expect(screen.queryByRole('alert')).toBeNull();
		vi.useRealTimers();
	});

	it('is replaced when the next move starts', async () => {
		let first = true;
		contribution(() => {
			if (first) {
				first = false;
				return jsonResponse({ error: 'first problem' }, 409);
			}
			return jsonResponse({});
		});
		await waitFor(() => expect(document.querySelector('[data-card-id="aaa11111"]')).not.toBeNull());

		dragTo('aaa11111', 'done');
		await screen.findByRole('alert');
		dragTo('bbb22222', 'doing');

		await waitFor(() => expect(screen.queryByText(/first problem/)).toBeNull());
	});
});
