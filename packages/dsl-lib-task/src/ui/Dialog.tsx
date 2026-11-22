import { X } from 'lucide-react';
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CONTROL_BORDER, CONTROL_H, CONTROL_RADIUS, FOCUS_RING, GAP_CONTROLS, ICON_BUTTON_CLASS, ICON_SIZE, PILL_TEXT } from './tokens.js';

/**
 * A modal dialog over the page, for an editor whose draft must not be lost by a stray click. The dsl-ui `Dialog` was not
 * used: it has no scrolling body, no footer that stays in view, no scroll lock, no full-screen layout on a phone and closes
 * on the backdrop without asking, which loses a draft.
 *
 * Drawn in a portal on `document.body`. The page behind stays rendered (and keeps updating) under a dimmed backdrop.
 * The focus moves to the dialog and goes back to the element that had it; Tab cycles inside; the page does not scroll.
 * Escape, the close button, the backdrop and the footer's own cancel (through `requestClose`) close it at once when
 * `dirty` is false, and otherwise ask "Discard changes?" inside the dialog (Keep editing / Discard). Nothing closes it
 * while `busy`.
 */

export interface DialogApi {
	/** Closes (or, with unsaved changes, asks first): what a Cancel button calls. */
	requestClose: () => void;
}

export interface DialogProps {
	/** The heading, and the accessible name of the dialog. */
	title: string;
	/** Prefix of the test ids: `<id>` (the dialog), `<id>-backdrop`, `<id>-body`, `<id>-footer`, `<id>-discard`. */
	testId: string;
	/** Maximum width above 640 px: `md` is 56rem, `lg` is 64rem. Below 640 px the dialog is full screen. */
	size?: 'md' | 'lg';
	/** There is something to lose: closing asks first. */
	dirty: boolean;
	/** A save is running: nothing closes the dialog. */
	busy: boolean;
	/** Called when the dialog really closes (nothing to lose, or Discard). */
	onClose: () => void;
	/** Always visible between the scrolling body and the footer (an error). */
	alert?: React.ReactNode;
	/** The actions, pinned at the bottom whatever the height of the body. */
	footer: (api: DialogApi) => React.ReactNode;
	children: React.ReactNode;
}

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

const BACKDROP_CLASS = 'fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 p-0 sm:items-center sm:p-4';
const PANEL_BASE =
	'flex h-full w-full flex-col overflow-hidden border-0 bg-surface text-content shadow-xl focus:outline-none sm:h-auto sm:max-h-[90vh] sm:rounded-lg sm:border sm:border-border';
const SIZE_CLASS = { md: 'max-w-4xl', lg: 'max-w-5xl' } as const;
const SECONDARY_BUTTON_CLASS = `inline-flex ${CONTROL_H} items-center justify-center ${GAP_CONTROLS} ${CONTROL_RADIUS} ${CONTROL_BORDER} bg-surface px-3 ${PILL_TEXT} text-content hover:bg-muted-bg ${FOCUS_RING}`;

/** The controls of `root` that Tab can reach, in document order. */
function tabbables(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
		element =>
			!(element as HTMLButtonElement).disabled &&
			element.getAttribute('tabindex') !== '-1' &&
			element.closest('[hidden], [aria-hidden="true"]') === null
	);
}

