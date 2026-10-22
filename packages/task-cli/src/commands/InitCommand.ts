// task init: thin adapter over the task-service `initProject` (creates .task/ and registers the project for the app-module).
import { ConfigDir } from '@wadeck-app/shared-cli';
import { initProject } from '@wadeck-app/task-service';

import type { CommandResult } from '../cli/output.js';

export function runInit(projectDir: string): CommandResult {
	const { taskDir, created, registration } = initProject(projectDir, ConfigDir.get('task'));
	// Never fails the command: the project is initialized either way, so a registry problem is only a warning with its fix.
	if (!registration.ok) {
		process.stderr.write(
			`[task] warning: could not register this project for the task app-module: ${registration.message}${registration.hint ? ` (${registration.hint})` : ''}\n`
		);
	}
	return {
		exitCode: 0,
		output: created ? `Initialized task project in ${taskDir}` : 'Project already initialized.',
	};
}
