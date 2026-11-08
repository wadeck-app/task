import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** How long a requested refocus waits for the field to be drawn again (the page reloads its sources after an action). */
export const REFOCUS_WINDOW_MS = 3000;

export interface Refocus<T extends HTMLElement> {
	/** The `ref` of the field that takes the focus back. A field drawn again (a remount) is found by it. */
	fieldRef: (element: T | null) => void;
	/**
	 * Call once an add has SUCCEEDED: the field gets the focus back, now or as soon as it is drawn again, so several entries can
	 * be typed one after the other. Never call it on a failure (the text stays, the user is reading the message).
	 */
	refocus: () => void;
}

/**
 * Puts the focus back on a field after a successful action, without ever stealing it: the field takes it only when the
 * focus is nowhere (`body`), on the field itself, or still inside `scope` (the component, e.g. on its own Add button).
 * A user who clicked somewhere else while the request ran keeps the focus where it is.
 *
 * Why a request that waits: the shell reloads the page's sources after the action, and the field of the first sub-task is
 * drawn at another place of the tree than the field of an empty list, so it is a NEW element. The pending request is served
 * by the callback ref of that new element, for {@link REFOCUS_WINDOW_MS} at most.
 */
export function useRefocus<T extends HTMLElement>(scope: RefObject<HTMLElement | null>): Refocus<T> {
	const element = useRef<T | null>(null);
	const pending = useRef(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const settle = useCallback((): boolean => {
		const field = element.current;
		if (!pending.current || field === null || !field.isConnected) {
			return false;
		}
		const active = document.activeElement;
		const free = active === null || active === document.body;
		const mine = active === field || (scope.current?.contains(active) ?? false);
		pending.current = false;
		clearTimeout(timer.current);
		if (free || mine) {
			field.focus();
		}
		return true;
	}, [scope]);

	useEffect(
		() => () => {
			pending.current = false;
			clearTimeout(timer.current);
		},
		[]
	);

	const fieldRef = useCallback(
		(next: T | null): void => {
			element.current = next;
			// A field drawn again while a refocus waits: the user may still be nowhere, so it takes the focus.
			if (next !== null) {
				settle();
			}
		},
		[settle]
	);

	const refocus = useCallback((): void => {
		pending.current = true;
		clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			pending.current = false;
		}, REFOCUS_WINDOW_MS);
		// The focus given now may be lost by a remount that follows (the sources reload): the request stays pending for the
		// window, and a field drawn again takes it from `fieldRef`.
		if (settle()) {
			pending.current = true;
		}
	}, [settle]);

	return { fieldRef, refocus };
}
