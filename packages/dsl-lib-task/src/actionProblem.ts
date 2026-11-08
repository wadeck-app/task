import type { ActionFailure } from './useAction.js';

/**
 * The shell reads every answer that is not a 204 with `response.json()`. When something between the browser and the task
 * module answers without a body (app-core restarting, a dev proxy whose target is down), the action rejects with the
 * browser's own words: "Failed to execute 'json' on 'Response': Unexpected end of JSON input". Nobody can act on that text.
 */
export function isUnreadableAnswer(failure: ActionFailure | null): boolean {
	return (
		failure !== null &&
		/json/i.test(failure.message) &&
		/(unexpected end|unexpected token|is not valid|not valid json)/i.test(failure.message)
	);
}

/**
 * The sentence shown next to a field whose add failed. `what` is the subject ("The sub-task"); the text stays in the field
 * (`Your text is kept`), so the user can send it again once the cause is fixed.
 */
export function addProblemText(what: string, failure: ActionFailure | null): string {
	if (isUnreadableAnswer(failure)) {
		return `${what} was not added. The server did not answer with JSON: the task backend or app-core is probably restarting or unreachable. Your text is kept; send it again in a few seconds.`;
	}
	if (failure !== null && failure.message !== '') {
		return `${what} was not added: ${failure.message}. Your text is kept; send it again when fixed.`;
	}
	return `${what} was not added. The page shows the reason. Your text is kept; send it again when fixed.`;
}
