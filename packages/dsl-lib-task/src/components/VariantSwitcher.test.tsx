import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AbExperiments } from '@wadeck-app/dsl-ui';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetReported } from '../reportOnce.js';
import { VariantSwitcher } from './VariantSwitcher.js';
import type { VariantSwitcherProps } from './VariantSwitcher.js';

// A view is `{ text }` (a leaf) or `{ nested: <props of a VariantSwitcher> }`, which is what a DSL renderer would turn into a node.
type View = { text: string } | { nested: Omit<VariantSwitcherProps, 'renderNode'> };

const renderNode = (node: unknown): React.ReactNode => {
	const view = node as View;
	if ('nested' in view) {
		return <VariantSwitcher {...view.nested} renderNode={renderNode} />;
	}
	return <p data-testid="view">{view.text}</p>;
};

function switcher(extra: Partial<VariantSwitcherProps> = {}) {
	return (
		<VariantSwitcher
			id="t"
			label="Task page"
			initial="current"
			variants={{
				current: { label: 'Current', hint: 'The page as shipped.', view: { text: 'view-current' } },
				a: { label: 'Variant A', hint: 'Changes A.', view: { text: 'view-a' } },
				b: { label: 'Variant B', hint: 'Changes B.', view: { text: 'view-b' } },
			}}
			renderNode={renderNode}
			{...extra}
		/>
	);
}

const on = (ui: React.ReactElement) => <AbExperiments enabled>{ui}</AbExperiments>;
const off = (ui: React.ReactElement) => <AbExperiments enabled={false}>{ui}</AbExperiments>;

beforeEach(() => {
	localStorage.clear();
	window.history.replaceState({}, '', '/');
});

afterEach(() => {
	resetReported();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe('VariantSwitcher, experiments off', () => {
	it('renders the initial view only, with no bar', () => {
		render(off(switcher()));

		expect(screen.getByTestId('view')).toHaveTextContent('view-current');
		expect(screen.queryByTestId('variant-switcher')).toBeNull();
	});

	it('never reads the storage nor the URL', () => {
		localStorage.setItem('ab.t', 'b');
		window.history.replaceState({}, '', '/?ab.t=a');
		const get = vi.spyOn(Storage.prototype, 'getItem');

		render(off(switcher()));

		expect(screen.getByTestId('view')).toHaveTextContent('view-current');
		expect(get).not.toHaveBeenCalled();
	});

	it('is off outside development when no host says otherwise (production build)', () => {
		vi.stubEnv('NODE_ENV', 'production');
		localStorage.setItem('ab.t', 'b');

		render(switcher());

		expect(screen.getByTestId('view')).toHaveTextContent('view-current');
		expect(screen.queryByTestId('variant-switcher')).toBeNull();
	});

	it('is on in development when no host says otherwise', () => {
		vi.stubEnv('NODE_ENV', 'development');

		render(switcher());

		expect(screen.getByTestId('variant-switcher')).toBeInTheDocument();
	});
});

describe('VariantSwitcher, experiments on', () => {
	it('renders the initial view and a large bar fixed at the bottom centre, outside the page flow', () => {
		const { container } = render(on(switcher()));

		expect(screen.getByTestId('view')).toHaveTextContent('view-current');
		const bar = screen.getByTestId('variant-switcher');
		expect(container.contains(bar)).toBe(false);
		expect(bar).toHaveClass('fixed', 'bottom-6', 'left-1/2');
		expect(within(bar).getByRole('radio', { name: 'Variant A' }).closest('label')).toHaveClass('text-sm');
	});

	it('lists the variants as one radio group named after the test, the current one checked', () => {
		render(on(switcher()));

		const group = screen.getByRole('radiogroup', { name: 'Task page' });
		expect(within(group).getAllByRole('radio')).toHaveLength(3);
		expect(within(group).getByRole('radio', { name: 'Current' })).toBeChecked();
	});

	it('shows the chosen variant and keeps the choice in localStorage ab.<id>', async () => {
		render(on(switcher()));

		await userEvent.setup().click(screen.getByRole('radio', { name: 'Variant A' }));

		expect(screen.getByTestId('view')).toHaveTextContent('view-a');
		expect(localStorage.getItem('ab.t')).toBe('a');
	});

	it('starts on the stored choice', () => {
		localStorage.setItem('ab.t', 'b');

		render(on(switcher()));

		expect(screen.getByTestId('view')).toHaveTextContent('view-b');
	});

	it('lets ?ab.<id>= force a variant for this load without storing it', () => {
		localStorage.setItem('ab.t', 'b');
		window.history.replaceState({}, '', '/?ab.t=a');

		render(on(switcher()));

		expect(screen.getByTestId('view')).toHaveTextContent('view-a');
		expect(localStorage.getItem('ab.t')).toBe('b');
	});

	it('reports an unknown stored value once and falls back to initial', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		localStorage.setItem('ab.t', 'gone');

		render(on(switcher()));

		expect(screen.getByTestId('view')).toHaveTextContent('view-current');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('gone'));
	});

	it('follows a change made in another tab', () => {
		render(on(switcher()));

		act(() => {
			window.dispatchEvent(
				new StorageEvent('storage', { key: 'ab.t', newValue: 'b', storageArea: localStorage })
			);
		});

		expect(screen.getByTestId('view')).toHaveTextContent('view-b');
	});

	it('shows the hint of the choice under the pointer or the focus', async () => {
		render(on(switcher()));
		const user = userEvent.setup();

		await user.hover(screen.getByRole('radio', { name: 'Variant B' }));

		expect(screen.getByTestId('variant-hint')).toHaveTextContent('Changes B.');
		expect(screen.getByRole('radio', { name: 'Variant B' }).closest('label')).toHaveAttribute(
			'title',
			'Changes B.'
		);
	});

	it('calls renderNode with the view and an empty context, like AbTest', () => {
		const spy = vi.fn(renderNode);

		render(on(switcher({ renderNode: spy })));

		expect(spy).toHaveBeenCalledWith({ text: 'view-current' }, {});
	});
});

