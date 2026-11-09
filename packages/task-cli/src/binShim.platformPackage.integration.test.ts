// The REAL generated shim (ci/templates/bin-launcher.js.tmpl rendered with the same substitution as
// generate-platform-packages.sh) run with Node in a throwaway tree (own npm prefix, unreachable registry).
//
// History: the shim used to run `npm install -g <platform package>` on EVERY command when that package was missing
// (the Go launcher inside is only used by `start`), and on macOS a launcher shipped without its exec bit made every
// command exit 1 with no output. Now: a platform package is irrelevant to every command but `start`.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

import { createIsolatedCliEnv, type IsolatedCliEnv, runIsolated } from './isolatedCliEnv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(__dirname, '..', 'ci', 'templates', 'bin-launcher.js.tmpl');
const SUPPORTED = ['win32-x64', 'darwin-arm64', 'darwin-x64'];
const HOST_KEY = `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

let iso: IsolatedCliEnv | undefined;
afterEach(() => {
	iso?.cleanup();
	iso = undefined;
});

/** `<prefix>/node_modules/@wadeck-app/task-cli/{bin/task.js, task.cjs}` with a bundle that prints a marker and its args. */
function installWrapper(e: IsolatedCliEnv, bundle: string): string {
	const wrapper = path.join(e.npmPrefix, 'node_modules', '@wadeck-app', 'task-cli');
	fs.mkdirSync(path.join(wrapper, 'bin'), { recursive: true });
	fs.writeFileSync(path.join(wrapper, 'task.cjs'), bundle);
	const shim = path.join(wrapper, 'bin', 'task.js');
	fs.writeFileSync(
		shim,
		fs.readFileSync(TEMPLATE, 'utf8').replaceAll('{{CLI_NAME}}', 'task').replaceAll('{{PKG_PREFIX}}', 'task-cli')
	);
	return shim;
}

const MARKER_BUNDLE =
	"process.stdout.write('MARKER-OUT ' + JSON.stringify(process.argv.slice(2)) + '\\n');" +
	"process.stderr.write('MARKER-ERR\\n');" +
	'process.exitCode = Number(process.env.FAKE_BUNDLE_EXIT || 0);';

it.each([['cli', 'version'], ['--version'], ['cli', 'update', '--help']])(
	'`task %s` without the platform package: the bundle output reaches stdout/stderr, no install, no platform message',
	async (...args) => {
		iso = createIsolatedCliEnv();
		const shim = installWrapper(iso, MARKER_BUNDLE);

		const result = await runIsolated(shim, args, iso);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe(`MARKER-OUT ${JSON.stringify(args)}\n`);
		expect(result.stderr).toBe('MARKER-ERR\n');
		expect(fs.readdirSync(path.join(iso.npmPrefix, 'node_modules', '@wadeck-app'))).toEqual(['task-cli']);
	}
);

it('the exit code of the bundle is the exit code of the shim', async () => {
	iso = createIsolatedCliEnv({ extra: { FAKE_BUNDLE_EXIT: '3' } });
	const shim = installWrapper(iso, MARKER_BUNDLE);

	const result = await runIsolated(shim, ['list'], iso);

	expect(result.status, result.stderr).toBe(3);
	expect(result.stdout).toContain('MARKER-OUT ["list"]');
});

it('`start` without the platform package attempts the global install (announced) or says the platform is unsupported', async () => {
	iso = createIsolatedCliEnv();
	const shim = installWrapper(iso, MARKER_BUNDLE);

	const result = await runIsolated(shim, ['start'], iso);

	expect(result.status, result.stderr).toBe(1);
	expect(result.stdout).not.toContain('MARKER-OUT');
	if (SUPPORTED.includes(`${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`)) {
		expect(result.stderr).toContain('platform package @wadeck-app/task-cli-');
		expect(result.stderr).toContain('missing -- installing...');
		// The registry is unreachable in the isolated tree: npm's own error is relayed, then the shim's verdict and fix.
		expect(result.stderr).toContain('ECONNREFUSED');
		expect(result.stderr).toMatch(/task: install of @wadeck-app\/task-cli-\S+ failed \(exit 1\)/);
		expect(result.stderr).toMatch(/fix: npm install -g @wadeck-app\/task-cli-/);
		// Nothing was installed anywhere but the throwaway prefix.
		expect(fs.existsSync(path.join(iso.npmPrefix, 'node_modules', '@wadeck-app', 'task-cli-win32-x64'))).toBe(
			false
		);
	} else {
		expect(result.stderr).toContain(`there is none for ${process.platform}-`);
	}
});

it.skipIf(!SUPPORTED.includes(HOST_KEY))(
	'`start` with a launcher that cannot run: the failure is printed with the path, never silent',
	async () => {
		iso = createIsolatedCliEnv();
		const shim = installWrapper(iso, MARKER_BUNDLE);
		const key = HOST_KEY;
		// A text file as launcher: win32 -> not a valid executable; darwin -> exec bit set by the shim then ENOEXEC / exit.
		const file = process.platform === 'win32' ? 'task.exe' : 'task';
		const dir = path.join(iso.npmPrefix, 'node_modules', '@wadeck-app', `task-cli-${key}`);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, file), 'this is not a binary');
		fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","version":"0.0.0"}');

		const result = await runIsolated(shim, ['start'], iso);

		expect(result.status, result.stderr).not.toBe(0);
		expect(result.stderr).toContain('task: cannot run the launcher');
		expect(result.stderr).toContain(path.join(dir, file));
	}
);
