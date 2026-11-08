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

describe('InlineText', () => {
	it('shows the text as a button that starts the edit', () => {
		setup();

		expect(screen.getByRole('button', { name: /Title/ })).toHaveTextContent('Fix login');
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it('shows the placeholder when the value is empty', () => {
		setup({ value: '', placeholder: 'Add a title' });

		expect(screen.getByRole('button', { name: /Title/ })).toHaveTextContent('Add a title');
	});

	it('is plain text when read-only or without a handler', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { unmount } = setup({ readOnly: true });
		expect(screen.queryByRole('button')).toBeNull();
		expect(screen.getByText('Fix login')).toBeInTheDocument();
		unmount();

		render(<InlineText value="x" action="a" ariaLabel="Title" />);
		expect(screen.getByRole('button', { name: /Title/ })).toBeDisabled();
		expect(error).toHaveBeenCalledTimes(1);
	});

	it('edits in a focused field holding the value, saves on Enter with the value in the body', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.click(screen.getByRole('button', { name: /Title/ }));
		const field = screen.getByRole('textbox', { name: 'Title' });
		expect(field).toHaveFocus();
		expect(field).toHaveValue('Fix login');
		await user.clear(field);
		await user.type(field, 'Fix logout{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
		expect(onAction).toHaveBeenCalledWith('patchTask', { id: 't1' }, { body: { title: 'Fix logout' } });
		await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
	});

	it('cancels on Escape and restores the text', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.click(screen.getByRole('button', { name: /Title/ }));
		await user.type(screen.getByRole('textbox'), 'zzz{Escape}');

		expect(onAction).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: /Title/ })).toHaveTextContent('Fix login');
		expect(screen.getByRole('button', { name: /Title/ })).toHaveFocus();
	});

	it('does not call the action when nothing changed', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.click(screen.getByRole('button', { name: /Title/ }));
		await user.keyboard('{Enter}');

		expect(onAction).not.toHaveBeenCalled();
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it('refuses an empty value with a message, unless allowEmpty', async () => {
		const user = userEvent.setup();
		const { onAction, unmount } = setup();

		await user.click(screen.getByRole('button', { name: /Title/ }));
		await user.clear(screen.getByRole('textbox'));
		await user.keyboard('{Enter}');

		expect(onAction).not.toHaveBeenCalled();
		expect(screen.getByRole('alert')).toHaveTextContent(/empty/i);
		unmount();

		const second = setup({ allowEmpty: true });
		await user.click(screen.getByRole('button', { name: /Title/ }));
		await user.clear(screen.getByRole('textbox'));
		await user.keyboard('{Enter}');
		await waitFor(() =>
			expect(second.onAction).toHaveBeenCalledWith('patchTask', { id: 't1' }, { body: { title: '' } })
		);
	});

	it('multi-line: Enter adds a line, Ctrl+Enter saves', async () => {
		const user = userEvent.setup();
		const { onAction } = setup({ multiline: true, value: 'a' });

		await user.click(screen.getByRole('button', { name: /Title/ }));
		await user.type(screen.getByRole('textbox'), '{Enter}b');
		expect(onAction).not.toHaveBeenCalled();
		await user.keyboard('{Control>}{Enter}{/Control}');

		await waitFor(() =>
			expect(onAction).toHaveBeenCalledWith('patchTask', { id: 't1' }, { body: { title: 'a\nb' } })
		);
	});

	it('limits the length and says how much is left near the limit', async () => {
		const user = userEvent.setup();
		setup({ maxLength: 12, multiline: true });

		await user.click(screen.getByRole('button', { name: /Title/ }));

		expect(screen.getByRole('textbox')).toHaveAttribute('maxlength', '12');
		expect(screen.getByTestId('inline-text-counter')).toHaveTextContent('9/12');
	});

	it('is busy while saving: read-only (not disabled, the focus stays), aria-busy, and a second Enter is ignored', async () => {
		const user = userEvent.setup();
		const pending = deferred<undefined>();
		const onAction = vi.fn().mockReturnValue(pending.promise);
		setup({ onAction });

		await user.click(screen.getByRole('button', { name: /Title/ }));
		await user.type(screen.getByRole('textbox'), 'x{Enter}{Enter}');

		const field = screen.getByRole('textbox');
		expect(field).toHaveAttribute('aria-busy', 'true');
		expect(field).toHaveAttribute('readonly');
		expect(field).not.toBeDisabled();
		expect(onAction).toHaveBeenCalledTimes(1);
		pending.resolve(undefined);
		await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
	});

	it('Enter followed by the blur it causes saves once', async () => {
		const user = userEvent.setup();
		const pending = deferred<undefined>();
		const onAction = vi.fn().mockReturnValue(pending.promise);
		setup({ onAction });

		await user.click(screen.getByRole('button', { name: /Title/ }));
		await user.type(screen.getByRole('textbox'), 'x{Enter}');
		await user.tab();
		pending.resolve(undefined);

		await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
		expect(onAction).toHaveBeenCalledTimes(1);
	});

	it('blur never saves a changed value silently: the editor stays open; an unchanged blur just leaves', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.click(screen.getByRole('button', { name: /Title/ }));
		await user.click(document.body);
		expect(onAction).not.toHaveBeenCalled();
		expect(screen.queryByRole('textbox')).toBeNull();

		await user.click(screen.getByRole('button', { name: /Title/ }));
		await user.type(screen.getByRole('textbox'), '!');
		await user.tab();
		await user.click(document.body);
		expect(onAction).not.toHaveBeenCalled();
		expect(screen.getByRole('textbox')).toHaveValue('Fix login!');
	});

	it('Escape does not save through the blur that follows', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.click(screen.getByRole('button', { name: /Title/ }));
		await user.type(screen.getByRole('textbox'), '!{Escape}');
		await user.tab();

		expect(onAction).not.toHaveBeenCalled();
	});

	it('keeps the editor open with the text and an alert when the save failed', async () => {
		const user = userEvent.setup();
		const onAction = vi.fn().mockResolvedValue({ error: 'too long', status: 400 });
		setup({ onAction });

		await user.click(screen.getByRole('button', { name: /Title/ }));
		await user.type(screen.getByRole('textbox'), '!{Enter}');

		await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
		expect(screen.getByRole('textbox')).toHaveValue('Fix login!');
		expect(screen.getByRole('alert')).toHaveTextContent(/not saved/i);
		expect(screen.getByRole('textbox')).not.toHaveAttribute('readonly');
	});

	it('does not jump: the editor keeps the text classes of the display', async () => {
		const user = userEvent.setup();
		setup({ textClass: 'text-xl font-semibold' });

		expect(screen.getByRole('button', { name: /Title/ }).className).toContain('text-xl');
		await user.click(screen.getByRole('button', { name: /Title/ }));
		expect(screen.getByRole('textbox').className).toContain('text-xl');
	});
});

