import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('MetaEditor', () => {
	it('lists the keys and values', () => {
		setup();

		expect(screen.getByText('owner')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Edit value of owner' })).toHaveTextContent('ann');
	});

	it('shows the empty text when there is nothing and no way to add', () => {
		render(<MetaEditor entries={[]} emptyText="No metadata" />);

		expect(screen.getByText('No metadata')).toBeInTheDocument();
	});

	it('is read-only without actions or with readOnly: no button, no input', () => {
		render(<MetaEditor entries={ENTRIES} readOnly setAction="s" removeAction="r" />);

		expect(screen.queryByRole('button')).toBeNull();
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it('edits a value in place: Enter saves with the key and value in the body', async () => {
		const onAction = setup();
		const user = userEvent.setup();

		await user.click(screen.getByRole('button', { name: 'Edit value of owner' }));
		const input = screen.getByRole('textbox', { name: 'Value of owner' });
		expect(input).toHaveFocus();
		await user.clear(input);
		await user.type(input, 'bob{Enter}');

		await waitFor(() =>
			expect(onAction).toHaveBeenCalledWith('setMeta', { id: 't1' }, { body: { key: 'owner', value: 'bob' } })
		);
		await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Value of owner' })).toBeNull());
	});

	it('uses keyParam and valueParam as the body names', async () => {
		const onAction = setup({ keyParam: 'k', valueParam: 'v' });
		const user = userEvent.setup();

		await user.click(screen.getByRole('button', { name: 'Edit value of owner' }));
		await user.type(screen.getByRole('textbox', { name: 'Value of owner' }), 'x{Enter}');

		await waitFor(() =>
			expect(onAction).toHaveBeenCalledWith('setMeta', { id: 't1' }, { body: { k: 'owner', v: 'annx' } })
		);
	});

	it('Escape cancels without a call and keeps the old value', async () => {
		const onAction = setup();
		const user = userEvent.setup();

		await user.click(screen.getByRole('button', { name: 'Edit value of owner' }));
		await user.type(screen.getByRole('textbox', { name: 'Value of owner' }), 'zzz{Escape}');

		expect(onAction).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Edit value of owner' })).toHaveTextContent('ann');
	});

	it('does not call when the value is unchanged', async () => {
		const onAction = setup();
		const user = userEvent.setup();

		await user.click(screen.getByRole('button', { name: 'Edit value of owner' }));
		await user.keyboard('{Enter}');

		expect(onAction).not.toHaveBeenCalled();
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it('saves once when Enter is followed by the blur the busy field causes', async () => {
		const pending = deferred<undefined>();
		const onAction = vi.fn().mockReturnValue(pending.promise);
		render(<MetaEditor entries={ENTRIES} setAction="setMeta" onAction={onAction} />);
		const user = userEvent.setup();

		await user.click(screen.getByRole('button', { name: 'Edit value of owner' }));
		const input = screen.getByRole('textbox', { name: 'Value of owner' });
		await user.type(input, 'q{Enter}');
		fireEvent.blur(input);
		fireEvent.keyDown(input, { key: 'Enter' });

		expect(onAction).toHaveBeenCalledTimes(1);
		pending.resolve(undefined);
		await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
	});

	it('saves on blur when the value changed', async () => {
		const onAction = setup();
		const user = userEvent.setup();

		await user.click(screen.getByRole('button', { name: 'Edit value of owner' }));
		await user.type(screen.getByRole('textbox', { name: 'Value of owner' }), 'k');
		await user.tab();

		await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
	});

	it('does not save on blur after Escape', async () => {
		const onAction = setup();
		const user = userEvent.setup();

		await user.click(screen.getByRole('button', { name: 'Edit value of owner' }));
		const input = screen.getByRole('textbox', { name: 'Value of owner' });
		await user.type(input, 'k{Escape}');
		fireEvent.blur(input);

		expect(onAction).not.toHaveBeenCalled();
	});

	it('keeps the editor open with a message when the save fails', async () => {
		const onAction = vi.fn().mockResolvedValue({ error: 'nope', status: 400 });
		render(<MetaEditor entries={ENTRIES} setAction="setMeta" onAction={onAction} />);
		const user = userEvent.setup();

		await user.click(screen.getByRole('button', { name: 'Edit value of owner' }));
		await user.type(screen.getByRole('textbox', { name: 'Value of owner' }), 'k{Enter}');

		expect(await screen.findByRole('alert')).toHaveTextContent(/not saved/i);
		expect(screen.getByRole('textbox', { name: 'Value of owner' })).toHaveValue('annk');
	});

	it('removes a key with the key in the params and its base64url key', async () => {
		const onAction = setup({ entries: [{ key: 'a/b', value: '1' }] });

		await userEvent.setup().click(screen.getByRole('button', { name: 'Remove a/b' }));

		expect(onAction).toHaveBeenCalledWith('removeMeta', { id: 't1', key: 'a/b', keyKey: pathKeyOf('a/b') });
	});

	it('names the key key param after keyParam', async () => {
		const onAction = setup({ keyParam: 'name' });

		await userEvent.setup().click(screen.getByRole('button', { name: 'Remove owner' }));

		expect(onAction).toHaveBeenCalledWith('removeMeta', { id: 't1', name: 'owner', nameKey: pathKeyOf('owner') });
	});

	it('collapses beyond collapseAfter and toggles with aria-expanded', async () => {
		const many = ['a', 'b', 'c', 'd', 'e'].map(key => ({ key, value: `v-${key}` }));
		render(<MetaEditor entries={many} />);
		const user = userEvent.setup();

		expect(screen.queryByText('d')).toBeNull();
		const toggle = screen.getByRole('button', { name: /2 more/ });
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		await user.click(toggle);

		expect(screen.getByText('e')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /fewer|less/i })).toHaveAttribute('aria-expanded', 'true');
	});

	it('adds a property: key then value, Enter saves with a body, fields cleared', async () => {
		const onAction = setup();
		const user = userEvent.setup();

		await user.click(screen.getByRole('button', { name: 'Add property' }));
		const key = screen.getByRole('combobox', { name: 'New property key' });
		expect(key).toHaveFocus();
		await user.type(key, 'team{Enter}');
		expect(screen.getByRole('textbox', { name: 'New property value' })).toHaveFocus();
		await user.type(screen.getByRole('textbox', { name: 'New property value' }), 'core{Enter}');

		await waitFor(() =>
			expect(onAction).toHaveBeenCalledWith('setMeta', { id: 't1' }, { body: { key: 'team', value: 'core' } })
		);
		await waitFor(() => expect(screen.queryByRole('combobox', { name: 'New property key' })).toBeNull());
	});

	it('refuses an empty key and an existing key with a message and no call', async () => {
		const onAction = setup();
		const user = userEvent.setup();

		await user.click(screen.getByRole('button', { name: 'Add property' }));
		await user.type(screen.getByRole('textbox', { name: 'New property value' }), 'v{Enter}');
		expect(screen.getByRole('alert')).toHaveTextContent(/key/i);

		await user.type(screen.getByRole('combobox', { name: 'New property key' }), 'OWNER{Enter}');
		expect(screen.getByRole('alert')).toHaveTextContent(/already/i);
		expect(onAction).not.toHaveBeenCalled();
	});

	it('Escape closes the add row', async () => {
		setup();
		const user = userEvent.setup();

		await user.click(screen.getByRole('button', { name: 'Add property' }));
		await user.keyboard('{Escape}');

		expect(screen.queryByRole('combobox', { name: 'New property key' })).toBeNull();
	});

	it('offers the known keys as suggestions', async () => {
		setup({ keySuggestions: ['team', 'owner'] });
		await userEvent.setup().click(screen.getByRole('button', { name: 'Add property' }));

		const list = screen.getByRole('combobox', { name: 'New property key' }).getAttribute('list');
		expect(list).toBeTruthy();
		const options = document.getElementById(list!)!.querySelectorAll('option');
		expect([...options].map(o => o.getAttribute('value'))).toEqual(['team']);
	});

	it('disables the controls while an action runs', async () => {
		const pending = deferred<undefined>();
		const onAction = vi.fn().mockReturnValue(pending.promise);
		render(<MetaEditor entries={ENTRIES} removeAction="r" onAction={onAction} />);
		const user = userEvent.setup();

		await user.click(screen.getByRole('button', { name: 'Remove owner' }));

		expect(screen.getByRole('button', { name: 'Remove url' })).toBeDisabled();
		pending.resolve(undefined);
		await waitFor(() => expect(screen.getByRole('button', { name: 'Remove url' })).toBeEnabled());
	});
});
