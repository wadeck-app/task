import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SplitLayout } from './SplitLayout.js';

describe('SplitLayout', () => {
	it('renders the main content and the side content', () => {
		render(<SplitLayout main={<p>the body</p>} side={<p>the facts</p>} />);

		expect(screen.getByText('the body')).toBeInTheDocument();
		expect(screen.getByText('the facts')).toBeInTheDocument();
	});

	it('puts the side column after the main one by default and stacks below the lg breakpoint', () => {
		render(<SplitLayout main={<p>the body</p>} side={<p>the facts</p>} />);

		const root = screen.getByTestId('split-layout');
		expect(root).toHaveClass('flex-col', 'lg:flex-row');
		expect(root.children[0]).toHaveTextContent('the body');
		expect(root.children[1]).toHaveTextContent('the facts');
	});

	it('puts the side column first on wide screens when sidePosition is left, keeping the main content first when stacked', () => {
		render(<SplitLayout main={<p>the body</p>} side={<p>the facts</p>} sidePosition="left" />);

		const root = screen.getByTestId('split-layout');
		expect(root).toHaveClass('lg:flex-row-reverse');
		expect(root.children[0]).toHaveTextContent('the body');
	});

	it('keeps the side column sticky on wide screens by default and not when sticky is false', () => {
		const { rerender } = render(<SplitLayout main={<p>a</p>} side={<p>b</p>} />);
		expect(screen.getByTestId('split-layout-side')).toHaveClass('lg:sticky');

		rerender(<SplitLayout main={<p>a</p>} side={<p>b</p>} sticky={false} />);
		expect(screen.getByTestId('split-layout-side')).not.toHaveClass('lg:sticky');
	});

	it('sizes the side column from sideWidth', () => {
		const { rerender } = render(<SplitLayout main={<p>a</p>} side={<p>b</p>} sideWidth="narrow" />);
		expect(screen.getByTestId('split-layout-side')).toHaveClass('lg:w-64');

		rerender(<SplitLayout main={<p>a</p>} side={<p>b</p>} sideWidth="wide" />);
		expect(screen.getByTestId('split-layout-side')).toHaveClass('lg:w-96');
	});

	it('never lets the main column overflow its flex parent', () => {
		render(<SplitLayout main={<p>a</p>} side={<p>b</p>} />);

		expect(screen.getByTestId('split-layout-main')).toHaveClass('min-w-0', 'flex-1');
	});
});
