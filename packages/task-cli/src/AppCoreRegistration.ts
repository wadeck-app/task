import { describeRegistration, registerModule, unregisterModule } from '@wadeck-app/app-core-sdk/register';

/** The module id app-core knows the task module by: the prefix of its components and routes. Must equal the id in app-module-task's manifest.json. */
export const APP_CORE_MODULE_ID = 'task';

export interface AppCoreAttempt {
	/** False when app-core refused or the call itself failed: the caller must fix something. App-core being absent is ok. */
	ok: boolean;
	/** An outcome status of the SDK, or `failed` when the SDK rejected. */
	status: string;
	/** One line, ready to print. */
	message: string;
}

type LogDiagnostic = (entry: { source: string; message: string }) => void;

const SOURCE = 'AppCoreRegistration';

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Tells a running app-core where the app-module lives (POST /api/modules/register, which also reloads a
 * module it already knows: same call for a first registration and for an update). App-core being absent is
 * a normal state (`deferred` / `skipped`), not a failure; a refusal and a rejection of the SDK are not ok.
 * Never throws.
 */
export async function attemptRegistration(manifestPath: string): Promise<AppCoreAttempt> {
	try {
		const outcome = await registerModule({ id: APP_CORE_MODULE_ID, manifestPath });
		return {
			ok: outcome.status !== 'refused',
			status: outcome.status,
			message: describeRegistration(outcome, APP_CORE_MODULE_ID),
		};
	} catch (err) {
		return {
			ok: false,
			status: 'failed',
			message: `app-core: registration failed: ${errorMessage(err)}. Fix it, then run: task cli register`,
		};
	}
}

/** Removes the module from app-core. Same rules as attemptRegistration; an id app-core never knew is ok. */
export async function attemptUnregistration(): Promise<AppCoreAttempt> {
	try {
		const outcome = await unregisterModule({ id: APP_CORE_MODULE_ID });
		return {
			ok: outcome.status !== 'refused',
			status: outcome.status,
			message: describeRegistration(outcome, APP_CORE_MODULE_ID),
		};
	} catch (err) {
		return {
			ok: false,
			status: 'failed',
			message: `app-core: unregistration failed: ${errorMessage(err)}. Fix it, then run: task cli unregister`,
		};
	}
}

/** Best-effort registration for callers that must not break on it (the updater): logs every answer, never throws. */
export async function registerWithAppCore(manifestPath: string, logDiagnostic: LogDiagnostic): Promise<void> {
	const attempt = await attemptRegistration(manifestPath);
	logDiagnostic({ source: SOURCE, message: attempt.message });
}
