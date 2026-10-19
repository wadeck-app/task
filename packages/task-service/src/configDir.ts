import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The task config dir (projects.json, logs/): $XDG_CONFIG_HOME/task, else ~/.config/task. Same convention as
 * @wadeck-app/shared-cli's ConfigDir.get('task') (task-cli has a test that keeps the two equal), restated here so
 * that task-service and the app-module need no CLI library for a path. Like shared-cli, it honours no
 * TASK_CONFIG_DIR override.
 */
export function getTaskConfigDir(): string {
	const xdg = process.env['XDG_CONFIG_HOME'];
	return xdg ? join(xdg, 'task') : join(homedir(), '.config', 'task');
}

/** The folder of the task log (`YYYY-MM-DD.ndjson`: CLI invocations, undelivered events, server errors) inside a config dir. */
export function getTaskLogDir(configDir: string = getTaskConfigDir()): string {
	return join(configDir, 'logs');
}
