// Wording shared by task.cjs and task-updater.cjs for an `applying` update state. Type-only imports: no runtime.
import type { UpdateState } from '@wadeck-app/shared-cli';

/**
 * `applying` is written by shared-updater BEFORE `npm install -g`. A dead (or missing) pid means the install was
 * interrupted, not that one is running; the next updater run verifies the install and repairs it.
 */
export function interruptedInstallMessage(state: Pick<UpdateState, 'targetVersion' | 'previousVersion'>): string {
	const target = state.targetVersion === undefined ? 'a new version' : `v${state.targetVersion}`;
	const previous = state.previousVersion === undefined ? '' : ` (from v${state.previousVersion})`;
	return (
		`A previous update to ${target}${previous} was interrupted: the installer process is gone. ` +
		'The next background update run repairs the installation by itself; to repair now run: task cli update'
	);
}
