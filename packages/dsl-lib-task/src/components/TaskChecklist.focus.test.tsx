import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetReported } from '../reportOnce.js';
import { deferred } from '../testHelpers.js';
import { TaskChecklist } from './TaskChecklist.js';
import type { ChecklistRow } from './TaskChecklist.js';

afterEach(() => {
	resetReported();
	vi.restoreAllMocks();
});

const ROW: ChecklistRow = { id: 'aaa11111', title: 'First', status: 'todo', terminal: false };

const FIELD = { name: 'Add sub-task' };

/**
 * The page the shell draws: after the action the sources reload and the rows change. `rowsAfter` is what the checklist is given
 * when the action resolves, so a first sub-task turns an empty list (add field drawn at one place of the tree) into a list
 * (add field drawn at another place: a NEW element).
 */
function Page({
	rowsAfter,
	answer,
	extra,
}: {
	rowsAfter: ChecklistRow[];
	answer: () => Promise<unknown>;
	extra?: React.ReactNode;
}): React.ReactElement {
	const [rows, setRows] = React.useState<ChecklistRow[]>([]);
	const onAction = async (): Promise<unknown> => {
		const result = await answer();
		setRows(rowsAfter);
		return result;
	};
	return (
		<div>
			<TaskChecklist
				rows={rows}
				addAction="createSubtask"
				parentId="t1"
				titleKey="title"
				params={{ id: 't1' }}
				onAction={onAction}
			/>
			{extra}
		</div>
	);
}

describe('TaskChecklist: focus after an add', () => {
	it('puts the focus back on the field after the add, also when the list went from empty to filled (a new field is drawn)', async () => {
		const user = userEvent.setup();
		render(<Page rowsAfter={[ROW]} answer={() => Promise.resolve(undefined)} />);
		const before = screen.getByRole('textbox', FIELD);

		await user.type(before, 'first{Enter}');

		await waitFor(() => expect(screen.getAllByTestId('checklist-row')).toHaveLength(1));
		const after = screen.getByRole('textbox', FIELD);
		expect(after).not.toBe(before);
		await waitFor(() => expect(after).toHaveFocus());
		expect(after).toHaveValue('');
	});

	it('lets the next sub-task be typed at once: keys after the first Enter land in the field', async () => {
		const user = userEvent.setup();
		const calls: unknown[] = [];
		const onAction = vi.fn((_name: string, _params: unknown, options?: { body?: unknown }) => {
			calls.push(options?.body);
			return Promise.resolve(undefined);
		});
		render(
			<TaskChecklist rows={[ROW]} addAction="createSubtask" titleKey="title" parentId="t1" onAction={onAction} />
		);

		await user.click(screen.getByRole('textbox', FIELD));
		await user.keyboard('one{Enter}');
		await waitFor(() => expect(screen.getByRole('textbox', FIELD)).toHaveValue(''));
		await user.keyboard('two{Enter}');

		await waitFor(() => expect(calls).toHaveLength(2));
		expect(calls).toEqual([
			{ title: 'one', parent: 't1' },
			{ title: 'two', parent: 't1' },
		]);
	});

	it('does not move the focus when the add failed (the text stays, the message is read)', async () => {
		const user = userEvent.setup();
		render(
			<Page
				rowsAfter={[ROW]}
				answer={() => Promise.resolve({ error: 'refused', status: 400 })}
				extra={<input aria-label="Elsewhere" />}
			/>
		);
		const before = screen.getByRole('textbox', FIELD);

		await user.type(before, 'keep me{Enter}');
		await waitFor(() => expect(screen.getAllByTestId('checklist-row')).toHaveLength(1));
		await user.click(screen.getByRole('textbox', { name: 'Elsewhere' }));

		expect(screen.getByRole('textbox', { name: 'Elsewhere' })).toHaveFocus();
		expect(screen.getByRole('textbox', FIELD)).toHaveValue('keep me');
	});

	it('does not take the focus from where the user went while the request ran', async () => {
		const user = userEvent.setup();
		const pending = deferred<unknown>();
		render(<Page rowsAfter={[ROW]} answer={() => pending.promise} extra={<input aria-label="Elsewhere" />} />);

		await user.type(screen.getByRole('textbox', FIELD), 'slow{Enter}');
		await user.click(screen.getByRole('textbox', { name: 'Elsewhere' }));
		await act(async () => {
			pending.resolve(undefined);
			await pending.promise;
		});

		await waitFor(() => expect(screen.getAllByTestId('checklist-row')).toHaveLength(1));
		expect(screen.getByRole('textbox', { name: 'Elsewhere' })).toHaveFocus();
		expect(screen.getByRole('textbox', FIELD)).toHaveValue('');
	});

	it('takes the focus back when it fell to the page (the body) while the request ran', async () => {
		const user = userEvent.setup();
		const pending = deferred<unknown>();
		render(<Page rowsAfter={[ROW]} answer={() => pending.promise} />);

		await user.type(screen.getByRole('textbox', FIELD), 'slow{Enter}');
		act(() => (document.activeElement as HTMLElement | null)?.blur());
		expect(document.body).toHaveFocus();
		await act(async () => {
			pending.resolve(undefined);
			await pending.promise;
		});

		await waitFor(() => expect(screen.getByRole('textbox', FIELD)).toHaveFocus());
	});

	it('in the form style, the focus returns to the field after the button was clicked', async () => {
		const user = userEvent.setup();
		const onAction = vi.fn().mockResolvedValue(undefined);
		render(
			<TaskChecklist
				rows={[]}
				addStyle="form"
				addAction="createSubtask"
				titleKey="title"
				parentId="t1"
				onAction={onAction}
			/>
		);

		await user.type(screen.getByRole('textbox', FIELD), 'by button');
		await user.click(screen.getByRole('button', { name: 'Create sub-task' }));

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.getByRole('textbox', FIELD)).toHaveFocus());
		expect(screen.getByRole('textbox', FIELD)).toHaveValue('');
	});
});

