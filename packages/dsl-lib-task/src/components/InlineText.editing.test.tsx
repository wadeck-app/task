import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../testHelpers.js';
import { resetReported } from '../reportOnce.js';
import { InlineText } from './InlineText.js';

afterEach(() => {
	resetReported();
	vi.restoreAllMocks();
});

function setup(extra: Partial<React.ComponentProps<typeof InlineText>> = {}) {
	const onAction = vi.fn().mockResolvedValue(undefined);
	const view = render(
		<InlineText
			value="Fix login"
			action="patchTask"
			valueParam="title"
			params={{ id: 't1' }}
			ariaLabel="Title"
			onAction={onAction}
			{...extra}
		/>
	);
	return { onAction, ...view };
}

describe('InlineText validate and cancel buttons', () => {
	it('shows a check and a cross at the right of the field, with names and tooltips', async () => {
		const user = userEvent.setup();
		setup();

		await user.click(screen.getByRole('button', { name: /Title/ }));
		const field = screen.getByRole('textbox');
		const save = screen.getByRole('button', { name: 'Save Title' });
		const cancel = screen.getByRole('button', { name: 'Cancel editing Title' });

		expect(save).toHaveAttribute('title', expect.stringMatching(/Save/));
		expect(cancel).toHaveAttribute('title', expect.stringMatching(/Cancel/));
		expect(field.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(save.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		// One row: the field and the buttons share the same flex parent chain, the buttons are not under the field.
		expect(screen.getByTestId('inline-text-actions')).not.toContainElement(field);
	});

	it('the check saves, the cross cancels', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.click(screen.getByRole('button', { name: /Title/ }));
		await user.type(screen.getByRole('textbox'), '!');
		await user.click(screen.getByRole('button', { name: 'Cancel editing Title' }));
		expect(onAction).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: /Title/ })).toHaveTextContent('Fix login');

		await user.click(screen.getByRole('button', { name: /Title/ }));
		await user.type(screen.getByRole('textbox'), '?');
		await user.click(screen.getByRole('button', { name: 'Save Title' }));
		await waitFor(() =>
			expect(onAction).toHaveBeenCalledWith('patchTask', { id: 't1' }, { body: { title: 'Fix login?' } })
		);
	});

	it('clicking a button of an unchanged editor is not lost to the blur', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.click(screen.getByRole('button', { name: /Title/ }));
		await user.click(screen.getByRole('button', { name: 'Save Title' }));

		expect(onAction).not.toHaveBeenCalled();
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it('shows a spinner on the check while saving and disables both buttons', async () => {
		const user = userEvent.setup();
		const pending = deferred<undefined>();
		setup({ onAction: vi.fn().mockReturnValue(pending.promise) });

		await user.click(screen.getByRole('button', { name: /Title/ }));
		await user.type(screen.getByRole('textbox'), 'x');
		expect(screen.queryByTestId('inline-text-spinner')).toBeNull();
		await user.click(screen.getByRole('button', { name: 'Save Title' }));

		const save = screen.getByRole('button', { name: 'Save Title' });
		expect(save).toContainElement(screen.getByTestId('inline-text-spinner'));
		expect(save).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Cancel editing Title' })).toBeDisabled();
		pending.resolve(undefined);
		await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
	});
});

describe('InlineText auto-grow', () => {
	const SCROLL = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
	afterEach(() => {
		if (SCROLL) {
			Object.defineProperty(HTMLElement.prototype, 'scrollHeight', SCROLL);
		} else {
			Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
		}
	});
	function measured(px: number): void {
		Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => px });
	}
	const LONG = 'word '.repeat(140);

	it('a 700 character text opens fully visible: the height follows the measured content, not 2 rows', async () => {
		measured(310);
		const user = userEvent.setup();
		setup({ value: LONG, multiline: true, ariaLabel: 'Description' });

		await user.click(screen.getByRole('button', { name: /Edit Description/ }));
		const field = screen.getByRole('textbox') as HTMLTextAreaElement;

		expect(field.style.height).toBe('310px');
		expect(field.style.overflowY).toBe('hidden');
		expect(field.rows).toBeGreaterThan(8);
	});

	it('caps the height (60vh) and scrolls inside beyond it', async () => {
		measured(5000);
		const user = userEvent.setup();
		setup({ value: LONG, multiline: true, ariaLabel: 'Description' });

		await user.click(screen.getByRole('button', { name: /Edit Description/ }));
		const field = screen.getByRole('textbox') as HTMLTextAreaElement;

		expect(field.style.maxHeight).toMatch(/60vh/);
		expect(field.style.overflowY).toBe('auto');
	});

	it('recomputes on input and on window resize', async () => {
		measured(100);
		const user = userEvent.setup();
		setup({ value: 'a', multiline: true, ariaLabel: 'Description' });

		await user.click(screen.getByRole('button', { name: /Edit Description/ }));
		const field = screen.getByRole('textbox') as HTMLTextAreaElement;
		expect(field.style.height).toBe('100px');

		measured(160);
		await user.type(field, 'b');
		expect(field.style.height).toBe('160px');

		measured(220);
		act(() => {
			window.dispatchEvent(new Event('resize'));
		});
		expect(field.style.height).toBe('220px');
	});

	it('the single-line editor is a full width input', async () => {
		const user = userEvent.setup();
		setup();

		await user.click(screen.getByRole('button', { name: /Title/ }));

		expect(screen.getByRole('textbox').className).toContain('w-full');
		expect(screen.getByRole('textbox').tagName).toBe('INPUT');
	});
});
