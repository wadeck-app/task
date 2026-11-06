// Facts about the bin shim (ci/templates/bin-launcher.js.tmpl) when the platform package that holds the Go launcher is
// missing, measured in a throwaway tree (own npm prefix, unreachable registry): the shim runs `npm install -g` for it on
// EVERY command, even `--version`, although on Windows only `start` uses the launcher. Pinned so a change is deliberate.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

import { createIsolatedCliEnv, type IsolatedCliEnv, runIsolated } from './isolatedCliEnv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(__dirname, '..', 'ci', 'templates', 'bin-launcher.js.tmpl');
const SUPPORTED = ['win32-x64', 'darwin-arm64', 'darwin-x64'];

let iso: IsolatedCliEnv | undefined;
afterEach(() => {
	iso?.cleanup();
	iso = undefined;
});

it('without the platform package the shim attempts a global install (supported platforms) or says the platform is unsupported', async () => {
	iso = createIsolatedCliEnv();
	const wrapper = path.join(iso.npmPrefix, 'node_modules', '@wadeck-app', 'task-cli');
	fs.mkdirSync(path.join(wrapper, 'bin'), { recursive: true });
	fs.writeFileSync(path.join(wrapper, 'task.cjs'), "process.stdout.write('bundle ran\\n');");
	const shim = path.join(wrapper, 'bin', 'task.js');
	fs.writeFileSync(
		shim,
		fs.readFileSync(TEMPLATE, 'utf8').replaceAll('{{CLI_NAME}}', 'task').replaceAll('{{PKG_PREFIX}}', 'task-cli')
	);

	const result = await runIsolated(shim, ['--version'], iso);

	expect(result.status, result.stderr).toBe(1);
	expect(result.stdout).toBe('');
	if (SUPPORTED.includes(`${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`)) {
		expect(result.stderr).toContain('platform package @wadeck-app/task-cli-');
		expect(result.stderr).toContain('missing -- installing...');
		// The registry is unreachable in the isolated tree: npm's own error is relayed, then the shim's verdict.
		expect(result.stderr).toContain('ECONNREFUSED');
		expect(result.stderr).toContain('task: install failed (exit 1)');
		// Nothing was installed anywhere but the throwaway prefix.
		expect(fs.existsSync(path.join(iso.npmPrefix, 'node_modules', '@wadeck-app', 'task-cli-win32-x64'))).toBe(
			false
		);
	} else {
		expect(result.stderr).toContain(`unsupported platform ${process.platform}-`);
	}
});
