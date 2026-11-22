import { ChevronDown, Star } from 'lucide-react';
import React, { useCallback, useId, useMemo, useRef, useState } from 'react';
import { useDismiss } from '../useDismiss.js';
import {
	BUTTON_PRIMARY_CLASS,
	FIELD_CLASS,
	FOCUS_RING,
	GAP_CONTROLS,
	ICON_SIZE,
	PILL_NEUTRAL_CLASS,
	POPOVER_PANEL_CLASS,
	SEARCH_STICKY_CLASS,
} from '../ui/tokens.js';
import type { ProjectOption } from './taskListModel.js';

/** The list gets a search box when it has MORE projects than this. */
export const SEARCH_FROM = 8;

export interface ProjectFilterProps {
	/** In the order to show (favorites, then high, normal, low priority, then name): see `projectOptions`. */
	options: ProjectOption[];
	selected: string[];
	onChange: (selected: string[]) => void;
	/** Controlled, so that the "+N more" chip of the favorites can open this list. */
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * The Project filter of the global list: a button opening checkboxes in importance order. A favorite carries a filled star, a
 * high or low priority a small muted tag; with more than eight projects a search box narrows the list, and "Select all" /
 * "Select matching" and "Clear project" act on it. Several projects are OR.
 */
export function ProjectFilter({ options, selected, onChange, open, onOpenChange }: ProjectFilterProps): React.ReactElement {
	const [query, setQuery] = useState('');
	const ref = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const id = useId();
	const close = useCallback(() => onOpenChange(false), [onOpenChange]);
	useDismiss(ref, open, close);
	const searchable = options.length > SEARCH_FROM;
	const needle = query.trim().toLowerCase();
	const visible = useMemo(
		() => (searchable && needle !== '' ? options.filter(option => option.label.toLowerCase().includes(needle)) : options),
		[options, searchable, needle]
	);
	const active = selected.length > 0;
	const toggle = (value: string): void =>
		onChange(selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value]);
	const selectVisible = (): void => onChange([...selected, ...visible.map(option => option.value).filter(value => !selected.includes(value))]);
	const filtering = searchable && needle !== '';
	return (
		<div
			ref={ref}
			className="relative"
			onKeyDown={event => {
				if (event.key === 'Escape' && open) {
					event.stopPropagation();
					onOpenChange(false);
					button.current?.focus();
				}
			}}
		>
			<button
				ref={button}
				type="button"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				onClick={() => onOpenChange(!open)}
				className={`${PILL_NEUTRAL_CLASS} ${active ? 'border-primary bg-primary-light' : ''}`}
			>
				<span>Project</span>
				{active ? (
					<span className="rounded-full bg-[var(--color-primary-solid)] px-1.5 text-xs text-white">{selected.length}</span>
				) : null}
				<ChevronDown size={ICON_SIZE} aria-hidden="true" />
			</button>
			{open ? (
				<div id={id} role="group" aria-label="Project filter" className={`${POPOVER_PANEL_CLASS} sm:w-[22rem]`}>
					{searchable ? (
						<div className={`${SEARCH_STICKY_CLASS} pb-2`}>
							<input
								type="search"
								aria-label="Search projects"
								placeholder="Search projects"
								value={query}
								onChange={event => setQuery(event.target.value)}
								className={`${FIELD_CLASS} w-full`}
							/>
						</div>
					) : null}
					{options.length === 0 ? <p className="m-0 px-2 py-1 text-sm text-muted">Nothing to filter on.</p> : null}
					{options.length > 0 && visible.length === 0 ? (
						<p className="m-0 px-2 py-1 text-sm text-muted">No project matches.</p>
					) : null}
					<ul className="m-0 flex list-none flex-col p-0">
						{visible.map(option => (
							<li key={option.value}>
								<label className={`flex min-h-8 cursor-pointer items-center ${GAP_CONTROLS} rounded-md px-2 text-sm text-content hover:bg-muted-bg`}>
									<input
										type="checkbox"
										checked={selected.includes(option.value)}
										onChange={() => toggle(option.value)}
										className={`h-4 w-4 shrink-0 accent-[var(--color-primary-solid)] ${FOCUS_RING}`}
									/>
									{option.favorite ? (
										<Star size={ICON_SIZE} fill="currentColor" aria-hidden="true" className="shrink-0 text-warning-text" />
									) : null}
									<span data-testid="project-name" className="min-w-0 flex-1 truncate">
										{option.label}
									</span>
									{' '}
									{option.favorite ? <span className="sr-only">favorite </span> : null}
									{option.priority === 'normal' ? null : (
										<span className="shrink-0 rounded-full border border-border px-1.5 text-xs text-muted">{option.priority}</span>
									)}{' '}
									<span className="shrink-0 text-xs text-muted">{option.count}</span>
								</label>
							</li>
						))}
					</ul>
					{/* Stays at the bottom of the panel while a long list scrolls: the actions are never out of sight. */}
					<div className={`sticky bottom-0 -mx-2 -mb-2 mt-2 flex flex-nowrap items-center justify-between ${GAP_CONTROLS} border-t border-border bg-surface px-2 py-2`}>
						<div className={`flex items-center ${GAP_CONTROLS}`}>
							{options.length > 1 ? (
								<button
									type="button"
									disabled={visible.length === 0}
									onClick={selectVisible}
									className={`whitespace-nowrap rounded-md px-1 text-sm text-muted underline hover:text-content disabled:no-underline disabled:opacity-60 ${FOCUS_RING}`}
								>
									{filtering ? `Select matching (${visible.length})` : `Select all (${visible.length})`}
								</button>
							) : null}
							<button
								type="button"
								disabled={!active}
								onClick={() => onChange([])}
								className={`whitespace-nowrap rounded-md px-1 text-sm text-muted underline hover:text-content disabled:no-underline disabled:opacity-60 ${FOCUS_RING}`}
							>
								Clear project
							</button>
						</div>
						<button type="button" onClick={close} className={BUTTON_PRIMARY_CLASS}>
							Done
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}
