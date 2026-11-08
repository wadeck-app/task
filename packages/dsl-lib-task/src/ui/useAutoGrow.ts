import { useCallback, useEffect, useLayoutEffect } from 'react';
import type { RefObject } from 'react';

// The same cap as the inline text editor: this many lines or 60% of the window, then the field scrolls inside.
const MAX_LINES = 24;
const LINE_PX = 24;

/**
 * Makes a textarea as tall as its text (as the browser wraps it) up to a cap, then lets it scroll. Re-measured when
 * `text` changes and when the window or the box is resized. When the browser cannot measure (not laid out) the style is
 * left alone and the `rows` of the field stand.
 */
export function useAutoGrow(field: RefObject<HTMLTextAreaElement | null>, text: string, enabled = true): void {
	const fit = useCallback((): void => {
		const el = field.current;
		if (!el) {
			return;
		}
		el.style.height = 'auto';
		const needed = el.scrollHeight;
		if (needed <= 0) {
			el.style.height = '';
			el.style.overflowY = 'hidden';
			return;
		}
		const cap = Math.min(window.innerHeight * 0.6, MAX_LINES * LINE_PX);
		el.style.height = `${Math.min(needed, cap)}px`;
		el.style.overflowY = needed > cap ? 'auto' : 'hidden';
	}, [field]);

	useLayoutEffect(() => {
		if (enabled) {
			fit();
		}
	}, [enabled, text, fit]);

	useEffect(() => {
		if (!enabled) {
			return undefined;
		}
		window.addEventListener('resize', fit);
		const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => fit());
		if (field.current?.parentElement) {
			observer?.observe(field.current.parentElement);
		}
		return () => {
			window.removeEventListener('resize', fit);
			observer?.disconnect();
		};
	}, [enabled, fit, field]);
}
