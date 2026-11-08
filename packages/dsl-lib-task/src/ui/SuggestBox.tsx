import { Search } from 'lucide-react';
import React, { useId, useState } from 'react';
import { FIELD_CLASS, ICON_SIZE, RESULTS_CLASS, SEARCH_STICKY_CLASS } from './tokens.js';

export interface SuggestOption {
	key: string;
	label: string;
	/** Muted text after the label (a count). */
	hint?: string;
	/** The row creates the typed text (`Create "x"`). */
	create?: boolean;
}

export interface SuggestBoxProps {
	/** Accessible name of the input. */
	ariaLabel: string;
	placeholder?: string;
	value: string;
	onChange: (value: string) => void;
	options: SuggestOption[];
	/** Accessible name of the list. */
	listLabel: string;
	loading?: boolean;
	loadProblem?: string | null;
	/** Enter: the highlighted option, else undefined (the caller decides what the raw text means). */
	onSubmit: (highlighted: SuggestOption | undefined) => void;
	/** A click on an option. */
	onPick: (option: SuggestOption) => void;
	busy?: boolean;
	autoFocus?: boolean;
	inputRef?: React.Ref<HTMLInputElement>;
	/** Called for keys the box does not use (Enter handled by `onSubmit` only). */
	onKeyDownExtra?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

const SKELETON_ROWS = 3;

/**
 * A text input with its suggestions drawn BELOW it, in the flow of the popover that holds it: the input stays on top
 * (pinned while the list scrolls on a narrow screen) and the typed text is never covered. Arrows move the highlight,
 * Enter reports it, Escape is left to the popover.
 */
export function SuggestBox({
	ariaLabel,
	placeholder,
	value,
	onChange,
	options,
	listLabel,
	loading = false,
	loadProblem = null,
	onSubmit,
	onPick,
	busy = false,
	autoFocus = false,
	inputRef,
	onKeyDownExtra,
}: SuggestBoxProps): React.ReactElement {
	const baseId = useId();
	const [active, setActive] = useState(-1);
	const showResults = loading || loadProblem !== null || options.length > 0;
	const optionId = (index: number): string => `${baseId}-opt-${index}`;
	const highlighted = active >= 0 && active < options.length ? options[active] : undefined;

	return (
		<div data-testid="suggest-box" className="flex flex-col">
			<div data-testid="suggest-input" className={`relative flex items-center ${SEARCH_STICKY_CLASS}`}>
				<Search
					size={ICON_SIZE}
					aria-hidden="true"
					className="pointer-events-none absolute left-2 text-muted"
				/>
				<input
					ref={inputRef}
					type="text"
					role="combobox"
					aria-label={ariaLabel}
					aria-expanded={showResults}
					aria-controls={showResults ? `${baseId}-list` : undefined}
					aria-autocomplete="list"
					aria-activedescendant={highlighted ? optionId(active) : undefined}
					aria-busy={busy || undefined}
					autoComplete="off"
					autoFocus={autoFocus}
					placeholder={placeholder}
					value={value}
					readOnly={busy}
					onChange={event => {
						setActive(-1);
						onChange(event.target.value);
					}}
					onKeyDown={event => {
						if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
							event.preventDefault();
							if (options.length > 0) {
								const step = event.key === 'ArrowDown' ? 1 : -1;
								setActive(current => Math.min(options.length - 1, Math.max(-1, current + step)));
							}
						} else if (event.key === 'Enter') {
							event.preventDefault();
							onSubmit(highlighted);
						} else {
							onKeyDownExtra?.(event);
						}
					}}
					className={`w-full pl-7 ${FIELD_CLASS}`}
				/>
			</div>
			{showResults ? (
				<div data-testid="suggest-results" className={RESULTS_CLASS}>
					{loading
						? Array.from({ length: SKELETON_ROWS }, (_, i) => (
								<div
									key={i}
									data-testid="suggest-skeleton"
									aria-hidden="true"
									className="flex animate-pulse items-center gap-2 px-3 py-1.5"
								>
									<span className="h-3 flex-1 rounded bg-muted-bg" />
									<span className="h-3 w-6 rounded bg-muted-bg" />
								</div>
							))
						: null}
					{!loading && loadProblem !== null ? (
						<p role="alert" className="px-3 py-2 text-xs text-danger-text">
							{loadProblem}
						</p>
					) : null}
					<div id={`${baseId}-list`} role="listbox" aria-busy={loading || undefined} aria-label={listLabel}>
						{options.map((option, index) => (
							<div
								key={option.key}
								id={optionId(index)}
								role="option"
								aria-selected={index === active}
								onMouseDown={event => event.preventDefault()}
								onMouseEnter={() => setActive(index)}
								onClick={() => onPick(option)}
								className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${index === active ? 'bg-muted-bg' : ''}`}
							>
								<span className="min-w-0 flex-1 truncate text-content">
									{option.create ? `Create "${option.label}"` : option.label}
								</span>
								{option.hint ? (
									<span className="shrink-0 text-xs text-muted">{option.hint}</span>
								) : null}
							</div>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}
