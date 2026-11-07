import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TitleText } from './TitleText.js';

const LONG = 'A very long description that goes on and on. '.repeat(14);

describe('TitleText', () => {
	it('renders the text as the page heading', () => {
		render(<TitleText text="Fix login redirect" />);

		expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Fix login redirect');
	});

	it('size sm is body text, not a heading (the full description under a short title)', () => {
		render(<TitleText text="The whole description" size="sm" lines={0} />);

		expect(screen.queryByRole('heading')).toBeNull();
		expect(screen.getByText('The whole description')).toHaveClass('text-sm');
	});

	it('draws nothing for an empty text', () => {
		const { container } = render(<TitleText text="" />);

		expect(container).toBeEmptyDOMElement();
	});

	it.each([
		['lg', 'text-lg'],
		['xl', 'text-xl'],
		['2xl', 'text-2xl'],
	] as const)('size %s uses %s, never the 4xl of a landing page', (size, cls) => {
		render(<TitleText text="t" size={size} />);

		const heading = screen.getByRole('heading');
		expect(heading).toHaveClass(cls);
		expect(heading.className).not.toMatch(/text-[3-9]xl/);
	});

	it('clamps to the given number of lines', () => {
		render(<TitleText text={LONG} lines={2} />);

		expect(screen.getByRole('heading')).toHaveClass('line-clamp-2');
	});

	it('does not clamp with lines 0', () => {
		render(<TitleText text={LONG} lines={0} />);

		expect(screen.getByRole('heading').className).not.toMatch(/line-clamp/);
	});

	it('wraps an unbroken word inside its box', () => {
		render(<TitleText text={'x'.repeat(400)} />);

		const heading = screen.getByRole('heading');
		expect(heading).toHaveClass('min-w-0', 'break-words');
		expect(heading.className).toContain('[overflow-wrap:anywhere]');
	});

	it('puts the whole text in the tooltip while it is clamped', () => {
		render(<TitleText text={LONG} lines={1} tooltip />);

		expect(screen.getByRole('heading')).toHaveAttribute('title', LONG.trim());
	});

	it('has no tooltip unless asked, nor when nothing is clamped', () => {
		const { rerender } = render(<TitleText text={LONG} lines={2} />);
		expect(screen.getByRole('heading')).not.toHaveAttribute('title');
		rerender(<TitleText text={LONG} lines={0} tooltip />);
		expect(screen.getByRole('heading')).not.toHaveAttribute('title');
	});

	it('offers "Show more" on a long clamped text and expands it, then folds it back', () => {
		render(<TitleText text={LONG} lines={2} expandable />);

		fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
		expect(screen.getByRole('heading').className).not.toMatch(/line-clamp/);
		fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
		expect(screen.getByRole('heading')).toHaveClass('line-clamp-2');
	});

	it('offers no button for a text that fits, or without expandable', () => {
		const { rerender } = render(<TitleText text="Short" lines={2} expandable />);
		expect(screen.queryByRole('button')).toBeNull();
		rerender(<TitleText text={LONG} lines={2} />);
		expect(screen.queryByRole('button')).toBeNull();
	});

	it('sets aria-expanded on the toggle', () => {
		render(<TitleText text={LONG} lines={2} expandable />);

		const toggle = screen.getByRole('button', { name: 'Show more' });
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		fireEvent.click(toggle);
		expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
	});
});
