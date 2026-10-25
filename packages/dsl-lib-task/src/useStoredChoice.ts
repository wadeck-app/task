import { useEffect, useRef, useState } from 'react';
import { reportOnce } from './reportOnce.js';

// Instances sharing a key (the same test declared twice) must agree within one tab too: the `storage` event only
// fires in OTHER tabs, so a choice is also announced here.
const sameTabListeners = new Map<string, Set<(value: string) => void>>();

/**
 * One value among `options`, kept in localStorage under `key`. Same contract as dsl-ui's `usePersistentChoice`
 * (which the shell does not export), so the keys (`ab.<id>`, `ab.collapsed`) and the URL override stay compatible:
 * - an unknown stored or URL value is reported (console.warn, once) and `initial` applies;
 * - `urlParam` lets a link force the value for this page load; it is not stored, only a later choice is;
 * - a change in another tab, or by another instance with the same key, is applied here too;
 * - `enabled` false: the value is `initial` and nothing is read from or written to the storage or the URL.
 *   It is read at mount: switching it on later does not re-read the storage.
 */
export function useStoredChoice<T extends string>(
	key: string,
	options: readonly T[],
	initial: T,
	label: string,
	urlParam: string | undefined,
	enabled: boolean
): [T, (value: T) => void] {
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const isOption = (value: string): value is T => (options as readonly string[]).includes(value);
	const expected = `expected one of: ${options.join(', ')}.`;

	const [value, setValue] = useState<T>(() => {
		if (!enabled) {
			return initial;
		}
		const fromUrl = urlParam ? new URLSearchParams(window.location.search).get(urlParam) : null;
		if (fromUrl !== null) {
			if (isOption(fromUrl)) {
				return fromUrl;
			}
			reportOnce(
				`[ab] Ignoring unknown ${label} "${fromUrl}" in the URL parameter "${urlParam}"; ${expected}`,
				'warn'
			);
		}
		const stored = localStorage.getItem(key);
		if (stored === null) {
			return initial;
		}
		if (isOption(stored)) {
			return stored;
		}
		reportOnce(`[ab] Ignoring unknown ${label} "${stored}" in localStorage "${key}"; ${expected}`, 'warn');
		return initial;
	});

	useEffect(() => {
		if (!enabled) {
			return undefined;
		}
		const apply = (next: string): void => {
			if ((optionsRef.current as readonly string[]).includes(next)) {
				setValue(next as T);
			}
		};
		const onStorage = (event: StorageEvent): void => {
			if (event.storageArea !== localStorage || event.key !== key || event.newValue === null) {
				return;
			}
			apply(event.newValue);
		};
		window.addEventListener('storage', onStorage);
		let listeners = sameTabListeners.get(key);
		if (!listeners) {
			listeners = new Set();
			sameTabListeners.set(key, listeners);
		}
		listeners.add(apply);
		return () => {
			window.removeEventListener('storage', onStorage);
			listeners.delete(apply);
			if (listeners.size === 0) {
				sameTabListeners.delete(key);
			}
		};
	}, [key, enabled]);

	const choose = (next: T): void => {
		if (!enabled) {
			return;
		}
		localStorage.setItem(key, next);
		setValue(next);
		sameTabListeners.get(key)?.forEach(listener => listener(next));
	};
	return [value, choose];
}
