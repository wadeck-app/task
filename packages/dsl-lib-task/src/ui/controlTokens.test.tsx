import { render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LabelCombobox } from '../components/LabelCombobox.js';
import { MetaEditor } from '../components/MetaEditor.js';
import { PropertyPopover } from '../components/PropertyPopover.js';
import { Notice } from '../components/Notice.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { CONTROL_H, CONTROL_RADIUS, CONTROL_TEXT, PILL_RADIUS, PILL_TEXT } from './tokens.js';

const SRC = path.resolve(import.meta.dirname, '..');

/** Components whose controls can sit in one row: they all draw their controls from ui/tokens. */
const TOKENIZED = [
	'components/ActivityFeed.tsx',
	'components/InlineText.tsx',
	'components/LabelCombobox.tsx',
	'components/MetaEditor.tsx',
	'components/PropertyPopover.tsx',
	'components/StatusSelect.tsx',
	'components/TaskChecklist.tsx',
	'components/Caption.tsx',
	'components/ControlButton.tsx',
	'components/TaskPicker.tsx',
	'ui/ChipField.tsx',
	'ui/SuggestBox.tsx',
];

function source(file: string): string {
	return fs.readFileSync(path.join(SRC, file), 'utf8');
}

/** Every class-like token of a source text. */
function classTokens(text: string): string[] {
	return text.match(/[a-z][a-z0-9:[\]()/.,%-]*/g) ?? [];
}

describe('control tokens', () => {
	it('define one control height, h-8', () => {
		expect(CONTROL_H).toBe('h-8');
	});

	// Directly, or through a block that does (ChipField, SuggestBox, PropertyPopover).
	it.each(TOKENIZED)('%s draws its controls from ui/tokens', file => {
		expect(source(file)).toMatch(/from '(\.\.\/ui|\.)\/(tokens|ChipField|SuggestBox|PropertyPopover)\.js'/);
	});

	it.each(TOKENIZED)('%s hard-codes no control height other than the token', file => {
		const bad = classTokens(source(file)).filter(token =>
			/^(max-sm:|sm:|md:|lg:)?(min-)?h-(6|7|9|10|11|12)$/.test(token)
		);
		expect(bad).toEqual([]);
	});

	it.each(TOKENIZED)('%s keeps the rhythm: gap-2 between controls and gap-4 between blocks, nothing else', file => {
		const bad = classTokens(source(file)).filter(token => /^gap-(?!2$|4$|0$)\S+$/.test(token));
		expect(bad).toEqual([]);
	});
});

describe('labels and metadata share one pattern', () => {
	function setup() {
		render(
			<>
				<LabelCombobox labels={['billing']} addAction="a" removeAction="r" onAction={vi.fn()} />
				<MetaEditor
					entries={[{ key: 'owner', value: 'ann' }]}
					setAction="s"
					removeAction="r"
					onAction={vi.fn()}
				/>
			</>
		);
	}

	it('a label chip and a metadata chip have the same height, radius, text and gaps (only the colour differs)', () => {
		setup();
		const strip = (el: HTMLElement): string[] =>
			el.className
				.split(/\s+/)
				.filter(c => !/^(bg|text)-/.test(c) || /^text-(sm|xs|base)$/.test(c))
				.sort();

		expect(strip(screen.getByTestId('label-chip'))).toEqual(strip(screen.getByTestId('meta-chip')));
		expect(screen.getByTestId('label-chip').className).toContain(CONTROL_H);
	});

	it('the "+ Add" chips are the same control', () => {
		setup();

		expect(screen.getByRole('button', { name: 'Add label' }).className).toBe(
			screen.getByRole('button', { name: 'Add property' }).className
		);
		expect(screen.getByRole('button', { name: 'Add label' }).textContent).toBe(
			screen.getByRole('button', { name: 'Add property' }).textContent
		);
	});

	it('the rows wrap with the same gap', () => {
		setup();

		const row = (testId: string): string => screen.getByTestId(testId).firstElementChild!.className;
		expect(row('label-combobox')).toBe(row('meta-editor'));
		expect(row('label-combobox')).toContain('flex-wrap');
	});

	it('a status pill, a label chip and an Add chip line up: one height', () => {
		render(
			<>
				<PropertyPopover label="Status" valueText="todo" tone="info" />
				<LabelCombobox labels={['x']} addAction="a" onAction={vi.fn()} />
			</>
		);

		expect(screen.getByRole('button', { name: 'Status: todo' }).className).toContain(CONTROL_H);
		expect(screen.getByTestId('label-chip').className).toContain(CONTROL_H);
		expect(screen.getByRole('button', { name: 'Add label' }).className).toContain(CONTROL_H);
	});
});

describe('badges and notices in a header row follow the control tokens', () => {
	it('a StatusBadge of size control has the control height, the pill radius and the pill text of a pill', () => {
		render(<StatusBadge label="Open" size="control" />);

		const badge = screen.getByTestId('status-badge');
		expect(badge).toHaveClass(CONTROL_H);
		expect(badge).toHaveClass(PILL_RADIUS);
		expect(badge.className).toContain(PILL_TEXT);
		// The height comes from the token alone: a vertical padding would add to it.
		expect(badge.className).not.toMatch(/(^|\s)py-/);
	});

	it('the id badge (mono, neutral) and the state badge are the same control as a PropertyPopover pill', () => {
		render(
			<>
				<StatusBadge label="Open" tone="success" icon="open" size="control" />
				<StatusBadge label="a1b2c3d4" size="control" mono />
				<PropertyPopover label="Menu" appearance="pill" valueText="Actions" items={[]} />
			</>
		);

		const heights = [...screen.getAllByTestId('status-badge'), screen.getByRole('button', { name: /Actions/ })].map(
			element => element.className.split(/\s+/).filter(token => /^h-\d+$/.test(token))
		);
		expect(heights).toEqual([[CONTROL_H], [CONTROL_H], [CONTROL_H]]);
		expect(screen.getByText('a1b2c3d4').className).toContain('font-mono');
	});

	it('a Notice uses the control radius and the control text size, with the horizontal padding of a control', () => {
		render(<Notice label="Blocked by 1 open task" variant="warning" />);

		const notice = screen.getByRole('status');
		expect(notice).toHaveClass(CONTROL_RADIUS);
		expect(notice).toHaveClass(CONTROL_TEXT);
		expect(notice).toHaveClass('px-3');
	});
});
