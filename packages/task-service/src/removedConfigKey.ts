// Config keys task used to read and no longer does. A key that silently does nothing would let a user believe task runs
// something, so each one is an error naming the FILE and the key, with the fix.
import { ConfigSchemaError } from '@wadeck-app/project-sdk';

/** Why `hooks` is gone and what replaces it: the fix shown to a user who still has the key. */
export const HOOKS_REMOVED_HINT =
	"task does not run commands from the config. React to task events with queue subscribers: see CLAUDE.md 'Queue events' (`<project>/.queue/subscribers.yml`, `when:` filters).";

/** A `config.yml` (global or a project layer) holds a key that is no longer valid. A ConfigSchemaError (`invalid`, 400); `hint` is the fix. */
export class RemovedConfigKeyError extends ConfigSchemaError {
	constructor(
		file: string,
		key: string,
		problem: string,
		readonly hint: string
	) {
		super(`${file}: ${key}: ${problem}`, { layer: file, key, path: key });
		this.name = 'RemovedConfigKeyError';
	}
}

/** Throws when the config file `file` (already parsed into `values`) still has the `hooks` key. */
export function assertNoHooks(file: string, values: Record<string, unknown>): void {
	if (values['hooks'] !== undefined) {
		throw new RemovedConfigKeyError(
			file,
			'hooks',
			'not supported, remove it (task never runs commands from the config)',
			HOOKS_REMOVED_HINT
		);
	}
}