describe('VariantSwitcher, options of a variant', () => {
	function withOptions() {
		return switcher({
			variants: {
				current: { label: 'Current', hint: 'h', view: { text: 'view-current' } },
				a: {
					label: 'Variant A',
					hint: 'h',
					view: {
						nested: {
							id: 't-a-side',
							label: 'Sidebar',
							initial: 'right',
							variants: {
								right: { label: 'Right', hint: 'On the right.', view: { text: 'side-right' } },
								left: { label: 'Left', hint: 'On the left.', view: { text: 'side-left' } },
							},
						},
					},
				},
			},
		});
	}

	it('adds a row in the same bar while the variant is shown, and removes it when another is chosen', async () => {
		render(on(withOptions()));
		const user = userEvent.setup();
		expect(screen.queryByRole('radiogroup', { name: 'Sidebar' })).toBeNull();

		await user.click(screen.getByRole('radio', { name: 'Variant A' }));
		expect(screen.getByRole('radiogroup', { name: 'Sidebar' })).toBeInTheDocument();
		expect(screen.getAllByRole('radiogroup')).toHaveLength(2);
		expect(screen.getByTestId('view')).toHaveTextContent('side-right');

		await user.click(screen.getByRole('radio', { name: 'Left' }));
		expect(screen.getByTestId('view')).toHaveTextContent('side-left');
		expect(localStorage.getItem('ab.t-a-side')).toBe('left');

		await user.click(screen.getByRole('radio', { name: 'Current' }));
		expect(screen.queryByRole('radiogroup', { name: 'Sidebar' })).toBeNull();
	});

	it('draws the options row above the variants row', async () => {
		render(on(withOptions()));
		await userEvent.setup().click(screen.getByRole('radio', { name: 'Variant A' }));

		const names = screen.getAllByRole('radiogroup').map(g => g.getAttribute('aria-label'));
		expect(names).toEqual(['Sidebar', 'Task page']);
	});

	it('shows only the initial option when experiments are off', () => {
		localStorage.setItem('ab.t', 'a');
		render(off(withOptions()));

		expect(screen.getByTestId('view')).toHaveTextContent('view-current');
	});
});

describe('VariantSwitcher, room for the bar', () => {
	it('adds an in-page spacer so the end of the page is not hidden behind the fixed bar', () => {
		const { container } = render(on(switcher()));

		const spacer = container.querySelector('[data-testid="variant-switcher-spacer"]') as HTMLElement | null;
		expect(spacer, 'no spacer in the page flow').not.toBeNull();
		expect(spacer!.getAttribute('aria-hidden')).toBe('true');
		expect(parseInt(spacer!.style.height, 10)).toBeGreaterThanOrEqual(56);
	});

	it('adds no spacer when experiments are off', () => {
		const { container } = render(off(switcher()));

		expect(container.querySelector('[data-testid="variant-switcher-spacer"]')).toBeNull();
	});
});

describe('VariantSwitcher, folding', () => {
	it('folds into a pill counting the tests, remembers it, and unfolds', async () => {
		render(on(switcher()));
		const user = userEvent.setup();

		await user.click(screen.getByRole('button', { name: /fold/i }));

		expect(screen.queryByRole('radiogroup')).toBeNull();
		const pill = screen.getByRole('button', { name: /A\/B \(1\)/ });
		expect(localStorage.getItem('ab.collapsed')).toBe('collapsed');
		expect(screen.getByTestId('view')).toHaveTextContent('view-current');

		await user.click(pill);
		expect(screen.getByRole('radiogroup')).toBeInTheDocument();
		expect(localStorage.getItem('ab.collapsed')).toBe('open');
	});

	it('folds on Escape from inside the bar', async () => {
		render(on(switcher()));
		const user = userEvent.setup();

		screen.getByRole('radio', { name: 'Current' }).focus();
		await user.keyboard('{Escape}');

		expect(screen.getByRole('button', { name: /A\/B \(1\)/ })).toBeInTheDocument();
	});

	it('keeps the chosen variant applied while folded', async () => {
		render(on(switcher()));
		const user = userEvent.setup();
		await user.click(screen.getByRole('radio', { name: 'Variant B' }));

		await user.click(screen.getByRole('button', { name: /fold/i }));

		expect(screen.getByTestId('view')).toHaveTextContent('view-b');
	});
});

describe('VariantSwitcher, bad declarations', () => {
	it('shows an alert, not a guessed variant, when initial is not a variant', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});

		render(on(switcher({ initial: 'nope' })));

		expect(screen.getByRole('alert')).toHaveTextContent('nope');
		expect(screen.queryByTestId('view')).toBeNull();
		expect(error).toHaveBeenCalled();
	});

	it('shows an alert for an id with a character the storage key and the URL cannot carry', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});

		render(on(switcher({ id: 'bad id' })));

		expect(screen.getByRole('alert')).toHaveTextContent('id');
	});

	it('shows an alert for a variant without label, hint or view', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});

		render(on(switcher({ variants: { current: { label: 'C' } as never } })));

		expect(screen.getByRole('alert')).toHaveTextContent('current');
	});

	it('refuses a second, different test with the same id', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});

		render(
			on(
				<>
					{switcher()}
					{switcher({
						label: 'Another test',
						variants: { current: { label: 'X', hint: 'x', view: { text: 'x' } } },
					})}
				</>
			)
		);

		expect(screen.getByRole('alert')).toHaveTextContent('same id');
	});
});