describe('InlineText collapsedLines (a long prompt)', () => {
	const LONG = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long prompt`).join('\n');

	it('clamps a long text to the given number of lines and offers Show more, which unfolds it and folds it back', async () => {
		const user = userEvent.setup();
		setup({ value: LONG, multiline: true, collapsedLines: 6, ariaLabel: 'Description' });

		const display = screen.getByRole('button', { name: /Edit Description/ });
		expect(display.querySelector('[data-clamped="true"]')).not.toBeNull();
		await user.click(screen.getByRole('button', { name: 'Show more' }));
		expect(display.querySelector('[data-clamped="true"]')).toBeNull();
		await user.click(screen.getByRole('button', { name: 'Show less' }));
		expect(display.querySelector('[data-clamped="true"]')).not.toBeNull();
	});

	it('does not clamp nor offer Show more for a short text', () => {
		setup({ value: 'short', multiline: true, collapsedLines: 6 });

		expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
		expect(document.querySelector('[data-clamped="true"]')).toBeNull();
	});

	it('Show more does not start the edit; clicking the text still does', async () => {
		const user = userEvent.setup();
		setup({ value: LONG, multiline: true, collapsedLines: 6, ariaLabel: 'Description' });

		await user.click(screen.getByRole('button', { name: 'Show more' }));
		expect(screen.queryByRole('textbox')).toBeNull();
		await user.click(screen.getByRole('button', { name: /Edit Description/ }));
		expect(screen.getByRole('textbox')).toBeInTheDocument();
		// While editing, the whole text is in the field: no clamp, no toggle.
		expect(screen.queryByRole('button', { name: /Show/ })).toBeNull();
	});
});
