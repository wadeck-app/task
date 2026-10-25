import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './StatusBadge.js';

describe('StatusBadge', () => {
	it('shows the label with the colours of its tone', () => {
		render(<StatusBadge label="done" tone="success" />);

		const badge = screen.getByTestId('status-badge');
		expect(badge).toHaveTextContent('done');
		expect(badge).toHaveAttribute('data-tone', 'success');
		expect(badge).toHaveClass('bg-success-bg');
	});

	it('falls back to neutral for a tone it does not know', () => {
		render(<StatusBadge label="x" tone={'pink' as never} />);

		expect(screen.getByTestId('status-badge')).toHaveAttribute('data-tone', 'neutral');
	});

	it('draws an icon only when asked for one', () => {
		const { rerender } = render(<StatusBadge label="open" icon="none" />);
		expect(screen.getByTestId('status-badge').querySelector('svg')).toBeNull();

		rerender(<StatusBadge label="open" icon="done" />);
		expect(screen.getByTestId('status-badge').querySelector('svg')).not.toBeNull();
	});

	it('shows a dot instead of a pill with appearance dot', () => {
		render(<StatusBadge label="todo" appearance="dot" />);

		expect(screen.getByTestId('status-badge')).not.toHaveClass('bg-muted-bg');
		expect(screen.getByTestId('status-badge-dot')).toBeInTheDocument();
		expect(screen.getByText('todo')).toBeInTheDocument();
	});

	it('keeps the label as the accessible name when only the icon is drawn', () => {
		render(<StatusBadge label="blocked" appearance="icon" icon="blocked" />);

		expect(screen.getByLabelText('blocked')).toBeInTheDocument();
		expect(screen.queryByText('blocked')).toBeNull();
	});
});
