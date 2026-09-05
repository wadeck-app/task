// task-updater entry point -- bundled separately as task-updater.cjs.
// Must NOT import any task runtime modules.
import { runUpdater, execNpm } from '@wadeck-app/shared-updater';
import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { join } from 'node:path';

declare const __TASK_CLI_VERSION__: string;

const PKG_NAME = '@wadeck-app/task-cli';
const configDir = process.env['TASK_CONFIG_DIR'] ?? ConfigDir.get('task');
const currentVersion = typeof __TASK_CLI_VERSION__ !== 'undefined' ? __TASK_CLI_VERSION__ : '0.0.0-dev';

try {
	const npmRoot = execNpm(['root', '-g'], { timeout: 10_000 }).trim();
	const selfCheckCmd = `${process.execPath} ${join(npmRoot, PKG_NAME, 'task.cjs')} cli self-check`;
	if (!process.env['UPDATER_SELF_CHECK_CMD']) {
		process.env['UPDATER_SELF_CHECK_CMD'] = selfCheckCmd;
	}
} catch {
	// Skip self-check if npm root unavailable.
}

runUpdater({
	pkgName: PKG_NAME,
	configDir,
	currentVersion,
	strategy: 'without-daemon',
	onUpdateAvailable: async (_newVersion: string) => 'apply-now' as const,
}).catch(err => {
	process.stderr.write(`[task-updater] fatal: ${err}\n`);
	process.exit(1);
});
