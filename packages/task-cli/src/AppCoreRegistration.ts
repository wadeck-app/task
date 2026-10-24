import { describeRegistration, registerModule, unregisterModule } from '@wadeck-app/app-core-sdk/register';
import type { RegistrationOutcome, UnregistrationOutcome } from '@wadeck-app/app-core-sdk/register';
import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { isPackagedInstall, pruneStagedModules, stageAppModule } from './appModuleStaging.js';
import type { StagedModule } from './appModuleStaging.js';

/** The module id app-core knows the task module by: the prefix of its components and routes. Must equal the id in app-module-task's manifest.json. */
export const APP_CORE_MODULE_ID = 'task';

export interface AppCoreAttempt {
	/** False when app-core refused or the call itself failed: the caller must fix something. App-core being absent is ok. */
	ok: boolean;
	/** An outcome status of the SDK (`unconfirmed` = ok, but app-core did not confirm: see {@link describeOutcome}), or `failed` when the SDK rejected. */
	status: string;
	/** One line, ready to print. */
	message: string;
}

type LogDiagnostic = (entry: { source: string; message: string }) => void;

const SOURCE = 'AppCoreRegistration';

/**
 * The SDK wording of an outcome. `unconfirmed` (app-core reachable, no answer in time: it may have applied the call) is
 * neither a failure nor a confirmation, so it gets the exact command that settles it, next to the SDK's own advice.
 */
function describeOutcome(outcome: RegistrationOutcome | UnregistrationOutcome): string {
	const text = describeRegistration(outcome, APP_CORE_MODULE_ID);
	if (outcome.status !== 'unconfirmed') return text;
	const command = 'action' in outcome ? 'task cli unregister' : 'task cli register';
	return `${text} To settle it, wait a few seconds and run: ${command}`;
}

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
			message: describeOutcome(outcome),
		};
	} catch (err) {
		return {
			ok: false,
			status: 'failed',
			message: `app-core: registration failed: ${errorMessage(err)}. Fix it, then run: task cli register`,
		};
	}
}

/**
 * Registers the module the way every caller must: an installed package's app-module is first copied into the task
 * config dir (see {@link stageAppModule}) and the STAGED manifest is registered, so that what app-core remembers
 * survives npm replacing or removing the package. Older staged copies go only once app-core holds the new path
 * (`registered`, or `deferred` = left as the file it reads at its next start); any other outcome (refused, skipped,
 * an unknown status of a newer SDK) keeps them, since app-core may still use the previous one.
 * A source checkout's manifest is registered as it is. Never throws.
 */
export async function attemptStagedRegistration(
	manifestPath: string,
	configDir: string = ConfigDir.get('task')
): Promise<AppCoreAttempt> {
	if (!isPackagedInstall(manifestPath)) {
		return attemptRegistration(manifestPath);
	}
	let staged: StagedModule;
	try {
		staged = stageAppModule(manifestPath, configDir);
	} catch (err) {
		return {
			ok: false,
			status: 'failed',
			message: `app-core: registration failed: ${errorMessage(err)}`,
		};
	}
	const attempt = await attemptRegistration(staged.manifestPath);
	if (attempt.status === 'registered' || attempt.status === 'deferred') {
		pruneStagedModules(configDir, staged.stamp);
	}
	return attempt;
}

/** Removes the module from app-core. Same rules as attemptRegistration; an id app-core never knew is ok. */
export async function attemptUnregistration(): Promise<AppCoreAttempt> {
	try {
		const outcome = await unregisterModule({ id: APP_CORE_MODULE_ID });
		return {
			ok: outcome.status !== 'refused',
			status: outcome.status,
			message: describeOutcome(outcome),
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
	const attempt = await attemptStagedRegistration(manifestPath);
	logDiagnostic({ source: SOURCE, message: attempt.message });
}
