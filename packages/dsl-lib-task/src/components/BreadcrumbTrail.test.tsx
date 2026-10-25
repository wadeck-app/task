import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BreadcrumbTrail } from './BreadcrumbTrail.js';

const ITEMS = [
	{ label: 'Root', href: '/t/1' },
	{ label: 'Middle', href: '/t/2', title: 'The middle task' },
	{ label: 'Leaf', href: '/t/3' },
];

describe('BreadcrumbTrail', () => {
	it('links every item that has an href', () => {
		render(<BreadcrumbTrail items={ITEMS} />);

		expect(screen.getByRole('link', { name: 'Root' })).toHaveAttribute('href', '/t/1');
		expect(screen.getByRole('link', { name: 'Middle' })).toHaveAttribute('title', 'The middle task');
	});

	it('ends with the current label, not linked and marked current', () => {
		render(<BreadcrumbTrail items={ITEMS} currentLabel="This task" />);

		const current = screen.getByText('This task');
		expect(current).toHaveAttribute('aria-current', 'page');
		expect(current.closest('a')).toBeNull();
	});

	it('is a navigation landmark named Breadcrumb', () => {
		render(<BreadcrumbTrail items={ITEMS} />);

		expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
	});

	it('keeps the first and the last items and folds the middle ones when there are more than maxItems', () => {
		const many = Array.from({ length: 6 }, (_, i) => ({ label: `N${i}`, href: `/t/${i}` }));
		render(<BreadcrumbTrail items={many} maxItems={3} />);

		expect(screen.getByText('N0')).toBeInTheDocument();
		expect(screen.getByText('N5')).toBeInTheDocument();
		expect(screen.queryByText('N2')).toBeNull();
		expect(screen.getByTestId('breadcrumb-folded')).toHaveAttribute('title', expect.stringContaining('N2'));
	});

	it('uses the separator it was asked for', () => {
		const { rerender } = render(<BreadcrumbTrail items={ITEMS} separator="slash" />);
		expect(screen.getAllByTestId('breadcrumb-separator')[0]).toHaveTextContent('/');

		rerender(<BreadcrumbTrail items={ITEMS} separator="chevron" />);
		expect(screen.getAllByTestId('breadcrumb-separator')[0]!.querySelector('svg')).not.toBeNull();
	});

	it('renders nothing when there is nothing to show', () => {
		const { container } = render(<BreadcrumbTrail items={[]} />);

		expect(container).toBeEmptyDOMElement();
	});
});
