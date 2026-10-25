// Dev build guard. Imported by BOTH bundle entry points (task.cjs and task-updater.cjs): keep it free of
// task runtime imports.
//
// A release is stamped by CI (ci/scripts/compute-version.sh) as YYYY.MM.DD-BBB-xxxxxxxx: zero-padded build
// number (3+ digits) and an 8-char lowercase hex commit hash. Anything else (0.0.0-local, 0.0.0-test-integration,
// the local fallback YYYY.MM.DD-HHMMSS-count-HASH of version.ts) is a repo-built dev bundle. Strict on purpose:
// a false "release" lets a dev build run `npm install -g`, a false "dev" only makes an update refuse loudly.
// Incident 2026-10-24: a repo-built bundle updated the real global install, the install was killed halfway and
// the global CLI vanished.
const CALVER_RE = /^\d{4}\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])-\d{3,}-[0-9a-f]{8}$/;

export function isCalVer(version: string | undefined | null): boolean {
	return typeof version === 'string' && CALVER_RE.test(version);
}

/** The one line printed (explicit update) or logged (background) when a dev build is asked to update. */
export function devBuildRefusal(version: string): string {
	return (
		`dev build ${version}: not updating the global task-cli (repo-built bundle, not a CalVer release). ` +
		'Use the installed binary instead: task cli update'
	);
}

/**
 * Background scheduling after a command. A dev build never starts the updater (it would only refuse itself, and
 * on a machine where the guard in task-updater.cjs is stale, it would touch the global install): it logs the
 * refusal line instead. `log` must never break the command that just ran.
 */
export function scheduleUpdaterUnlessDevBuild(
	version: string,
	schedule: () => void,
	log: (line: string) => void
): void {
	if (isCalVer(version)) {
		schedule();
		return;
	}
	try {
		log(devBuildRefusal(version));
	} catch (error) {
		process.stderr.write(
			`[task] could not log the dev build refusal: ${error instanceof Error ? error.message : String(error)}\n`
		);
	}
}
