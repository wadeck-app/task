import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LabelCombobox } from '../components/LabelCombobox.js';
import { MetaEditor } from '../components/MetaEditor.js';
import { PropertyPopover } from '../components/PropertyPopover.js';

describe('ChipField popover placement', () => {
	it('on the page the popover floats under the row (absolute), below the chips', async () => {
		render(<LabelCombobox labels={['a']} addAction="x" suggestions={[]} onAction={vi.fn()} />);

		await userEvent.setup().click(screen.getByRole('button', { name: 'Add label' }));

		const panel = screen.getByRole('dialog', { name: 'Add label' });
		expect(panel.className).toMatch(/\babsolute\b/);
		const chip = screen.getByTestId('label-chip');
		expect(chip.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('inside another popover it stays in the flow, so the outer panel grows instead of clipping it', async () => {
		const user = userEvent.setup();
		render(
			<PropertyPopover
				label="Metadata"
				valueText="2"
				items={
					<MetaEditor
						entries={[{ key: 'owner', value: 'ann' }]}
						setAction="s"
						keySuggestions={['env']}
						onAction={vi.fn()}
					/>
				}
			/>
		);

		await user.click(screen.getByRole('button', { name: 'Metadata: 2' }));
		await user.click(screen.getByRole('button', { name: 'Add property' }));

		const inner = screen.getByRole('dialog', { name: 'Add property' });
		expect(screen.getByTestId('property-popover-panel')).toContainElement(inner);
		expect(inner.className).not.toMatch(/\babsolute\b/);
		expect(inner.className).not.toMatch(/\bfixed\b/);
		expect(inner.className).not.toMatch(/max-sm:fixed/);
		expect(screen.getByRole('combobox', { name: 'New property key' })).toHaveFocus();
	});

	it('Escape inside a nested popover closes the inner one only', async () => {
		const user = userEvent.setup();
		render(
			<PropertyPopover
				label="Metadata"
				valueText="2"
				items={<MetaEditor entries={[]} setAction="s" onAction={vi.fn()} />}
			/>
		);

		await user.click(screen.getByRole('button', { name: 'Metadata: 2' }));
		await user.click(screen.getByRole('button', { name: 'Add property' }));
		await user.keyboard('{Escape}');

		expect(screen.queryByRole('dialog', { name: 'Add property' })).toBeNull();
		expect(screen.getByTestId('property-popover-panel')).toBeInTheDocument();
	});
});
