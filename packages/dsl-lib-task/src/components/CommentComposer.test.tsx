import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetReported } from '../reportOnce.js';
import { CONTROL_H } from '../ui/tokens.js';
import { CommentComposer } from './CommentComposer.js';
import type { CommentComposerProps } from './CommentComposer.js';

afterEach(() => {
	resetReported();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function setup(extra: Partial<CommentComposerProps> = {}) {
	const onAction = vi.fn().mockResolvedValue(undefined);
	const view = render(
		<CommentComposer action="addComment" params={{ id: 't1', projectParam: 'p1' }} onAction={onAction} {...extra} />
	);
	return { onAction, ...view };
}

const field = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'New comment' });
const send = (): HTMLElement => screen.getByRole('button', { name: 'Comment' });

describe('CommentComposer', () => {
	it('is a textarea above a "Comment" button that has the shared control height', () => {
		setup();

		expect(field().tagName).toBe('TEXTAREA');
		expect(send().className).toContain(CONTROL_H);
	});

	it('the button is disabled while the text is blank (spaces and new lines count as blank)', async () => {
		const user = userEvent.setup();
		setup();

		expect(send()).toBeDisabled();
		await user.type(field(), '   ');
		expect(send()).toBeDisabled();
		await user.type(field(), 'x');
		expect(send()).toBeEnabled();
	});

	it('sends the trimmed text in the JSON body with the params, then clears itself', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.type(field(), '  hello there  ');
		await user.click(send());

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
		expect(onAction).toHaveBeenCalledWith(
			'addComment',
			{ id: 't1', projectParam: 'p1' },
			{ body: { text: 'hello there' } }
		);
		await waitFor(() => expect(field()).toHaveValue(''));
		expect(send()).toBeDisabled();
	});

	it('Ctrl+Enter sends, a plain Enter adds a line', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.type(field(), 'a{Enter}b');
		expect(onAction).not.toHaveBeenCalled();
		expect(field()).toHaveValue('a\nb');
		await user.keyboard('{Control>}{Enter}{/Control}');

		await waitFor(() =>
			expect(onAction).toHaveBeenCalledWith('addComment', expect.anything(), { body: { text: 'a\nb' } })
		);
	});

	it('Ctrl+Enter on a blank text sends nothing', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.click(field());
		await user.keyboard('{Control>}{Enter}{/Control}');

		expect(onAction).not.toHaveBeenCalled();
	});

	it('is busy while the request runs: field read-only, button disabled with a spinner, no second send', async () => {
		const user = userEvent.setup();
		let finish!: (value: unknown) => void;
		const onAction = vi.fn(() => new Promise(resolve => (finish = resolve)));
		setup({ onAction });

		await user.type(field(), 'slow');
		await user.click(send());

		expect(field()).toHaveAttribute('readonly');
		expect(field()).toHaveAttribute('aria-busy', 'true');
		expect(send()).toBeDisabled();
		expect(screen.getByTestId('comment-composer-spinner')).toBeInTheDocument();
		await user.keyboard('{Control>}{Enter}{/Control}');
		expect(onAction).toHaveBeenCalledTimes(1);
		finish(undefined);
		await waitFor(() => expect(field()).toHaveValue(''));
		expect(screen.queryByTestId('comment-composer-spinner')).toBeNull();
	});

	it('on a failed request keeps the text and shows what to do', async () => {
		const user = userEvent.setup();
		const onAction = vi.fn().mockResolvedValue({ error: 'a comment cannot be blank', status: 400 });
		setup({ onAction });

		await user.type(field(), 'text');
		await user.click(send());

		expect(await screen.findByRole('alert')).toHaveTextContent('not saved');
		expect(field()).toHaveValue('text');
		expect(send()).toBeEnabled();
	});

	it('typing again clears the error', async () => {
		const user = userEvent.setup();
		const onAction = vi.fn().mockResolvedValue(false);
		setup({ onAction });

		await user.type(field(), 'a');
		await user.click(send());
		await screen.findByRole('alert');
		await user.type(field(), 'b');

		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('adds the author to the body when one is given', async () => {
		const user = userEvent.setup();
		const { onAction } = setup({ author: 'alice' });

		await user.type(field(), 'x');
		await user.click(send());

		await waitFor(() =>
			expect(onAction).toHaveBeenCalledWith('addComment', expect.anything(), {
				body: { text: 'x', author: 'alice' },
			})
		);
	});

	it('limits the text and shows a counter near the limit only', async () => {
		const user = userEvent.setup();
		setup({ maxLength: 10 });

		expect(field()).toHaveAttribute('maxlength', '10');
		expect(screen.queryByTestId('comment-composer-counter')).toBeNull();
		await user.type(field(), '12345678');
		expect(screen.getByTestId('comment-composer-counter')).toHaveTextContent('8/10');
	});

	it('grows with its text up to a cap, then scrolls', async () => {
		const user = userEvent.setup();
		const scroll = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get');
		scroll.mockReturnValue(100);
		setup();

		await user.type(field(), 'x');
		expect(field().style.height).toBe('100px');
		expect(field().style.overflowY).toBe('hidden');

		scroll.mockReturnValue(5000);
		await user.type(field(), 'y');
		const cap = Number.parseFloat(field().style.height);
		expect(cap).toBeLessThan(5000);
		expect(cap).toBeGreaterThanOrEqual(100);
		expect(field().style.overflowY).toBe('auto');
	});

	it('without a page the field and button are disabled with the reason', () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		render(<CommentComposer action="addComment" />);

		expect(field()).toBeDisabled();
		expect(send()).toBeDisabled();
		expect(send()).toHaveAttribute('title', expect.stringMatching(/page/));
	});

	it('uses the given placeholder and button label', () => {
		setup({ placeholder: 'Write a note', buttonLabel: 'Add note' });

		expect(field()).toHaveAttribute('placeholder', 'Write a note');
		expect(screen.getByRole('button', { name: 'Add note' })).toBeInTheDocument();
	});
});
