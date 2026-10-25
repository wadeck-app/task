import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KeyValueList } from './KeyValueList.js';

describe('KeyValueList', () => {
	it('shows one key / value pair per entry, keys in monospace', () => {
		render(
			<KeyValueList
				entries={[
					{ key: 'branch', value: 'feat/x' },
					{ key: 'pr', value: '42' },
				]}
			/>
		);

		expect(screen.getByText('branch')).toHaveClass('font-mono');
		expect(screen.getByText('feat/x')).toBeInTheDocument();
		expect(screen.getByText('pr')).toBeInTheDocument();
		expect(screen.getByText('42')).toBeInTheDocument();
	});

	it('shows emptyText when there is no entry', () => {
		render(<KeyValueList entries={[]} emptyText="No metadata" />);

		expect(screen.getByText('No metadata')).toBeInTheDocument();
	});

	it('shows nothing when there is no entry and no emptyText', () => {
		const { container } = render(<KeyValueList entries={[]} />);

		expect(container).toBeEmptyDOMElement();
	});

	it('keeps long values inside the box and exposes them as a tooltip', () => {
		const long = 'x'.repeat(200);
		render(<KeyValueList entries={[{ key: 'k', value: long }]} />);

		expect(screen.getByText(long)).toHaveClass('break-words');
		expect(screen.getByText(long)).toHaveAttribute('title', long);
	});

	it('supports a compact density', () => {
		render(<KeyValueList entries={[{ key: 'k', value: 'v' }]} density="compact" />);

		expect(screen.getByTestId('key-value-list')).toHaveAttribute('data-density', 'compact');
	});
});
