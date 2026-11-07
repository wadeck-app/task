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
		const outside = (target: EventTarget | null): boolean =>
			ref.current !== null && target instanceof Node && !ref.current.contains(target);
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
