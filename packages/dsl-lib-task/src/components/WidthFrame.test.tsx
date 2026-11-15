import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WidthFrame } from './WidthFrame.js';

const frame = () => screen.getByTestId('width-frame');

describe('WidthFrame', () => {
	it('shows its content', () => {
		render(<WidthFrame items={<p>content</p>} />);

		expect(within(frame()).getByText('content')).toBeInTheDocument();
	});

	it('is left-aligned and capped at 72rem by default: no centring, so no empty band on the left of a wide screen', () => {
		render(<WidthFrame items={<p>content</p>} />);

		expect(frame()).toHaveClass('max-w-6xl');
		expect(frame()).not.toHaveClass('mx-auto');
		expect(frame()).toHaveAttribute('data-width', 'left');
	});

	it.each([
		['wide', ['max-w-7xl']],
		['centered', ['mx-auto', 'max-w-6xl']],
		['full', ['max-w-full']],
		['reading', ['max-w-4xl']],
	])('applies the width prop %s', (width, classes) => {
		render(<WidthFrame width={width as 'wide'} items={<p>content</p>} />);

		expect(frame()).toHaveAttribute('data-width', width);
		expect(frame()).toHaveClass(...classes);
	});

	it('is a fixed width: it adds no row to the experiment dock and reads no storage or URL', () => {
		localStorage.setItem('ab.task-width', 'full');
		window.history.replaceState(null, '', '/?ab.task-width=reading');
		render(<WidthFrame items={<p>content</p>} />);

		expect(frame()).toHaveAttribute('data-width', 'left');
		expect(screen.queryByRole('group', { name: 'Width' })).toBeNull();
		localStorage.clear();
		window.history.replaceState(null, '', '/');
	});
});

describe('WidthFrame text wrapping', () => {
	// Seen at 390 px in github-b: a title or description of 600 characters without a space ran 7500 px wide, under the sidebar.
	// overflow-wrap is inherited, so one rule on the frame makes every text of every design break inside its column.
	it('breaks a word that does not fit, whatever the design inside', () => {
		render(<WidthFrame items={<p>content</p>} />);

		expect(frame().className).toContain('[overflow-wrap:anywhere]');
	});
});

describe('WidthFrame expandable', () => {
	const STORAGE_KEY = 'task.page.width';
	const toggle = () => screen.getByRole('button', { name: /full width|standard width/i });

	beforeEach(() => localStorage.clear());
	afterEach(() => localStorage.clear());

	it('shows no toggle unless the design asks for it', () => {
		render(<WidthFrame width="wide" items={<p>content</p>} />);

		expect(screen.queryByRole('button')).toBeNull();
	});

	it('starts at the width of the design with a button offering the full width', () => {
		render(<WidthFrame width="wide" expandable items={<p>content</p>} />);

		expect(frame()).toHaveAttribute('data-width', 'wide');
		expect(toggle()).toHaveAccessibleName('Use the full width');
		expect(toggle()).toHaveAttribute('aria-pressed', 'false');
	});

	it('goes to the full width on click, says so, and remembers the choice', () => {
		render(<WidthFrame width="wide" expandable items={<p>content</p>} />);

		fireEvent.click(toggle());

		expect(frame()).toHaveAttribute('data-width', 'full');
		expect(frame()).toHaveClass('max-w-full');
		expect(toggle()).toHaveAccessibleName('Use the standard width');
		expect(toggle()).toHaveAttribute('aria-pressed', 'true');
		expect(localStorage.getItem(STORAGE_KEY)).toBe('full');
	});

	it('goes back to the width of the design and forgets the choice', () => {
		localStorage.setItem(STORAGE_KEY, 'full');
		render(<WidthFrame width="wide" expandable items={<p>content</p>} />);
		expect(frame()).toHaveAttribute('data-width', 'full');

		fireEvent.click(toggle());

		expect(frame()).toHaveAttribute('data-width', 'wide');
		expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('ignores a stored value other than full (a stale or hand-edited value never changes the width)', () => {
		localStorage.setItem(STORAGE_KEY, 'narrow');
		render(<WidthFrame width="wide" expandable items={<p>content</p>} />);

		expect(frame()).toHaveAttribute('data-width', 'wide');
	});

	it('keeps the content inside the frame, the button is not part of the content', () => {
		render(<WidthFrame width="wide" expandable items={<p>content</p>} />);

		expect(within(frame()).getByText('content')).toBeInTheDocument();
		expect(within(frame()).getByRole('button')).toBe(toggle());
	});
});
