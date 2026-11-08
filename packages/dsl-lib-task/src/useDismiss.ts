import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Calls `onDismiss` when a pointer goes down outside `ref` or focus moves outside it, while `active`. Escape is the
 * caller's business (each control decides what the key does).
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, active: boolean, onDismiss: () => void): void {
	useEffect(() => {
		if (!active) {
			return undefined;
		}
		// A modal dialog opened from inside the element is drawn elsewhere in the document (a portal): what happens in it is
		// not "outside" the control that opened it, or the control would close, and take the dialog with it, as it opens.
		const inDialog = (target: Node): boolean =>
			target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"]') !== null;
		const outside = (target: EventTarget | null): boolean =>
			ref.current !== null && target instanceof Node && !ref.current.contains(target) && !inDialog(target);
		const onPointer = (event: Event): void => {
			if (outside(event.target)) {
				onDismiss();
			}
		};
		const onFocus = (event: FocusEvent): void => {
			if (outside(event.target)) {
				onDismiss();
			}
		};
		document.addEventListener('pointerdown', onPointer, true);
		document.addEventListener('focusin', onFocus, true);
		return () => {
			document.removeEventListener('pointerdown', onPointer, true);
			document.removeEventListener('focusin', onFocus, true);
		};
	}, [ref, active, onDismiss]);
}
