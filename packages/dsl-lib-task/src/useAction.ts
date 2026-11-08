import { useEffect, useRef, useState } from 'react';
import { reportOnce } from './reportOnce.js';

/** Extra arguments of a run: the JSON body (dsl-ui >= 318 `ctx.onAction(name, params, { body })`). */
export interface ActionOptions {
	body?: unknown;
}

/**
 * The handler a page gives to its components (`ctx.onAction`): runs an entry of the view's `$actions`. It may resolve
 * the answer the shell published (an object with `error` when the request failed: the shell does not reject then).
 */
export type ActionHandler = (
	action: string,
	params: Record<string, unknown>,
	options?: ActionOptions
) => Promise<unknown> | unknown;

/** The shell publishes a failed request as `{ error, status }` and resolves; a handler may also resolve `false`. */
function isErrorAnswer(answer: unknown): boolean {
	return (
		answer === false ||
		(typeof answer === 'object' &&
			answer !== null &&
			'error' in answer &&
			Boolean((answer as { error: unknown }).error))
	);
}

/** Why the last run of an action did not succeed: the handler rejected (`thrown`) or the shell answered with an error. */
export interface ActionFailure {
	kind: 'thrown' | 'answer';
	/** The words of the error, empty when the answer carried none. */
	message: string;
}

function failureOfAnswer(answer: unknown): ActionFailure {
	const error =
		typeof answer === 'object' && answer !== null && 'error' in answer ? (answer as { error: unknown }).error : '';
	return { kind: 'answer', message: typeof error === 'string' ? error : '' };
}

export const NO_PAGE_HINT = 'This control must be rendered inside a page: there is no action to run';

export interface ActionRunner {
	/** An action name and a handler are both present. */
	available: boolean;
	/** This control's request is in flight, or the page says the action is running. */
	busy: boolean;
	/** Why the control is disabled when it is not `available`, else undefined. */
	unavailableReason: string | undefined;
	/**
	 * Runs the action, with a JSON body when one is given; resolves true when the handler neither rejected nor
	 * answered with an error. Never throws.
	 */
	run: (params: Record<string, unknown>, body?: unknown) => Promise<boolean>;
	/** Why the last run failed, null when it succeeded or none ran. Read it right after `run` resolved false. */
	lastFailure: () => ActionFailure | null;
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

	const failure = useRef<ActionFailure | null>(null);
	const run = async (params: Record<string, unknown>, body?: unknown): Promise<boolean> => {
		if (!hasAction || !onAction) {
			return false;
		}
		setLocal(true);
		failure.current = null;
		try {
			const answer =
				body === undefined ? await onAction(action, params) : await onAction(action, params, { body });
			if (isErrorAnswer(answer)) {
				failure.current = failureOfAnswer(answer);
				return false;
			}
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[${who}] action "${action}" failed: ${message}`);
			failure.current = { kind: 'thrown', message };
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
		lastFailure: () => failure.current,
	};
}
