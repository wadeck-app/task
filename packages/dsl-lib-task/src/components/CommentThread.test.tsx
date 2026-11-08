import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetReported } from '../reportOnce.js';
import { CONTROL_H } from '../ui/tokens.js';
import { CommentThread } from './CommentThread.js';
import type { CommentThreadProps } from './CommentThread.js';

afterEach(() => {
	resetReported();
	vi.restoreAllMocks();
});

const NOW = '2026-11-08T12:00:00.000Z';
const COMMENTS = [
	{ id: 'c1', at: '2026-11-08T11:30:00.000Z', text: 'First line\nsecond line', author: 'alice' },
	{
		id: 'c2',
		at: '2026-11-06T09:00:00.000Z',
		text: 'Anonymous and edited',
		editedAt: '2026-11-07T10:00:00.000Z',
	},
];

describe('CommentThread order', () => {
	it('lists the comments in the given order, newest first only on request', () => {
		const { rerender } = render(<CommentThread comments={COMMENTS} now={NOW} readOnly />);
		const texts = () => screen.getAllByTestId('comment').map(node => node.textContent);
		expect(texts()[0]).toContain('First line');
		rerender(<CommentThread comments={COMMENTS} now={NOW} readOnly newestFirst />);
		expect(texts()[0]).toContain('Anonymous');
	});
});

function setup(extra: Partial<CommentThreadProps> = {}) {
	const onAction = vi.fn().mockResolvedValue(undefined);
	const view = render(
		<CommentThread
			comments={COMMENTS}
			now={NOW}
			editAction="editComment"
			removeAction="removeComment"
			params={{ id: 't1', projectParam: 'p1' }}
			onAction={onAction}
			{...extra}
		/>
	);
	return { onAction, ...view };
}

const rows = (): HTMLElement[] => screen.getAllByTestId('comment');

describe('CommentThread reading', () => {
	it('lists the comments in the given order with their full text, line breaks kept and long words wrapped', () => {
		setup();

		expect(rows()).toHaveLength(2);
		const text = within(rows()[0]!).getByTestId('inline-text');
		expect(text).toHaveTextContent('First line second line');
		expect(text.className).toContain('whitespace-pre-wrap');
		expect(text.className).toContain('break-words');
		expect(rows()[0]).toHaveAttribute('data-comment-id', 'c1');
	});

	it('shows the author when there is one and no placeholder name when there is none', () => {
		setup();

		expect(within(rows()[0]!).getByText('alice')).toBeInTheDocument();
		expect(within(rows()[1]!).queryByText(/someone|anonymous user|unknown/i)).toBeNull();
		expect(within(rows()[1]!).queryByTestId('comment-author')).toBeNull();
	});

	it('prints a relative time with the absolute UTC instant in the tooltip', () => {
		setup();

		const time = within(rows()[0]!).getByText('30 minutes ago');
		expect(time.tagName).toBe('TIME');
		expect(time).toHaveAttribute('dateTime', '2026-11-08T11:30:00.000Z');
		expect(time).toHaveAttribute('title', '2026-11-08 11:30 UTC');
		expect(within(rows()[1]!).getByText('2 days ago')).toBeInTheDocument();
	});

	it('marks an edited comment, with the edit instant in the tooltip, and nothing on an untouched one', () => {
		setup();

		expect(within(rows()[0]!).queryByText('edited')).toBeNull();
		const marker = within(rows()[1]!).getByText('edited');
		expect(marker).toHaveAttribute('title', 'Edited 2026-11-07 10:00 UTC');
	});

	it('says there is no comment yet when the list is empty, with the given text', () => {
		const { rerender } = setup({ comments: [] });
		expect(screen.getByText('No comments yet.')).toBeInTheDocument();

		rerender(<CommentThread comments={[]} emptyText="Be the first." now={NOW} />);
		expect(screen.getByText('Be the first.')).toBeInTheDocument();
	});

	it('ignores entries that are not comments instead of crashing', () => {
		setup({ comments: [null, 'x', { id: 'c9' }, COMMENTS[0]] as never });

		expect(rows()).toHaveLength(1);
	});

	it('read only: no edit and no delete control', () => {
		setup({ readOnly: true });

		expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
		expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
		expect(rows()[0]).toHaveTextContent('First line');
	});
});

