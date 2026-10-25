import { UpdateManager, type UpdateState } from '@wadeck-app/shared-cli';
import { isPidAlive } from '@wadeck-app/shared-updater';

import { interruptedInstallMessage } from '../updateStateWording.js';

/** shared-cli's UpdateState predates the `applying` journal: shared-updater adds the installer pid. */
export type NoticeState = UpdateState & { pid?: number };

/**
 * What to tell the user about the last background update, or undefined to stay quiet.
 * 'applying' is a journal written BEFORE `npm install -g`: with a live pid the install is running (quiet),
 * with a dead pid it was interrupted. It is never reported as an update.
 */
export function formatUpdateNotice(
	state: NoticeState | null,
	pidAlive: (pid: number | undefined) => boolean
): string | undefined {
	if (!state) return undefined;
	switch (state.status) {
		case 'success': {
			const version = state.targetVersion ?? state.newVersion;
			return version === undefined
				? '[task] Updated (installed version not recorded)'
				: `[task] Updated to v${version}`;
		}
		case 'rolled-back':
			return (
				`[task] Update to v${state.targetVersion} did not stick (${state.error ?? state.reason ?? 'self-check failed'}). ` +
				`Rolled back to v${state.previousVersion}. Run: task cli logs`
			);
		case 'failed':
			return `[task] Background update failed (${state.error ?? state.reason}). Run: task cli update`;
		case 'applying':
			return pidAlive(state.pid) ? undefined : `[task] ${interruptedInstallMessage(state)}`;
		default:
			return undefined;
	}
}

/** Tells the user what the background update run did since the last command (success, rollback, failure, interruption). */
export function printUpdateNotice(): void {
	const notice = formatUpdateNotice(new UpdateManager('@wadeck-app/task-cli').readAndClearState(), pid =>
		isPidAlive(pid)
	);
	if (notice !== undefined) process.stderr.write(notice + '\n');
}