export function Dialog({
	title,
	testId,
	size = 'md',
	dirty,
	busy,
	onClose,
	alert,
	footer,
	children,
}: DialogProps): React.ReactElement {
	const titleId = useId();
	const panel = useRef<HTMLDivElement>(null);
	const keepButton = useRef<HTMLButtonElement>(null);
	const [confirming, setConfirming] = useState(false);
	// A press that began inside the panel and ended on the backdrop (a text selection) is not a click on the backdrop.
	const pressedBackdrop = useRef(true);

	// The latest values for the document listeners (registered once).
	const live = useRef({ dirty, busy, onClose, confirming });
	live.current = { dirty, busy, onClose, confirming };

	const requestClose = useCallback((): void => {
		const { dirty: unsaved, busy: saving, onClose: close } = live.current;
		if (saving) {
			return;
		}
		if (unsaved) {
			setConfirming(true);
		} else {
			close();
		}
	}, []);

	// Set while the dialog goes away: giving the focus back must not be undone by the focus guard.
	const leaving = useRef(false);
	// Focus goes into the dialog when it opens and back to what had it when it closes.
	useLayoutEffect(() => {
		const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		leaving.current = false;
		panel.current?.focus();
		return () => {
			leaving.current = true;
			if (before !== null && before.isConnected) {
				before.focus();
			}
		};
	}, []);

	// The page behind does not scroll (the width of its scrollbar is kept, so it does not jump).
	useEffect(() => {
		const { body } = document;
		const previous = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
		const scrollbar = window.innerWidth - document.documentElement.clientWidth;
		body.style.overflow = 'hidden';
		if (scrollbar > 0 && document.documentElement.clientWidth > 0) {
			body.style.paddingRight = `${scrollbar}px`;
		}
		return () => {
			body.style.overflow = previous.overflow;
			body.style.paddingRight = previous.paddingRight;
		};
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			const root = panel.current;
			if (root === null) {
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				if (live.current.confirming) {
					setConfirming(false);
				} else {
					requestClose();
				}
				return;
			}
			if (event.key !== 'Tab') {
				return;
			}
			const items = tabbables(root);
			const first = items[0];
			const last = items[items.length - 1];
			if (first === undefined || last === undefined) {
				event.preventDefault();
				root.focus();
				return;
			}
			const active = document.activeElement;
			if (event.shiftKey && (active === first || active === root || !root.contains(active))) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && (active === last || !root.contains(active))) {
				event.preventDefault();
				first.focus();
			}
		};
		const onFocusIn = (event: FocusEvent): void => {
			const root = panel.current;
			if (!leaving.current && root !== null && event.target instanceof Node && !root.contains(event.target)) {
				(tabbables(root)[0] ?? root).focus();
			}
		};
		document.addEventListener('keydown', onKeyDown);
		document.addEventListener('focusin', onFocusIn);
		return () => {
			document.removeEventListener('keydown', onKeyDown);
			document.removeEventListener('focusin', onFocusIn);
		};
	}, [requestClose]);

	// The question takes the focus; once answered "keep editing" the focus stays in the dialog.
	const wasConfirming = useRef(false);
	useEffect(() => {
		if (confirming) {
			keepButton.current?.focus();
		} else if (wasConfirming.current) {
			panel.current?.focus();
		}
		wasConfirming.current = confirming;
	}, [confirming]);

	return createPortal(
		<div
			data-testid={`${testId}-backdrop`}
			className={BACKDROP_CLASS}
			onMouseDown={event => {
				pressedBackdrop.current = event.target === event.currentTarget;
			}}
			onClick={event => {
				const started = pressedBackdrop.current;
				pressedBackdrop.current = true;
				if (event.target === event.currentTarget && started) {
					requestClose();
				}
			}}
		>
			<div
				ref={panel}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				tabIndex={-1}
				data-testid={testId}
				className={`${PANEL_BASE} ${SIZE_CLASS[size]}`}
			>
				<div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-4 py-3">
					<h2 id={titleId} className="m-0 min-w-0 text-base font-semibold text-content">
						{title}
					</h2>
					<button
						type="button"
						aria-label="Close"
						title="Close"
						disabled={busy}
						onClick={requestClose}
						className={ICON_BUTTON_CLASS}
					>
						<X size={ICON_SIZE} aria-hidden="true" />
					</button>
				</div>
				<div data-testid={`${testId}-body`} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
					{children}
				</div>
				{alert !== undefined && alert !== null ? (
					<div className="shrink-0 border-t border-border px-4 py-2">{alert}</div>
				) : null}
				<div
					data-testid={`${testId}-footer`}
					className={`flex shrink-0 flex-wrap items-center ${GAP_CONTROLS} border-t border-border bg-surface px-4 py-3`}
				>
					{confirming ? (
						<div
							role="group"
							aria-label="Discard changes?"
							data-testid={`${testId}-discard`}
							className={`flex w-full flex-wrap items-center ${GAP_CONTROLS}`}
						>
							<span className="flex-1 text-sm font-medium text-content">Discard changes?</span>
							<button
								ref={keepButton}
								type="button"
								onClick={() => setConfirming(false)}
								className={SECONDARY_BUTTON_CLASS}
							>
								Keep editing
							</button>
							<button type="button" onClick={() => onClose()} className={SECONDARY_BUTTON_CLASS}>
								Discard
							</button>
						</div>
					) : (
						footer({ requestClose })
					)}
				</div>
			</div>
		</div>,
		document.body
	);
}
