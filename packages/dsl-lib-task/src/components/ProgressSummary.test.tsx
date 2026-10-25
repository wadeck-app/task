import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProgressSummary } from './ProgressSummary.js';

describe('ProgressSummary', () => {
	it('draws a bar with the share done and a default sentence', () => {
		render(<ProgressSummary done={2} total={5} />);

		const bar = screen.getByRole('progressbar');
		expect(bar).toHaveAttribute('aria-valuenow', '2');
		expect(bar).toHaveAttribute('aria-valuemax', '5');
		expect(screen.getByText('2 of 5 done')).toBeInTheDocument();
	});

	it('uses the text it was given', () => {
		render(<ProgressSummary done={1} total={2} text="half way" />);

		expect(screen.getByText('half way')).toBeInTheDocument();
	});

	it('draws one segment per task with appearance segments', () => {
		render(<ProgressSummary done={2} total={4} appearance="segments" />);

		const segments = screen.getAllByTestId('progress-segment');
		expect(segments).toHaveLength(4);
		expect(segments.filter(s => s.getAttribute('data-done') === 'true')).toHaveLength(2);
	});

	it('shows only the sentence with appearance text', () => {
		render(<ProgressSummary done={1} total={3} appearance="text" />);

		expect(screen.queryByRole('progressbar')).toBeNull();
		expect(screen.getByText('1 of 3 done')).toBeInTheDocument();
	});

	it('draws a ring with its percentage', () => {
		render(<ProgressSummary done={1} total={4} appearance="ring" />);

		expect(screen.getByRole('progressbar')).toBeInTheDocument();
		expect(screen.getByText('25%')).toBeInTheDocument();
	});

	it('does not divide by zero when there is nothing to do', () => {
		render(<ProgressSummary done={0} total={0} />);

		expect(screen.getByText('Nothing to do')).toBeInTheDocument();
		expect(screen.queryByText(/NaN/)).toBeNull();
	});

	it('never shows more than 100%', () => {
		render(<ProgressSummary done={9} total={3} appearance="ring" />);

		expect(screen.getByText('100%')).toBeInTheDocument();
	});
});
