import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TabPanels } from './TabPanels.js';

const tabs = [
	{ key: 'children', label: 'Child items', count: 3, items: <p>the children</p> },
	{ key: 'links', label: 'Linked items', count: 0, items: <p>the links</p> },
	{ key: 'activity', label: 'Activity', items: <p>the activity</p> },
];

describe('TabPanels', () => {
	it('shows the first tab by default and only its content', () => {
		render(<TabPanels tabs={tabs} />);

		expect(screen.getByRole('tab', { name: /Child items/ })).toHaveAttribute('aria-selected', 'true');
		expect(screen.getByText('the children')).toBeInTheDocument();
		expect(screen.queryByText('the links')).toBeNull();
	});

	it('shows the counts in the tab labels, zero included', () => {
		render(<TabPanels tabs={tabs} />);

		expect(screen.getByRole('tab', { name: /Child items/ })).toHaveTextContent('3');
		expect(screen.getByRole('tab', { name: /Linked items/ })).toHaveTextContent('0');
		expect(screen.getByRole('tab', { name: /Activity/ })).not.toHaveTextContent(/\d/);
	});

	it('switches the content when another tab is clicked', async () => {
		render(<TabPanels tabs={tabs} />);

		await userEvent.setup().click(screen.getByRole('tab', { name: /Linked items/ }));

		expect(screen.getByText('the links')).toBeInTheDocument();
		expect(screen.queryByText('the children')).toBeNull();
	});

	it('opens the tab named by defaultTab and falls back to the first one when the key is unknown', () => {
		const { rerender } = render(<TabPanels tabs={tabs} defaultTab="activity" />);
		expect(screen.getByText('the activity')).toBeInTheDocument();

		rerender(<TabPanels key="other" tabs={tabs} defaultTab="nope" />);
		expect(screen.getByText('the children')).toBeInTheDocument();
	});

	it('moves between tabs with the arrow keys', async () => {
		const user = userEvent.setup();
		render(<TabPanels tabs={tabs} />);

		screen.getByRole('tab', { name: /Child items/ }).focus();
		await user.keyboard('{ArrowRight}');

		expect(screen.getByRole('tab', { name: /Linked items/ })).toHaveAttribute('aria-selected', 'true');
	});

	it('keeps the chosen tab when the tabs are re-rendered with new content', async () => {
		const user = userEvent.setup();
		const { rerender } = render(<TabPanels tabs={tabs} />);
		await user.click(screen.getByRole('tab', { name: /Activity/ }));

		rerender(<TabPanels tabs={tabs.map(tab => ({ ...tab, items: <p>{`new ${tab.key}`}</p> }))} />);

		expect(screen.getByText('new activity')).toBeInTheDocument();
	});

	it('says so instead of rendering nothing when there is no tab', () => {
		render(<TabPanels tabs={[]} />);

		expect(screen.getByText('No tab to show.')).toBeInTheDocument();
	});
});

describe('TabPanels counts prop', () => {
	it('takes the counts by tab key, so a page can bind them to its data (the tabs themselves are not resolved by the renderer)', () => {
		render(
			<TabPanels
				tabs={[
					{ key: 'a', label: 'Alpha', items: <p>a</p> },
					{ key: 'b', label: 'Beta', items: <p>b</p> },
				]}
				counts={{ a: 4, b: 0 }}
			/>
		);

		expect(screen.getByRole('tab', { name: /Alpha/ })).toHaveTextContent('4');
		expect(screen.getByRole('tab', { name: /Beta/ })).toHaveTextContent('0');
	});
});