describe('CommentThread editing', () => {
	it('edits in place with the InlineText pattern: Ctrl+Enter sends the new text to the edit action with the comment id', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.click(within(rows()[0]!).getByRole('button', { name: /Edit Comment/ }));
		const field = screen.getByRole('textbox');
		expect(field).toHaveValue('First line\nsecond line');
		await user.clear(field);
		await user.type(field, 'Changed');
		await user.keyboard('{Control>}{Enter}{/Control}');

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
		expect(onAction).toHaveBeenCalledWith(
			'editComment',
			{ id: 't1', projectParam: 'p1', commentId: 'c1' },
			{ body: { text: 'Changed' } }
		);
	});

	it('shows the check and the cross, and Esc cancels without calling the action', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.click(within(rows()[0]!).getByRole('button', { name: /Edit Comment/ }));
		expect(screen.getByRole('button', { name: 'Save Comment' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Cancel editing Comment' })).toBeInTheDocument();
		await user.type(screen.getByRole('textbox'), ' more');
		await user.keyboard('{Escape}');

		expect(screen.queryByRole('textbox')).toBeNull();
		expect(onAction).not.toHaveBeenCalled();
	});

	it('without an edit action the text is not editable', () => {
		setup({ editAction: undefined });

		expect(screen.queryByRole('button', { name: /Edit Comment/ })).toBeNull();
	});
});

describe('CommentThread deleting', () => {
	it('asks for a confirmation first, nothing is sent until it is given', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.click(within(rows()[0]!).getByRole('button', { name: 'Delete comment' }));

		expect(within(rows()[0]!).getByText('Delete this comment?')).toBeInTheDocument();
		expect(onAction).not.toHaveBeenCalled();
	});

	it('Cancel closes the confirmation, no request', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.click(within(rows()[0]!).getByRole('button', { name: 'Delete comment' }));
		await user.click(within(rows()[0]!).getByRole('button', { name: 'Cancel' }));

		expect(screen.queryByText('Delete this comment?')).toBeNull();
		expect(within(rows()[0]!).getByRole('button', { name: 'Delete comment' })).toBeInTheDocument();
		expect(onAction).not.toHaveBeenCalled();
	});

	it('Delete runs the remove action with the comment id and no body', async () => {
		const user = userEvent.setup();
		const { onAction } = setup();

		await user.click(within(rows()[1]!).getByRole('button', { name: 'Delete comment' }));
		await user.click(within(rows()[1]!).getByRole('button', { name: 'Delete' }));

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
		expect(onAction).toHaveBeenCalledWith('removeComment', { id: 't1', projectParam: 'p1', commentId: 'c2' });
	});

	it('a failed deletion keeps the comment, says so, and the confirmation stays to retry', async () => {
		const user = userEvent.setup();
		const onAction = vi.fn().mockResolvedValue({ error: 'Comment not found', status: 404 });
		setup({ onAction });

		await user.click(within(rows()[0]!).getByRole('button', { name: 'Delete comment' }));
		await user.click(within(rows()[0]!).getByRole('button', { name: 'Delete' }));

		expect(await screen.findByRole('alert')).toHaveTextContent('not deleted');
		expect(within(rows()[0]!).getByRole('button', { name: 'Delete' })).toBeEnabled();
	});

	it('the buttons are disabled while the request runs', async () => {
		const user = userEvent.setup();
		let finish!: () => void;
		const onAction = vi.fn(() => new Promise<void>(resolve => (finish = resolve)));
		setup({ onAction });

		await user.click(within(rows()[0]!).getByRole('button', { name: 'Delete comment' }));
		await user.click(within(rows()[0]!).getByRole('button', { name: 'Delete' }));

		expect(within(rows()[0]!).getByRole('button', { name: 'Delete' })).toBeDisabled();
		expect(within(rows()[0]!).getByRole('button', { name: 'Cancel' })).toBeDisabled();
		finish();
	});

	it('without a remove action there is no delete control; without a page the control is disabled with a reason', () => {
		const { unmount } = setup({ removeAction: undefined });
		expect(screen.queryByRole('button', { name: 'Delete comment' })).toBeNull();
		unmount();

		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		render(<CommentThread comments={COMMENTS} now={NOW} removeAction="removeComment" />);
		const button = screen.getAllByRole('button', { name: 'Delete comment' })[0]!;
		expect(button).toBeDisabled();
		expect(button).toHaveAttribute('title', expect.stringMatching(/page/));
	});

	it('the delete control uses the shared control size', () => {
		setup();

		expect(within(rows()[0]!).getByRole('button', { name: 'Delete comment' }).className).toContain(CONTROL_H);
	});
});
