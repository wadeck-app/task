import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Panel } from './Panel.js';

describe('Panel', () => {
	it('shows its title, its count and its content', () => {
		render(<Panel title="Labels" count={3} items={<p>chips</p>} />);

		expect(screen.getByText('Labels')).toBeInTheDocument();
		expect(screen.getByTestId('panel-count')).toHaveTextContent('3');
		expect(screen.getByText('chips')).toBeInTheDocument();
	});

	it('shows no count badge without a count, and one for a count of zero', () => {
		const { rerender } = render(<Panel title="T" items="x" />);
		expect(screen.queryByTestId('panel-count')).toBeNull();

		rerender(<Panel title="T" count={0} items="x" />);
		expect(screen.getByTestId('panel-count')).toHaveTextContent('0');
	});

	it('renders the actions slot next to the title', () => {
		render(<Panel title="T" actions={<button>Add</button>} items="x" />);

		expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
	});

	it('collapses and expands from its header, and says which state it is in', async () => {
		const user = userEvent.setup();
		render(<Panel title="T" collapsible items={<p>inside</p>} />);
		const toggle = screen.getByRole('button', { name: /T/ });
		expect(toggle).toHaveAttribute('aria-expanded', 'true');

		await user.click(toggle);
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		expect(screen.queryByText('inside')).toBeNull();

		await user.click(toggle);
		expect(screen.getByText('inside')).toBeInTheDocument();
	});

	it('starts closed with defaultOpen false', () => {
		render(<Panel title="T" collapsible defaultOpen={false} items={<p>inside</p>} />);

		expect(screen.queryByText('inside')).toBeNull();
	});

	it('keeps its state when it re-renders with new content', async () => {
		const user = userEvent.setup();
		const { rerender } = render(<Panel title="T" collapsible items={<p>one</p>} />);
		await user.click(screen.getByRole('button', { name: /T/ }));

		rerender(<Panel title="T" collapsible items={<p>two</p>} />);

		expect(screen.queryByText('two')).toBeNull();
	});

	it('is not collapsible unless asked: the header is not a button', () => {
		render(<Panel title="T" items="x" />);

		expect(screen.queryByRole('button')).toBeNull();
	});

	it('takes its look from appearance', () => {
		const { rerender } = render(<Panel title="T" items="x" />);
		expect(screen.getByTestId('panel')).toHaveClass('border', 'rounded-lg');

		rerender(<Panel title="T" appearance="plain" items="x" />);
		expect(screen.getByTestId('panel')).not.toHaveClass('border');
	});
});
