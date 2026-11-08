import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Caption } from './Caption.js';
import { CONTROL_H } from '../ui/tokens.js';

describe('Caption', () => {
	it('is a muted span of the control height, centered, that wraps long words', () => {
		render(<Caption text="a very long caption" />);

		const el = screen.getByText('a very long caption');
		expect(el.tagName).toBe('SPAN');
		for (const c of ['text-sm', 'text-muted', 'min-w-0', 'break-words', 'inline-flex', 'items-center', CONTROL_H]) {
			expect(el.className.split(/\s+/)).toContain(c);
		}
	});

	it('default tone uses the content colour; mono uses the mono font', () => {
		render(<Caption text="x" tone="default" mono />);

		const el = screen.getByText('x');
		expect(el.className).toContain('text-content');
		expect(el.className).not.toContain('text-muted');
		expect(el.className).toContain('font-mono');
	});

	it('renders nothing visible for a non-string text instead of crashing', () => {
		render(<Caption text={undefined as never} />);

		expect(screen.queryByText('undefined')).toBeNull();
	});
});
