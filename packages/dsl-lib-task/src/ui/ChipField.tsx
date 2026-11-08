import { Plus, X } from 'lucide-react';
import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useDismiss } from '../useDismiss.js';
import { InsidePopoverContext } from './popoverContext.js';
import {
	CONTROL_BORDER,
	CONTROL_H,
	CONTROL_RADIUS,
	FOCUS_RING,
	GAP_CONTROLS,
	ICON_SIZE,
	PILL_ADD_CLASS,
	PILL_RADIUS,
	PILL_TEXT,
	POPOVER_PANEL_CLASS,
} from './tokens.js';

/** The popover of a chip field inside another popover: in the flow, no float, no sheet. */
const NESTED_PANEL_CLASS = `flex flex-col ${GAP_CONTROLS} ${CONTROL_RADIUS} ${CONTROL_BORDER} bg-surface p-2`;

export type ChipMode = { kind: 'add' } | { kind: 'edit'; key: string };

export interface ChipSpec {
	key: string;
	/** What the chip shows (`billing`, or `owner: ann`). */
	content: React.ReactNode;
	/** Tooltip with the whole text. */
	title?: string;
	/** Background and text colour classes. */
	colorClass: string;
	/** Accessible name of the x. */
	removeLabel: string;
	/** Accessible name of the chip body when clicking it edits (absent = the body is plain text). */
	editLabel?: string;
}

export interface ChipFieldProps {
	/** `data-testid` of the root. */
	testId: string;
	/** `data-testid` of each chip. */
	chipTestId: string;
	chips: ChipSpec[];
	/** Accessible name of the "+ Add" chip button and of its popover (`Add label`, `Add property`). */
	addLabel: string;
	/** Whether the "+ Add" chip is shown. */
	canAdd: boolean;
	/** Why the "+ Add" chip cannot be used (tooltip), when the action is missing. */
	addUnavailableReason?: string;
	/** Whether each chip has an x. */
	canRemove: boolean;
	/** The x cannot be used right now (busy, action missing). */
	removeOff: boolean;
	removeUnavailableReason?: string;
	/** Clicking a chip body opens the popover in edit mode. */
	canEdit?: boolean;
	/** Any action in flight: the controls wait. */
	busy: boolean;
	onRemove: (key: string) => void;
	/** Extra content at the end of the row, before the "+ Add" chip (a "Show 2 more" chip, an empty text). */
	extra?: React.ReactNode;
	/** The content of the popover. Call `close` when the work is done. */
	renderPanel: (api: { mode: ChipMode; close: () => void }) => React.ReactNode;
}

/**
 * The ONE shape of "a list of small things on a task": a wrapping row of chips (x removes), a trailing dashed "+ Add"
 * chip, and a popover under the row for adding (and for editing a chip). Labels and metadata are both built on it, so
 * their height, radius, gaps and interaction cannot diverge. The popover is in the flow of its own box: what the user
 * types and the suggestions below it never overlap.
 */
export function ChipField({
	testId,
	chipTestId,
	chips,
	addLabel,
	canAdd,
	addUnavailableReason,
	canRemove,
	removeOff,
	removeUnavailableReason,
	canEdit = false,
	busy,
	onRemove,
	extra,
	renderPanel,
}: ChipFieldProps): React.ReactElement {
	const root = useRef<HTMLDivElement>(null);
	const addButton = useRef<HTMLButtonElement>(null);
	const nested = useContext(InsidePopoverContext);
	const [mode, setMode] = useState<ChipMode | null>(null);
	const open = mode !== null;

	const close = useCallback((): void => setMode(null), []);
	useDismiss(root, open, close);

	// The focus goes back to "+ Add" once the popover is gone AND the button can take it: a panel closes right after its action
	// resolved, while the button is still disabled by `busy` (a disabled button ignores focus()), so the focus waits for a render.
	const focusAddNext = useRef(false);
	const closeAndFocus = useCallback((): void => {
		setMode(null);
		focusAddNext.current = true;
	}, []);
	useEffect(() => {
		const button = addButton.current;
		if (focusAddNext.current && mode === null && button !== null && !button.disabled) {
			focusAddNext.current = false;
			button.focus();
		}
	});

	return (
		<div
			ref={root}
			data-testid={testId}
			className={`relative flex flex-col ${GAP_CONTROLS}`}
			onKeyDown={event => {
				if (event.key === 'Escape' && open) {
					event.preventDefault();
					event.stopPropagation();
					closeAndFocus();
				}
			}}
		>
			<div className={`flex flex-wrap items-center ${GAP_CONTROLS}`}>
				{chips.map(chip => (
					<span
						key={chip.key}
						data-testid={chipTestId}
						className={`inline-flex max-w-full items-center ${GAP_CONTROLS} ${CONTROL_H} ${PILL_RADIUS} pl-3 ${canRemove ? 'pr-2' : 'pr-3'} ${PILL_TEXT} ${chip.colorClass}`}
					>
						{canEdit && chip.editLabel ? (
							<button
								type="button"
								aria-label={chip.editLabel}
								title={chip.title}
								disabled={busy}
								onClick={() => setMode({ kind: 'edit', key: chip.key })}
								className={`min-w-0 max-w-[16rem] truncate ${PILL_RADIUS} text-left ${FOCUS_RING} disabled:cursor-not-allowed`}
							>
								{chip.content}
							</button>
						) : (
							<span className="min-w-0 max-w-[16rem] truncate" title={chip.title}>
								{chip.content}
							</span>
						)}
						{canRemove ? (
							<button
								type="button"
								aria-label={chip.removeLabel}
								title={removeUnavailableReason ?? chip.removeLabel}
								disabled={removeOff || busy}
								onClick={() => onRemove(chip.key)}
								className={`inline-flex shrink-0 ${PILL_RADIUS} p-1 opacity-70 hover:opacity-100 ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-40`}
							>
								<X size={ICON_SIZE} aria-hidden="true" />
							</button>
						) : null}
					</span>
				))}
				{extra}
				{canAdd ? (
					<button
						ref={addButton}
						type="button"
						aria-label={addLabel}
						aria-haspopup="dialog"
						aria-expanded={mode?.kind === 'add'}
						title={addUnavailableReason}
						disabled={addUnavailableReason !== undefined || busy}
						onClick={() => setMode(current => (current?.kind === 'add' ? null : { kind: 'add' }))}
						className={PILL_ADD_CLASS}
					>
						<Plus size={ICON_SIZE} aria-hidden="true" />
						Add
					</button>
				) : null}
			</div>
			{mode ? (
				<div
					role="dialog"
					aria-label={mode.kind === 'add' ? addLabel : `Edit ${mode.key}`}
					data-testid={`${testId}-panel`}
					className={nested ? NESTED_PANEL_CLASS : `${POPOVER_PANEL_CLASS} w-72 gap-2`}
				>
					{renderPanel({ mode, close: closeAndFocus })}
				</div>
			) : null}
		</div>
	);
}
