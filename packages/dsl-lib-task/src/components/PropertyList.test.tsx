import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PropertyList } from './PropertyList.js';
import { PropertyRow } from './PropertyRow.js';

describe('PropertyList', () => {
	it('lists each row with its label and its value', () => {
		render(
			<PropertyList
				items={[
					<PropertyRow key="a" label="Status" items={<span>done</span>} />,
					<PropertyRow key="b" label="Type" items={<span>bug</span>} />,
				]}
			/>
		);

		expect(screen.getByText('Status')).toBeInTheDocument();
		expect(screen.getByText('done')).toBeInTheDocument();
		expect(screen.getByText('Type')).toBeInTheDocument();
		expect(screen.getAllByTestId('property-row')).toHaveLength(2);
	});

	it('is comfortable and stacked by default, compact and inline on request', () => {
		const { rerender } = render(<PropertyList items={<PropertyRow label="A" items="x" />} />);
		expect(screen.getByTestId('property-list')).toHaveAttribute('data-density', 'comfortable');
		expect(screen.getByTestId('property-row')).toHaveClass('flex-col');

		rerender(
			<PropertyList density="compact" labelPlacement="inline" items={<PropertyRow label="A" items="x" />} />
		);
		expect(screen.getByTestId('property-list')).toHaveAttribute('data-density', 'compact');
		expect(screen.getByTestId('property-row')).toHaveClass('flex-row');
	});

	it('sizes the inline label column from labelWidth', () => {
		render(<PropertyList labelPlacement="inline" labelWidth="wide" items={<PropertyRow label="A" items="x" />} />);

		expect(screen.getByText('A')).toHaveClass('w-40');
	});

	it('draws dividers between rows only when asked', () => {
		const { rerender } = render(<PropertyList items={<PropertyRow label="A" items="x" />} />);
		expect(screen.getByTestId('property-list')).not.toHaveClass('divide-y');

		rerender(<PropertyList dividers items={<PropertyRow label="A" items="x" />} />);
		expect(screen.getByTestId('property-list')).toHaveClass('divide-y');
	});

	it('hides the hover tips of its values below 640 px only when asked (a tip sticks out of a narrow page)', () => {
		const { rerender } = render(<PropertyList items={<PropertyRow label="A" items="x" />} />);
		expect(screen.getByTestId('property-list').className).not.toContain('role=tooltip');

		rerender(<PropertyList hideTipsOnNarrow items={<PropertyRow label="A" items="x" />} />);
		expect(screen.getByTestId('property-list')).toHaveClass('max-sm:[&_[role=tooltip]]:hidden');
	});

	// An inline label sits next to a 32 px control: its text must line up with the control's text, not with its top edge.
	it('inline: align="control" centres the label on a control-high first line, text (default) keeps it at the top', () => {
		const { rerender } = render(
			<PropertyList labelPlacement="inline" items={<PropertyRow label="A" items="x" />} />
		);
		expect(screen.getByText('A')).toHaveClass('pt-0.5');

		rerender(<PropertyList labelPlacement="inline" items={<PropertyRow label="A" align="control" items="x" />} />);
		expect(screen.getByText('A')).toHaveClass('pt-2');
		expect(screen.getByText('A')).not.toHaveClass('pt-0.5');
	});

	it('shows the hint of a row as a tooltip on its label', () => {
		render(<PropertyList items={<PropertyRow label="Parent" hint="The task above this one" items="x" />} />);

		expect(screen.getByText('Parent')).toHaveAttribute('title', 'The task above this one');
	});
});