describe('TaskChecklist: a failed add says so in words', () => {
	it('names an answer the shell could not read as JSON, and what to do', async () => {
		const user = userEvent.setup();
		const onAction = vi
			.fn()
			.mockRejectedValue(new SyntaxError("Failed to execute 'json' on 'Response': Unexpected end of JSON input"));
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		render(
			<TaskChecklist rows={[ROW]} addAction="createSubtask" titleKey="title" parentId="t1" onAction={onAction} />
		);

		await user.type(screen.getByRole('textbox', FIELD), 'lost{Enter}');

		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent('The sub-task was not added');
		expect(alert).toHaveTextContent('did not answer with JSON');
		expect(alert).toHaveTextContent('app-core');
		expect(alert).toHaveTextContent('Your text is kept');
		expect(alert).not.toHaveTextContent('Unexpected end of JSON input');
		expect(screen.getByRole('textbox', FIELD)).toHaveValue('lost');
	});

	it('says the page shows the reason when the route refused the sub-task', async () => {
		const user = userEvent.setup();
		const onAction = vi.fn().mockResolvedValue({ error: 'Task not found: nope', status: 404 });
		render(
			<TaskChecklist rows={[ROW]} addAction="createSubtask" titleKey="title" parentId="t1" onAction={onAction} />
		);

		await user.type(screen.getByRole('textbox', FIELD), 'refused{Enter}');

		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent('The sub-task was not added');
		expect(alert).toHaveTextContent('Task not found: nope');
	});

	it('clears the message as soon as the text changes, and after a success', async () => {
		const user = userEvent.setup();
		const onAction = vi.fn().mockResolvedValueOnce({ error: 'refused', status: 400 }).mockResolvedValue(undefined);
		render(
			<TaskChecklist rows={[ROW]} addAction="createSubtask" titleKey="title" parentId="t1" onAction={onAction} />
		);
		const field = screen.getByRole('textbox', FIELD);

		await user.type(field, 'x{Enter}');
		await screen.findByRole('alert');
		await user.type(field, 'y');

		expect(screen.queryByRole('alert')).toBeNull();
	});
});

describe('TaskChecklist: the shell publishes the failure (it resolves, it does not reject)', () => {
	it('keeps the text and words the unreadable answer when the page reports { error } after the call', async () => {
		const user = userEvent.setup();
		const onAction = vi
			.fn()
			.mockResolvedValue({ error: "Failed to execute 'json' on 'Response': Unexpected end of JSON input" });
		render(
			<TaskChecklist rows={[ROW]} addAction="createSubtask" titleKey="title" parentId="t1" onAction={onAction} />
		);

		await user.type(screen.getByRole('textbox', FIELD), 'kept{Enter}');

		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent('did not answer with JSON');
		expect(screen.getByRole('textbox', FIELD)).toHaveValue('kept');
	});
});
