import { AbExperiments } from '@wadeck-app/dsl-ui';
import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WidthFrame } from './WidthFrame.js';

const frame = () => screen.getByTestId('width-frame');

beforeEach(() => {
	localStorage.clear();
	window.history.replaceState(null, '', '/');
});
afterEach(() => {
	localStorage.clear();
	window.history.replaceState(null, '', '/');
});

const withDock = (enabled: boolean) =>
	render(
		<AbExperiments enabled={enabled}>
			<WidthFrame items={<p>content</p>} />
		</AbExperiments>
	);

describe('WidthFrame', () => {
	it('shows its content', () => {
		withDock(true);

		expect(within(frame()).getByText('content')).toBeInTheDocument();
	});

	it('is left-aligned and capped at 72rem by default: no centring, so no empty band on the left of a wide screen', () => {
		withDock(true);

		expect(frame()).toHaveClass('max-w-6xl');
		expect(frame()).not.toHaveClass('mx-auto');
		expect(frame()).toHaveAttribute('data-width', 'left');
	});

	it.each([
		['centered', ['mx-auto', 'max-w-6xl']],
		['full', ['max-w-full']],
		['reading', ['max-w-4xl']],
	])('applies the stored choice %s', (choice, classes) => {
		localStorage.setItem('ab.task-width', choice);
		withDock(true);

		expect(frame()).toHaveAttribute('data-width', choice);
		expect(frame()).toHaveClass(...classes);
	});

	it('can be forced by a link (?ab.task-width=)', () => {
		window.history.replaceState(null, '', '/?ab.task-width=reading');
		withDock(true);

		expect(frame()).toHaveAttribute('data-width', 'reading');
	});

	it('adds its row to the dock and the buttons change the width', () => {
		withDock(true);

		const row = screen.getByRole('group', { name: 'Width' });
		fireEvent.click(within(row).getByRole('button', { name: 'Full width' }));
		expect(frame()).toHaveAttribute('data-width', 'full');
		expect(localStorage.getItem('ab.task-width')).toBe('full');
	});

	it('offers the four widths, the one of today among them', () => {
		withDock(true);

		const row = screen.getByRole('group', { name: 'Width' });
		expect(
			within(row)
				.getAllByRole('button')
				.map(b => b.textContent)
		).toEqual(['Left, 72rem', 'Centered, 72rem (today)', 'Full width', 'Reading, 56rem']);
	});

	it('with experiments off it is the default width, never reads the storage or the URL, and shows no row', () => {
		localStorage.setItem('ab.task-width', 'full');
		window.history.replaceState(null, '', '/?ab.task-width=reading');
		withDock(false);

		expect(frame()).toHaveAttribute('data-width', 'left');
		expect(screen.queryByRole('group', { name: 'Width' })).toBeNull();
	});
});

describe('WidthFrame text wrapping', () => {
	// Seen in current and github-b: a title or description of 600 characters without a space ran 7500 px wide, under the sidebar.
	// overflow-wrap is inherited, so one rule on the frame makes every text of every design break inside its column.
	it('breaks a word that does not fit, whatever the design inside', () => {
		withDock(true);

		expect(frame().className).toContain('[overflow-wrap:anywhere]');
	});
});
