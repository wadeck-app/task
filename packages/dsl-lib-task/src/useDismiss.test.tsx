import { fireEvent, render, screen } from '@testing-library/react';
import React, { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useDismiss } from './useDismiss.js';

function Harness({ onDismiss }: { onDismiss: () => void }): React.ReactElement {
	const ref = useRef<HTMLDivElement>(null);
	useDismiss(ref, true, onDismiss);
	return (
		<div>
			<div ref={ref}>
				<button type="button">inside</button>
			</div>
			<button type="button">outside</button>
			{/* What a modal dialog opened from inside the popover looks like: rendered elsewhere in the document. */}
			<div role="dialog" aria-label="Confirm">
				<button type="button">confirm</button>
			</div>
		</div>
	);
}

describe('useDismiss', () => {
	it('dismisses on a pointer or focus outside the element', () => {
		const onDismiss = vi.fn();
		render(<Harness onDismiss={onDismiss} />);

		fireEvent.pointerDown(screen.getByText('outside'));
		fireEvent.focusIn(screen.getByText('outside'));

		expect(onDismiss).toHaveBeenCalledTimes(2);
	});

	it('does not dismiss on the element itself', () => {
		const onDismiss = vi.fn();
		render(<Harness onDismiss={onDismiss} />);

		fireEvent.pointerDown(screen.getByText('inside'));
		fireEvent.focusIn(screen.getByText('inside'));

		expect(onDismiss).not.toHaveBeenCalled();
	});

	// The Delete dialog of the task page is opened from a popover: its content is a portal, so its focus is "outside" the
	// popover, and dismissing the popover unmounted the dialog the moment it opened (found in the browser).
	it('does not dismiss for a modal dialog (focus or pointer inside role="dialog")', () => {
		const onDismiss = vi.fn();
		render(<Harness onDismiss={onDismiss} />);

		fireEvent.focusIn(screen.getByText('confirm'));
		fireEvent.pointerDown(screen.getByText('confirm'));

		expect(onDismiss).not.toHaveBeenCalled();
	});
});
