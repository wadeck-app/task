import { ChevronDown } from 'lucide-react';
import React, { useCallback, useId, useRef, useState } from 'react';
import { useDismiss } from '../useDismiss.js';
import {
	BUTTON_PRIMARY_CLASS,
	FOCUS_RING,
	GAP_CONTROLS,
	ICON_SIZE,
	PILL_NEUTRAL_CLASS,
	POPOVER_PANEL_CLASS,
} from '../ui/tokens.js';
import type { FacetOption } from './taskListModel.js';

export interface FacetFilterProps {
	/** "Status": the button text and the name of the group ("Status filter"). */
	label: string;
	options: FacetOption[];
	selected: string[];
	onChange: (selected: string[]) => void;
}

/** A button that opens a list of checkboxes (value, count): several values of one facet are OR. */
export function FacetFilter({ label, options, selected, onChange }: FacetFilterProps): React.ReactElement {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const id = useId();
	const close = useCallback(() => setOpen(false), []);
	useDismiss(ref, open, close);
	const toggle = (value: string): void =>
		onChange(selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value]);
	const active = selected.length > 0;
	return (
		<div
			ref={ref}
			className="relative"
			onKeyDown={event => {
				if (event.key === 'Escape' && open) {
					event.stopPropagation();
					setOpen(false);
					button.current?.focus();
				}
			}}
		>
			<button
				ref={button}
				type="button"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				onClick={() => setOpen(value => !value)}
				className={`${PILL_NEUTRAL_CLASS} ${active ? 'border-primary bg-primary-light' : ''}`}
			>
				<span>{label}</span>
				{active ? (
					<span className="rounded-full bg-[var(--color-primary-solid)] px-1.5 text-xs text-white">{selected.length}</span>
				) : null}
				<ChevronDown size={ICON_SIZE} aria-hidden="true" />
			</button>
			{open ? (
				<div id={id} role="group" aria-label={`${label} filter`} className={POPOVER_PANEL_CLASS}>
					{options.length === 0 ? <p className="m-0 px-2 py-1 text-sm text-muted">Nothing to filter on.</p> : null}
					<ul className="m-0 flex list-none flex-col p-0">
						{options.map(option => (
							<li key={option.value}>
								<label className={`flex min-h-8 cursor-pointer items-center ${GAP_CONTROLS} rounded-md px-2 text-sm text-content hover:bg-muted-bg`}>
									<input
										type="checkbox"
										checked={selected.includes(option.value)}
										onChange={() => toggle(option.value)}
										className={`h-4 w-4 shrink-0 accent-[var(--color-primary-solid)] ${FOCUS_RING}`}
									/>
									<span className="min-w-0 flex-1 truncate">{option.label}</span>{' '}
									<span className="shrink-0 text-xs text-muted">{option.count}</span>
								</label>
							</li>
						))}
					</ul>
					<div className={`mt-2 flex items-center justify-between ${GAP_CONTROLS}`}>
						<button
							type="button"
							disabled={!active}
							onClick={() => onChange([])}
							className={`rounded-md px-2 text-sm text-muted underline hover:text-content disabled:no-underline disabled:opacity-60 ${FOCUS_RING}`}
						>
							Clear {label.toLowerCase()}
						</button>
						<button type="button" onClick={close} className={BUTTON_PRIMARY_CLASS}>
							Done
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}
