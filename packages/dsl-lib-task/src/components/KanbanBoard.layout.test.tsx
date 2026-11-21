import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
			defaultVariant="columns"
			onAction={onAction}
			{...extra}
		/>
	);
}

function dragTo(id: string, target: HTMLElement): void {
	const card = document.querySelector(`[data-card-id="${id}"]`) as HTMLElement;
	const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => id), effectAllowed: '', dropEffect: '' };
	fireEvent.dragStart(card, { dataTransfer });
	fireEvent.dragOver(target, { dataTransfer });
	fireEvent.drop(target, { dataTransfer });
	fireEvent.dragEnd(card, { dataTransfer });
}

describe('KanbanBoard widths', () => {
	it.each(['columns', 'compact'] as const)(
		'%s: columns share the width and shrink to a minimum, they do not have a fixed width',
		variant => {
			setup({ defaultVariant: variant });

			for (const status of ['todo', 'doing', 'done']) {
				const classes = screen.getByTestId(`kanban-column-${status}`).className;
				expect(classes).toMatch(/\bflex-1\b/);
				expect(classes).toMatch(/\bmin-w-\[1[3-9]rem\]/);
				expect(classes).not.toMatch(/\bw-(60|72)\b/);
			}
		}
	);

	it('the strip scrolls sideways beyond the minimum widths and is never wider than its container', () => {
		setup();

		const strip = screen.getByTestId('kanban-strip');
		expect(strip.className).toMatch(/overflow-x-auto/);
		expect(strip.className).toMatch(/\bmin-w-0\b/);
		expect(strip.className).toMatch(/\bmax-w-full\b/);
	});

	it('swimlanes: the grid has the same minimum per column and the rows share the strip', () => {
		setup({ defaultVariant: 'swimlanes' });

		const strip = screen.getByTestId('kanban-strip');
		const inner = strip.firstElementChild as HTMLElement;
		// 3 columns of 13rem and 2 gaps of 1rem.
		expect(inner.style.minWidth).toBe('41rem');
		expect(inner.className).not.toMatch(/min-w-max/);
		const grid = screen.getByTestId('kanban-cell-urgent-doing').parentElement as HTMLElement;
		expect(grid.style.gridTemplateColumns).toBe('repeat(3, minmax(13rem, 1fr))');
	});

	it('rails sit in the same scrolling strip', () => {
		setup({ defaultVariant: 'rails' });

		expect(screen.getByTestId('kanban-strip').className).toMatch(/overflow-x-auto/);
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

describe('KanbanBoard compact cards', () => {
	it('the headline wraps on two lines and keeps room to read, instead of an ellipsis after 3 letters', () => {
		setup({ defaultVariant: 'compact' });

		const headline = screen.getByRole('link', { name: 'Write the spec' });
		expect(headline.className).toMatch(/line-clamp-2/);
		expect(headline.className).toMatch(/min-w-\[10rem\]/);
		expect(headline.className).not.toMatch(/\btruncate\b/);
		// The line may wrap so the headline gets its own row when the id, pill and menu take the width.
		expect(headline.parentElement!.className).toMatch(/flex-wrap/);
	});
});

describe('KanbanBoard switcher on a narrow screen', () => {
	it('wraps in rows inside the viewport, every button at least 40px high', () => {
		setup({ variantSwitcher: true });

		const bar = screen.getByRole('toolbar', { name: 'Kanban variant' });
		expect(bar.className).toMatch(/flex-wrap/);
		expect(bar.className).toMatch(/\bw-max\b/);
		expect(bar.className).toMatch(/max-w-\[calc\(100vw-1rem\)\]/);
		expect(bar.className).not.toMatch(/overflow-x/);
		const buttons = within(bar).getAllByRole('button');
		expect(buttons).toHaveLength(5);
		for (const button of buttons) {
			expect(button.className).toMatch(/\bh-10\b/);
		}
	});

	it('leaves room under the board for the two bars (layout and sort), only while they are shown', () => {
		const { unmount } = setup({ variantSwitcher: true });
		expect(screen.getByTestId('kanban-board').className).toMatch(/\bpb-72\b/);
		expect(screen.getByTestId('kanban-board').className).toMatch(/\bsm:pb-48\b/);
		unmount();

		setup({ variantSwitcher: false });
		expect(screen.getByTestId('kanban-board').className).not.toMatch(/\bpb-/);
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

		dragTo('aaa11111', screen.getByTestId('kanban-column-done'));

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

		dragTo('aaa11111', screen.getByTestId('kanban-column-done'));
		await screen.findByRole('alert');
		dragTo('bbb22222', screen.getByTestId('kanban-column-doing'));

		await waitFor(() => expect(screen.queryByText(/first problem/)).toBeNull());
	});
});
