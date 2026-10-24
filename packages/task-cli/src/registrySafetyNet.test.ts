import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { defaultRegistryDir } from '@wadeck-app/project-sdk';

/**
 * Safety net: the shared project SDK has no off switch, it reads `$XDG_CONFIG_HOME/project`, else `<home>/.config/project`.
 * vitest.setup.ts therefore points XDG_CONFIG_HOME, HOME and USERPROFILE at a temp dir for every test file, so no test
 * can read or write the real registry of the machine running the tests.
 */
function insideTemp(dir: string): boolean {
	const temp = fs.realpathSync.native(os.tmpdir()).toLowerCase();
	const real = (fs.existsSync(dir) ? fs.realpathSync.native(dir) : dir).toLowerCase();
	return path.resolve(real).startsWith(path.resolve(temp));
}

describe('shared project registry under the test setup', () => {
	it.each(['XDG_CONFIG_HOME', 'HOME', 'USERPROFILE'])('%s points inside the temp dir', name => {
		const value = process.env[name];
		expect(value, `${name} is not set by vitest.setup.ts`).toBeTruthy();
		expect(insideTemp(value!), `${name}=${value} is not under ${os.tmpdir()}`).toBe(true);
	});

	it('the default registry dir is inside the temp dir, with or without XDG_CONFIG_HOME', () => {
		expect(insideTemp(defaultRegistryDir(process.env))).toBe(true);
		expect(insideTemp(defaultRegistryDir({}, os.homedir()))).toBe(true);
	});
});
