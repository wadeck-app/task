import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * `~/.task` is task's own global config dir (TaskConfigLoader: defaults, hooks), not a legacy location of the
 * `~/.config/task` log/updater dir. shared-cli's `ConfigDir.migrateIfNeeded('task')` renames `~/.<app>` to the
 * XDG dir when the latter is missing, which would carry the global config away: loading the CLI must not do it.
 */
describe('loading the CLI module leaves the global config dir alone', () => {
	const saved = {
		xdg: process.env['XDG_CONFIG_HOME'],
		home: process.env['HOME'],
		profile: process.env['USERPROFILE'],
	};
	let sandbox: string;

	beforeEach(() => {
		sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-globalconfig-'));
		fs.mkdirSync(path.join(sandbox, '.task'));
		fs.writeFileSync(path.join(sandbox, '.task', 'config.yml'), 'defaults:\n  priority: medium\n');
		// No <xdg>/task: the state in which the migration acts.
		process.env['XDG_CONFIG_HOME'] = path.join(sandbox, 'xdg');
		process.env['HOME'] = sandbox;
		process.env['USERPROFILE'] = sandbox;
		vi.resetModules();
	});

	afterEach(() => {
		for (const [key, value] of [
			['XDG_CONFIG_HOME', saved.xdg],
			['HOME', saved.home],
			['USERPROFILE', saved.profile],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(sandbox, { recursive: true, force: true });
	});

	it('keeps ~/.task/config.yml where TaskConfigLoader reads it', async () => {
		await import('./TaskCliCommand.js');

		expect(fs.existsSync(path.join(sandbox, '.task', 'config.yml'))).toBe(true);
		expect(fs.existsSync(path.join(sandbox, 'xdg', 'task'))).toBe(false);
	});
});
