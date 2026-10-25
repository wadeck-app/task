import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Notice } from './Notice.js';

describe('Notice', () => {
	it('shows the message and announces it', () => {
		render(<Notice label="The change is saved but 1 event was not delivered." variant="warning" />);

		expect(screen.getByRole('status')).toHaveTextContent('The change is saved but 1 event was not delivered.');
	});

	it('announces a danger notice as an alert', () => {
		render(<Notice label="Boom" variant="danger" />);

		expect(screen.getByRole('alert')).toHaveTextContent('Boom');
	});

	it('wraps long unbroken text inside its box instead of overflowing a narrow column', () => {
		render(<Notice label={'x'.repeat(300)} variant="warning" />);

		expect(screen.getByRole('status')).toHaveClass('break-words', 'min-w-0');
	});

	it('is tinted by variant', () => {
		const { rerender } = render(<Notice label="a" variant="info" />);
		const info = screen.getByRole('status').className;
		rerender(<Notice label="a" variant="warning" />);

		expect(screen.getByRole('status').className).not.toBe(info);
	});

	it('draws nothing for an empty label', () => {
		const { container } = render(<Notice label="" variant="info" />);

		expect(container).toBeEmptyDOMElement();
	});
});

describe('Notice with a long message', () => {
	const long = 'The change is saved but 2 queue events were not delivered. '.repeat(8);

	it('is clamped to a few lines with a "Show more" button', () => {
		render(<Notice label={long} variant="warning" />);

		expect(screen.getByRole('status').querySelector('p')).toHaveClass('line-clamp-3');
		expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
	});

	it('shows everything after "Show more" and clamps again after "Show less"', async () => {
		const { default: userEvent } = await import('@testing-library/user-event');
		render(<Notice label={long} variant="warning" />);

		await userEvent.setup().click(screen.getByRole('button', { name: 'Show more' }));
		expect(screen.getByRole('status').querySelector('p')).not.toHaveClass('line-clamp-3');

		await userEvent.setup().click(screen.getByRole('button', { name: 'Show less' }));
		expect(screen.getByRole('status').querySelector('p')).toHaveClass('line-clamp-3');
	});

	it('has no button for a short message', () => {
		render(<Notice label="short" variant="info" />);

		expect(screen.queryByRole('button')).toBeNull();
	});
});
