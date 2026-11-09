// The `task` command on PATH is the shim generated from ci/templates/bin-launcher.js.tmpl (package @wadeck-app/task-cli,
// bin/task.js). It runs task.cjs, which sits next to bin/. When task.cjs is missing (incomplete install) the user used to
// get a raw Node stack trace ("Cannot find module ... MODULE_NOT_FOUND ... Node.js v24"), or on macOS the Go launcher's
// "LAUNCHER_BUNDLE_OVERRIDE points at ..., which is not a file": neither says what to do.
//
// The shim is rendered into a throwaway tree exactly as ci/scripts/generate-platform-packages.sh does (sed on the two
// placeholders) and run through runIsolated(): own HOME / config dir / npm prefix, unreachable registry.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createIsolatedCliEnv, type IsolatedCliEnv, runIsolated } from './isolatedCliEnv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(__dirname, '..', 'ci', 'templates', 'bin-launcher.js.tmpl');
// The shim refuses unsupported hosts (Intel Macs, linux...) before it looks at the bundle; those hosts are covered in
// binShim.platformPackage.integration.test.ts and binShim.unit.test.ts.
const HOST_SUPPORTED = ['win32-x64', 'darwin-arm64'].includes(`${process.platform}-${process.arch}`);

let iso: IsolatedCliEnv | undefined;
afterEach(() => {
	iso?.cleanup();
	iso = undefined;
});

/** `<prefix>/node_modules/@wadeck-app/task-cli/{bin/task.js, task.cjs?}`; returns both paths. */
function installWrapper(e: IsolatedCliEnv, opts: { bundle: string | undefined }): { shim: string; bundle: string } {
	const wrapper = path.join(e.npmPrefix, 'node_modules', '@wadeck-app', 'task-cli');
	fs.mkdirSync(path.join(wrapper, 'bin'), { recursive: true });
	const shim = path.join(wrapper, 'bin', 'task.js');
	fs.writeFileSync(
		shim,
		fs.readFileSync(TEMPLATE, 'utf8').replaceAll('{{CLI_NAME}}', 'task').replaceAll('{{PKG_PREFIX}}', 'task-cli')
	);
	const bundle = path.join(wrapper, 'task.cjs');
	if (opts.bundle !== undefined) fs.writeFileSync(bundle, opts.bundle);
	return { shim, bundle };
}

describe.skipIf(!HOST_SUPPORTED)('bin shim when the CLI bundle (task.cjs) is missing', () => {
	it.each([['--version'], ['list'], ['cli', 'version']])(
		'`task %s...` names the missing file, says the install is incomplete and gives the reinstall command',
		async (...args) => {
			iso = createIsolatedCliEnv();
			const { shim, bundle } = installWrapper(iso, { bundle: undefined });

			const result = await runIsolated(shim, args, iso);

			expect(result.status, result.stderr).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain(bundle);
			expect(result.stderr).toContain('incomplete');
			expect(result.stderr).toContain('npm install -g @wadeck-app/task-cli');
			// Not Node's own failure, and the shim did not go looking for (or installing) a platform package first.
			expect(result.stderr).not.toContain('MODULE_NOT_FOUND');
			expect(result.stderr).not.toContain('Node.js v');
			expect(result.stderr).not.toContain('platform package');
			expect(result.stderr).not.toContain('unsupported platform');
		}
	);

	it('does not get in the way when the bundle is there (control: the bundle runs)', async () => {
		iso = createIsolatedCliEnv();
		const { shim } = installWrapper(iso, { bundle: "process.stdout.write('bundle ran\\n');" });
		// No platform package and no launcher anywhere: every command but `start` runs the bundle with node, on every platform.

		const result = await runIsolated(shim, ['--version'], iso);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain('bundle ran');
	});
});
