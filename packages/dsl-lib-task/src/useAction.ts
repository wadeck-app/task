import { useEffect, useRef, useState } from 'react';
import { reportOnce } from './reportOnce.js';

/** The handler a page gives to its components (`ctx.onAction`): runs an entry of the view's `$actions`. */
export type ActionHandler = (action: string, params: Record<string, unknown>) => Promise<void> | void;

export const NO_PAGE_HINT = 'This control must be rendered inside a page: there is no action to run';

export interface ActionRunner {
	/** An action name and a handler are both present. */
	available: boolean;
	/** This control's request is in flight, or the page says the action is running. */
	busy: boolean;
	/** Why the control is disabled when it is not `available`, else undefined. */
	unavailableReason: string | undefined;
	/** Runs the action; resolves true when the handler did not reject. Never throws. */
	run: (params: Record<string, unknown>) => Promise<boolean>;
}

/**
 * Runs a page action for a control. The installed shell (dsl-ui 175) hands the handler `(action, params)` and no
 * body: every value travels in `params`, which fill the `{placeholders}` of the action url. The handler publishes the
 * answer under the action's `resultKey` and reloads the sources itself, so a control only has to say what was chosen.
 */
export function useAction(
	who: string,
	action: string | undefined,
	onAction: ActionHandler | undefined,
	actionPending: Record<string, boolean> | undefined
): ActionRunner {
	const [local, setLocal] = useState(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const hasAction = action !== undefined && action !== '';
	const wired = typeof onAction === 'function';
	useEffect(() => {
		if (hasAction && !wired) {
			reportOnce(
				`[${who}] cannot run action "${action}": render it inside a page (it provides onAction) or pass onAction.`
			);
		}
	}, [who, action, hasAction, wired]);

	const run = async (params: Record<string, unknown>): Promise<boolean> => {
		if (!hasAction || !onAction) {
			return false;
		}
		setLocal(true);
		try {
			await onAction(action, params);
			return true;
		} catch (error) {
			console.error(
				`[${who}] action "${action}" failed: ${error instanceof Error ? error.message : String(error)}`
			);
			return false;
		} finally {
			if (mounted.current) {
				setLocal(false);
			}
		}
	};
	return {
		available: hasAction && wired,
		busy: local || (hasAction && actionPending?.[action] === true),
		unavailableReason: hasAction && !wired ? NO_PAGE_HINT : undefined,
		run,
	};
}
