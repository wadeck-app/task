import { UpdateManager } from '@wadeck-app/shared-cli';

/** Tells the user what the background update run did since the last command (success, rollback, failure). */
export function printUpdateNotice(): void {
	const updateState = new UpdateManager('@wadeck-app/task-cli').readAndClearState();
	if (updateState?.status === 'success') {
		process.stderr.write(`[task] Updated to v${updateState.targetVersion ?? updateState.newVersion}\n`);
	}
	if (updateState?.status === 'rolled-back') {
		process.stderr.write(
			`[task] Update to v${updateState.targetVersion} failed (self-check failed). Rolled back to v${updateState.previousVersion}. Run: task cli update --log\n`
		);
	}
	if (updateState?.status === 'failed') {
		process.stderr.write(
			`[task] Background update failed (${updateState.error ?? updateState.reason}). Run: task cli update\n`
		);
	}
}
