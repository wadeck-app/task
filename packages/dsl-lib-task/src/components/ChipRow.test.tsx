import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChipRow } from './ChipRow.js';

describe('ChipRow', () => {
	it('renders its items', () => {
		render(<ChipRow items={[<span key="a">one</span>, <span key="b">two</span>]} />);

		expect(screen.getByText('one')).toBeInTheDocument();
		expect(screen.getByText('two')).toBeInTheDocument();
	});

	it('wraps onto the next line instead of overflowing a narrow column', () => {
		render(<ChipRow items={<span>one</span>} />);

		expect(screen.getByTestId('chip-row')).toHaveClass('flex', 'flex-wrap');
	});

	it('lets its children shrink (min-w-0) and uses the requested gap and alignment', () => {
		render(<ChipRow items={<span>one</span>} gap="gap-4" align="start" />);

		const row = screen.getByTestId('chip-row');
		expect(row).toHaveClass('gap-4', 'items-start', 'min-w-0');
	});
});
