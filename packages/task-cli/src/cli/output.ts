import { describeError } from '@wadeck-app/task-service';
import type { TaskSummary } from '@wadeck-app/task-core';

/** What a command hands back to the process entry: the exit code and the text for stdout (0) or stderr (otherwise). */
export interface CommandResult {
	exitCode: number;
	output: string;
}

/** A failed command: `{"error": ...}` in JSON mode, else `Error: <message>` followed by the hint line. */
export function errorOutput(jsonMode: boolean, message: string, hint?: string): CommandResult {
	if (jsonMode) {
		return { exitCode: 1, output: JSON.stringify({ error: message }) };
	}
	const lines = [`Error: ${message}`];
	if (hint) lines.push(hint);
	return { exitCode: 1, output: lines.join('\n') };
}

/** A failed command whose cause is a thrown error: its message plus the actionable hint it carries, if any. */
export function failure(jsonMode: boolean, error: unknown): CommandResult {
	const { message, hint } = describeError(error);
	return errorOutput(jsonMode, message, hint);
}

/** A successful command printing `value` as indented JSON. */
export function jsonResult(value: unknown): CommandResult {
	return { exitCode: 0, output: JSON.stringify(value, null, 2) };
}

/** Runs a use case and prints its result as JSON; a thrown error becomes the failure answer. */
export function runJson(jsonMode: boolean, useCase: () => unknown): CommandResult {
	try {
		return jsonResult(useCase());
	} catch (error) {
		return failure(jsonMode, error);
	}
}

/** One task as a plain-text line: `  <id>  <title>  [<status>]`. */
export function taskLine(task: Pick<TaskSummary, 'id' | 'title' | 'status'>): string {
	return `  ${task.id}  ${task.title}  [${task.status}]`;
}
