// task cli <subcommand>: the CLI's own maintenance commands (not about tasks).
import { ConfigDir } from '@wadeck-app/shared-cli';
import { createQueueEventSink, getTaskLogDir } from '@wadeck-app/task-service';

import { errorOutput } from '../cli/output.js';
import { runDeclareEvents } from '../QueueEventsDeclaration.js';
import { VERSION } from '../version.js';
import type { CommandResult } from '../cli/output.js';
import { runAppCoreCommand } from './AppCoreCommand.js';
import {
	printTaskCliHelp,
	runTaskCliLogs,
	runTaskCliRollback,
	runTaskCliSelfCheck,
	runTaskCliUpdate,
	runTaskCliVersion,
} from './TaskCliCommand.js';

const DONE: CommandResult = { exitCode: 0, output: '' };

/** Dispatches `task cli <rest[0]>`; the sub-command prints its own output, except register/unregister. */
export async function runCliSubcommand(rest: string[], jsonMode: boolean): Promise<CommandResult> {
	const subCmd = rest[0];
	switch (subCmd) {
		case 'version':
			await runTaskCliVersion();
			return DONE;
		case 'update':
			await runTaskCliUpdate({ check: rest.includes('--check'), log: rest.includes('--log'), rawArgs: rest });
			return DONE;
		case 'rollback':
			await runTaskCliRollback();
			return DONE;
		case 'self-check':
			await runTaskCliSelfCheck();
			return DONE;
		case 'register':
		case 'unregister':
			return runAppCoreCommand(subCmd, jsonMode);
		case 'logs':
			await runTaskCliLogs({ follow: rest.includes('--follow') });
			return DONE;
		case 'declare-events': {
			const configDir = ConfigDir.get('task');
			const sink = createQueueEventSink({ getLogDir: () => getTaskLogDir(configDir) });
			try {
				return await runDeclareEvents(sink, jsonMode, { configDir, taskVersion: VERSION });
			} finally {
				// The process exits right after: let the SDK settle the declaration first.
				await sink.flush();
			}
		}
		case undefined:
		case '--help':
		case 'help':
			printTaskCliHelp();
			return DONE;
		// violations-suppress: ts/no-switch-default-break returns a user-facing error, not a silent fallback
		default:
			return errorOutput(
				jsonMode,
				`unknown task cli subcommand: ${subCmd}`,
				'Valid subcommands: version, update, rollback, self-check, logs, register, unregister, declare-events, migrate-data'
			);
	}
}
