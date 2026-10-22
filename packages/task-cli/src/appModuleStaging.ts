import * as fs from 'node:fs';
import * as path from 'node:path';
import { readAppModuleVersion } from './registerAfterUpdate.js';

// Imported by the updater bundle (500 KB guard): fs and path only, nothing of the task runtime.

/** A stamp is a folder name chosen by us (the module version), never a path. */
const STAMP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Where the staged copies live: `<task config dir>/app-module/<version>/`. */
export function stagedModulesRoot(configDir: string): string {
	return path.join(configDir, 'app-module');
}

/**
 * The manifest sits in `<package>/app-module/`: the copy npm installed, which must be staged. A source checkout's
 * `dist-module/` is not (a rebuild keeps the version, so a staged copy would go stale), nor is a staged copy itself
 * (`app-module/<version>/`).
 */
export function isPackagedInstall(manifestPath: string): boolean {
	return path.basename(path.dirname(manifestPath)) === 'app-module';
}

export interface StagedModule {
	/** The manifest to register. */
	manifestPath: string;
	/** The folder name of this copy: the module version. */
	stamp: string;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Copies the module that holds `sourceManifestPath` out of the npm folder into `<configDir>/app-module/<version>/`
 * and returns the manifest to register.
 *
 * app-core stores the PATH of a manifest and reloads from it at its own every start. npm replaces the package folder
 * on every update and deletes it on uninstall, so a path into node_modules dies, and app-core would report a module
 * that cannot load. The copy lives in the config dir, which belongs to the user and not to npm.
 *
 * Once per version: a complete copy is kept. Written beside the target and renamed, so a crash cannot leave a
 * half-copied folder at the path app-core would load from. Throws, naming source and destination, when it cannot.
 */
export function stageAppModule(sourceManifestPath: string, configDir: string): StagedModule {
	const version = readAppModuleVersion(sourceManifestPath);
	if ('absent' in version) {
		throw new Error(
			`Cannot stage the app-module: ${sourceManifestPath} does not exist. Reinstall with: task cli update`
		);
	}
	if ('error' in version) {
		throw new Error(`Cannot stage the app-module: ${version.error}. Reinstall with: task cli update`);
	}
	const stamp = version.version;
	if (!STAMP_RE.test(stamp)) {
		throw new Error(
			`Cannot stage the app-module: "${stamp}" (version in ${sourceManifestPath}) is not a usable version stamp (letters, digits, ".", "_" and "-" only, starting with a letter or digit).`
		);
	}
	const sourceDir = path.dirname(sourceManifestPath);
	const target = path.join(stagedModulesRoot(configDir), stamp);
	const manifestPath = path.join(target, 'manifest.json');
	if (fs.existsSync(manifestPath)) {
		return { manifestPath, stamp };
	}
	const partial = `${target}.partial-${process.pid}`;
	try {
		fs.rmSync(partial, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.cpSync(sourceDir, partial, { recursive: true });
		// An incomplete target (no manifest) is debris of an older crash.
		fs.rmSync(target, { recursive: true, force: true });
		fs.renameSync(partial, target);
	} catch (err) {
		fs.rmSync(partial, { recursive: true, force: true });
		// A concurrent run may have finished the same copy first: that one is as good as ours.
		if (fs.existsSync(manifestPath)) {
			return { manifestPath, stamp };
		}
		throw new Error(
			`Cannot stage the app-module from ${sourceDir} into ${target} (${errorText(err)}). It is copied out of the npm folder on purpose, so that updating or removing the package cannot break what app-core remembers. Check that the destination is writable, then run: task cli register`
		);
	}
	return { manifestPath, stamp };
}

/**
 * Removes the staged copies of every version but `keepStamp`, and returns how many went. A failure to remove one is
 * skipped: the next registration tries again, and a leftover copy costs disk, not correctness.
 */
export function pruneStagedModules(configDir: string, keepStamp: string): number {
	const root = stagedModulesRoot(configDir);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return 0;
	}
	let removed = 0;
	for (const entry of entries) {
		if (entry.name === keepStamp) {
			continue;
		}
		try {
			fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
			removed++;
		} catch {
			// Still in use or locked: left for the next registration.
		}
	}
	return removed;
}
