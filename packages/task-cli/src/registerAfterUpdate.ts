import * as fs from 'node:fs';

export type AppModuleVersion = { version: string } | { absent: true } | { error: string };

export interface RegisterAfterUpdateDeps {
	/** manifest.json of the app-module inside the installed package. */
	manifestPath: string;
	/** What `readAppModuleVersion` returned BEFORE the updater ran. */
	before: AppModuleVersion;
	register: (manifestPath: string, log: (entry: { source: string; message: string }) => void) => Promise<void>;
	log: (line: string) => void;
}

/** The version of the installed app-module, "absent" when the package ships none, or why it cannot be read. */
export function readAppModuleVersion(manifestPath: string): AppModuleVersion {
	if (!fs.existsSync(manifestPath)) {
		return { absent: true };
	}
	try {
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version?: unknown };
		if (typeof manifest.version !== 'string') {
			return { error: `${manifestPath} has no "version" string` };
		}
		return { version: manifest.version };
	} catch (err) {
		// String(err): the updater bundle must not import the task runtime.
		return { error: `cannot read ${manifestPath} (${String(err)})` };
	}
}

/**
 * After `task cli update`, a running app-core still holds the previous app-module in memory (it reads the
 * manifest only when told to) and task has no daemon that would tell it at start, so the updater does it,
 * when the installed app-module actually changed. Comparing the manifest version before and after depends
 * on nothing but the files: "already up to date" and a failed or rolled-back update leave it unchanged and
 * print nothing.
 */
export async function registerAfterUpdate(deps: RegisterAfterUpdateDeps): Promise<void> {
	const after = readAppModuleVersion(deps.manifestPath);

	if ('error' in after) {
		deps.log(`app-core: not re-registering the app-module, ${after.error}. Once fixed, run: task cli register`);
		return;
	}
	if ('absent' in after) {
		if (!('absent' in deps.before)) {
			deps.log(
				`app-core: the installed package no longer ships an app-module (${deps.manifestPath}), nothing to register`
			);
		}
		return;
	}
	if ('version' in deps.before && deps.before.version === after.version) {
		return;
	}
	// The SDK messages already start with "app-core:": print them as they are.
	await deps.register(deps.manifestPath, entry => deps.log(entry.message));
}
