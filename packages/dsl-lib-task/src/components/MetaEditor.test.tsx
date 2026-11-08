import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../testHelpers.js';
import { pathKeyOf } from '../pathKey.js';
import { resetReported } from '../reportOnce.js';
import { MetaEditor } from './MetaEditor.js';

afterEach(() => {
	resetReported();
	vi.restoreAllMocks();
});

const ENTRIES = [
	{ key: 'owner', value: 'ann' },
	{ key: 'url', value: 'http://x/y' },
];

function setup(extra: Partial<React.ComponentProps<typeof MetaEditor>> = {}) {
	const onAction = vi.fn().mockResolvedValue(undefined);
	render(
		<MetaEditor
			entries={ENTRIES}
			setAction="setMeta"
			removeAction="removeMeta"
			params={{ id: 't1' }}
			onAction={onAction}
			{...extra}
		/>
	);
	return onAction;
}

function follows(first: Element, second: Element): boolean {
	return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('MetaEditor', () => {
	it('lists one chip "key: value" per entry', () => {
		setup();

		const chips = screen.getAllByTestId('meta-chip');
		expect(chips).toHaveLength(2);
		expect(chips[0]).toHaveTextContent('owner: ann');
		expect(screen.getByRole('button', { name: 'Edit value of owner' })).toHaveTextContent('owner: ann');
	});

	it('shows the empty text when there is nothing and no way to add', () => {
		render(<MetaEditor entries={[]} emptyText="No metadata" />);

		expect(screen.getByText('No metadata')).toBeInTheDocument();
	});

	it('is read-only without actions or with readOnly: no button, no input', () => {
		render(<MetaEditor entries={ENTRIES} readOnly setAction="s" removeAction="r" />);

		expect(screen.queryByRole('button')).toBeNull();
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(screen.getAllByTestId('meta-chip')).toHaveLength(2);
	});

	it('clicking a chip opens the popover on its value; Enter saves with the key and value in the body and closes', async () => {
		const user = userEvent.setup();
		const onAction = setup();

		await user.click(screen.getByRole('button', { name: 'Edit value of owner' }));
		const field = screen.getByRole('textbox', { name: 'Value of owner' });
		expect(screen.getByRole('dialog', { name: 'Edit owner' })).toContainElement(field);
		expect(field).toHaveFocus();
		expect(field).toHaveValue('ann');
		await user.clear(field);
		await user.type(field, 'bob{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
		expect(onAction).toHaveBeenCalledWith('setMeta', { id: 't1' }, { body: { key: 'owner', value: 'bob' } });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});

	it('uses keyParam and valueParam as the body names', async () => {
		const user = userEvent.setup();
		const onAction = setup({ keyParam: 'name', valueParam: 'text' });

		await user.click(screen.getByRole('button', { name: 'Edit value of owner' }));
		await user.type(screen.getByRole('textbox', { name: 'Value of owner' }), '!{Enter}');

		await waitFor(() =>
			expect(onAction).toHaveBeenCalledWith('setMeta', { id: 't1' }, { body: { name: 'owner', text: 'ann!' } })
		);
	});

	it('Escape closes without a call and keeps the old value', async () => {
		const user = userEvent.setup();
		const onAction = setup();

		await user.click(screen.getByRole('button', { name: 'Edit value of owner' }));
		await user.type(screen.getByRole('textbox', { name: 'Value of owner' }), 'zzz{Escape}');

		expect(onAction).not.toHaveBeenCalled();
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(screen.getByRole('button', { name: 'Edit value of owner' })).toHaveTextContent('owner: ann');
	});

	it('does not call when the value is unchanged', async () => {
		const user = userEvent.setup();
		const onAction = setup();

		await user.click(screen.getByRole('button', { name: 'Edit value of owner' }));
		await user.keyboard('{Enter}');

		expect(onAction).not.toHaveBeenCalled();
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('saves once when Enter is pressed twice', async () => {
		const user = userEvent.setup();
		const gate = deferred<undefined>();
		const onAction = vi.fn().mockReturnValue(gate.promise);
		setup({ onAction });
		await user.click(screen.getByRole('button', { name: 'Edit value of owner' }));
		await user.type(screen.getByRole('textbox', { name: 'Value of owner' }), 'x{Enter}{Enter}');
		gate.resolve(undefined);

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(onAction).toHaveBeenCalledTimes(1);
	});

	it('keeps the popover open with a message when the save fails', async () => {
		const user = userEvent.setup();
		const onAction = vi.fn().mockResolvedValue({ error: 'bad', status: 400 });
		setup({ onAction });

		await user.click(screen.getByRole('button', { name: 'Edit value of owner' }));
		await user.type(screen.getByRole('textbox', { name: 'Value of owner' }), 'x{Enter}');

		expect(await screen.findByRole('alert')).toHaveTextContent(/not saved/i);
		expect(screen.getByRole('textbox', { name: 'Value of owner' })).toHaveValue('annx');
	});

	it('removes a key with the key in the params and its base64url key', async () => {
		const user = userEvent.setup();
		const onAction = setup();

		await user.click(screen.getByRole('button', { name: 'Remove owner' }));

		expect(onAction).toHaveBeenCalledWith('removeMeta', { id: 't1', key: 'owner', keyKey: pathKeyOf('owner') });
	});

	it('names the key param after keyParam', async () => {
		const user = userEvent.setup();
		const onAction = setup({ keyParam: 'name' });

		await user.click(screen.getByRole('button', { name: 'Remove owner' }));

		expect(onAction).toHaveBeenCalledWith('removeMeta', { id: 't1', name: 'owner', nameKey: pathKeyOf('owner') });
	});

	it('collapses beyond collapseAfter and toggles with aria-expanded; all chips by default', async () => {
		const user = userEvent.setup();
		const many = ['a', 'b', 'c', 'd', 'e'].map(key => ({ key, value: key }));
		setup({ entries: many, collapseAfter: 3 });

		expect(screen.getAllByTestId('meta-chip')).toHaveLength(3);
		await user.click(screen.getByRole('button', { name: 'Show 2 more' }));
		expect(screen.getAllByTestId('meta-chip')).toHaveLength(5);
		expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
	});

	it('adds a property: "+ Add" opens the popover, Enter in the key goes to the value, Enter saves with a body and closes', async () => {
		const user = userEvent.setup();
		const onAction = setup();

		await user.click(screen.getByRole('button', { name: 'Add property' }));
		const key = screen.getByRole('combobox', { name: 'New property key' });
		expect(key).toHaveFocus();
		await user.type(key, 'env{Enter}');
		const value = screen.getByRole('textbox', { name: 'New property value' });
		expect(value).toHaveFocus();
		await user.type(value, 'prod{Enter}');

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
		expect(onAction).toHaveBeenCalledWith('setMeta', { id: 't1' }, { body: { key: 'env', value: 'prod' } });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});

	it('has an Add button in the popover that saves too', async () => {
		const user = userEvent.setup();
		const onAction = setup();

		await user.click(screen.getByRole('button', { name: 'Add property' }));
		await user.type(screen.getByRole('combobox', { name: 'New property key' }), 'env');
		await user.type(screen.getByRole('textbox', { name: 'New property value' }), 'prod');
		await user.click(screen.getByRole('button', { name: 'Save property' }));

		await waitFor(() =>
			expect(onAction).toHaveBeenCalledWith('setMeta', { id: 't1' }, { body: { key: 'env', value: 'prod' } })
		);
	});

	it('refuses an empty key and an existing key with a message and no call', async () => {
		const user = userEvent.setup();
		const onAction = setup();

		await user.click(screen.getByRole('button', { name: 'Add property' }));
		await user.click(screen.getByRole('button', { name: 'Save property' }));
		expect(screen.getByRole('alert')).toHaveTextContent('Enter a key first');
		await user.type(screen.getByRole('combobox', { name: 'New property key' }), 'OWNER');
		await user.click(screen.getByRole('button', { name: 'Save property' }));
		expect(screen.getByRole('alert')).toHaveTextContent('already exists');

		expect(onAction).not.toHaveBeenCalled();
	});

	it('Escape closes the add popover and puts the focus back on "+ Add"', async () => {
		const user = userEvent.setup();
		setup();

		await user.click(screen.getByRole('button', { name: 'Add property' }));
		await user.keyboard('{Escape}');

		expect(screen.queryByRole('dialog')).toBeNull();
		expect(screen.getByRole('button', { name: 'Add property' })).toHaveFocus();
	});

	it('offers the known keys BELOW the key input, minus the keys already used; picking one goes to the value', async () => {
		const user = userEvent.setup();
		setup({ keySuggestions: ['owner', 'env', 'team'] });

		await user.click(screen.getByRole('button', { name: 'Add property' }));
		const key = screen.getByRole('combobox', { name: 'New property key' });
		const list = screen.getByRole('listbox', { name: 'Property keys' });

		expect(follows(key, list)).toBe(true);
		expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['env', 'team']);
		await user.click(screen.getByRole('option', { name: 'team' }));
		expect(key).toHaveValue('team');
		expect(screen.getByRole('textbox', { name: 'New property value' })).toHaveFocus();
	});

	it('filters the key suggestions as you type, keeping the typed text visible', async () => {
		const user = userEvent.setup();
		setup({ keySuggestions: ['env', 'team'] });

		await user.click(screen.getByRole('button', { name: 'Add property' }));
		const key = screen.getByRole('combobox', { name: 'New property key' });
		await user.type(key, 'te');

		expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['team']);
		expect(key).toHaveValue('te');
	});

	it('waits while an action runs: the chips cannot be clicked', async () => {
		const gate = deferred<undefined>();
		const user = userEvent.setup();
		setup({ onAction: vi.fn().mockReturnValue(gate.promise) });

		await user.click(screen.getByRole('button', { name: 'Remove owner' }));

		expect(screen.getByRole('button', { name: 'Edit value of owner' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Add property' })).toBeDisabled();
		gate.resolve(undefined);
		await waitFor(() => expect(screen.getByRole('button', { name: 'Add property' })).toBeEnabled());
	});
});
