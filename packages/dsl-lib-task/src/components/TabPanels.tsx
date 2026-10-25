import React, { useId, useRef, useState } from 'react';

export interface TabSpec {
	/** Stable id of the tab (letters, digits, `-`). */
	key: string;
	label: string;
	/** A number shown next to the label (0 is shown). */
	count?: number;
	/** The content of this tab, as DSL nodes. */
	items: React.ReactNode;
}

export interface TabPanelsProps {
	/** The tabs, in order. Only the chosen one is rendered. */
	tabs: TabSpec[];
	/** The key of the tab open at first. Unknown or unset: the first tab. */
	defaultTab?: string;
	/**
	 * Counts by tab key, shown next to the labels. A page binds them to its data here: the renderer does not resolve
	 * expressions inside `tabs` entries (only their `items` nodes), so a `count` of a tab cannot be bound.
	 * @resolveDeep
	 */
	counts?: Record<string, number>;
}

/**
 * Tabs with their content: a row of underlined tabs and the content of the chosen one. The choice lives in the
 * component, so it survives the reload of the page sources that follows a mutation.
 *
 * @registryCategory disposition
 * @registryTags tabs panels navigation
 */
export function TabPanels({ tabs, defaultTab, counts }: TabPanelsProps): React.ReactElement {
	const [chosen, setChosen] = useState<string | undefined>(defaultTab);
	const baseId = useId();
	const buttons = useRef<Record<string, HTMLButtonElement | null>>({});
	if (tabs.length === 0) {
		return <p className="text-sm text-muted">No tab to show.</p>;
	}
	const current = tabs.find(tab => tab.key === chosen) ?? tabs[0]!;
	const choose = (key: string, focus = false): void => {
		setChosen(key);
		if (focus) {
			buttons.current[key]?.focus();
		}
	};
	const onKeyDown = (event: React.KeyboardEvent, index: number): void => {
		const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
		if (step === 0) {
			return;
		}
		event.preventDefault();
		choose(tabs[(index + step + tabs.length) % tabs.length]!.key, true);
	};
	return (
		<div data-testid="tab-panels">
			<div role="tablist" className="flex gap-4 overflow-x-auto border-b border-border">
				{tabs.map((tab, index) => {
					const selected = tab.key === current.key;
					const count = counts?.[tab.key] ?? tab.count;
					return (
						<button
							key={tab.key}
							ref={element => {
								buttons.current[tab.key] = element;
							}}
							type="button"
							role="tab"
							id={`${baseId}-tab-${tab.key}`}
							aria-selected={selected}
							aria-controls={`${baseId}-panel`}
							tabIndex={selected ? 0 : -1}
							onClick={() => choose(tab.key)}
							onKeyDown={event => onKeyDown(event, index)}
							className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-1 py-2 text-sm font-medium ${
								selected
									? 'border-primary text-content'
									: 'border-transparent text-muted hover:text-content'
							}`}
						>
							{tab.label}
							{count === undefined || count === null ? null : (
								<span className="rounded-full bg-muted-bg px-1.5 py-0.5 text-xs text-muted">
									{count}
								</span>
							)}
						</button>
					);
				})}
			</div>
			<div
				role="tabpanel"
				id={`${baseId}-panel`}
				aria-labelledby={`${baseId}-tab-${current.key}`}
				className="pt-4"
			>
				{current.items}
			</div>
		</div>
	);
}
