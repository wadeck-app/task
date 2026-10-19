// task cli register | unregister -- tell app-core where the task app-module lives, or remove it.
import { attemptRegistration, attemptUnregistration, type AppCoreAttempt } from '../AppCoreRegistration.js';
import { resolveAppModuleManifest } from '../appModuleManifest.js';
import type { CommandResult } from '../cli/output.js';

export interface AppCoreCommandDeps {
	resolveManifest: () => string;
	register: (manifestPath: string) => Promise<AppCoreAttempt>;
	unregister: () => Promise<AppCoreAttempt>;
}

const defaultDeps: AppCoreCommandDeps = {
	resolveManifest: () => resolveAppModuleManifest(),
	register: attemptRegistration,
	unregister: attemptUnregistration,
};

function failure(jsonMode: boolean, message: string, status?: string): CommandResult {
	if (jsonMode) {
		return {
			exitCode: 1,
			output: JSON.stringify(status === undefined ? { error: message } : { error: message, status }),
		};
	}
	return { exitCode: 1, output: `Error: ${message}` };
}

/**
 * Exit 0 when app-core took it, or is absent / not running (deferred, skipped: nothing to fix, said
 * clearly). Exit 1 with the reason when app-core refuses, the call fails or the manifest cannot be found.
 */
export async function runAppCoreCommand(
	action: 'register' | 'unregister',
	jsonMode: boolean,
	deps: AppCoreCommandDeps = defaultDeps
): Promise<CommandResult> {
	let attempt: AppCoreAttempt;
	if (action === 'register') {
		let manifestPath: string;
		try {
			manifestPath = deps.resolveManifest();
		} catch (error) {
			return failure(jsonMode, (error as Error).message);
		}
		attempt = await deps.register(manifestPath);
	} else {
		attempt = await deps.unregister();
	}

	if (!attempt.ok) {
		return failure(jsonMode, attempt.message, attempt.status);
	}
	if (jsonMode) {
		return { exitCode: 0, output: JSON.stringify({ ok: true, status: attempt.status, message: attempt.message }) };
	}
	return { exitCode: 0, output: attempt.message };
}
