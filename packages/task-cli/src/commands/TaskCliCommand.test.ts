import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	getCurrentTaskVersion,
	runTaskCliRollback,
	runTaskCliSelfCheck,
	runTaskCliUpdate,
	runTaskCliVersion,
} from './TaskCliCommand.js';

vi.mock('node:fs', async () => {
	const real = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...real,
		existsSync: vi.fn().mockImplementation(real.existsSync),
		readFileSync: vi.fn().mockImplementation(real.readFileSync),
		unlinkSync: vi.fn().mockImplementation(real.unlinkSync),
	};
});

const sdk = vi.hoisted(() => ({
	registerModule: vi.fn(),
	unregisterModule: vi.fn(),
	describeRegistration: vi.fn(),
}));
vi.mock('@wadeck-app/app-core-sdk/register', () => sdk);

vi.mock('@wadeck-app/shared-cli/CliMetaCommands', () => ({
	cliVersionCommand: vi.fn().mockResolvedValue(undefined),
	cliUpdateCommand: vi.fn().mockResolvedValue(undefined),
	cliRollbackCommand: vi.fn().mockResolvedValue(undefined),
	cliLogsCommand: vi.fn().mockResolvedValue(undefined),
	warnUnknownArgs: vi.fn(),
}));

vi.mock('@wadeck-app/shared-cli/ChannelConfig', () => ({
	readChannelFromConfig: vi.fn().mockReturnValue('latest'),
}));

describe('runTaskCliSelfCheck', () => {
	let exitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
		vi.mocked(fs.existsSync).mockImplementation(realFs.existsSync);
		vi.mocked(fs.readFileSync).mockImplementation(realFs.readFileSync);
		vi.mocked(fs.unlinkSync).mockImplementation(realFs.unlinkSync);

		exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
			throw new Error(`process.exit(${_code})`);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		}) as any;
	});

	afterEach(() => {
		delete process.env['CLI_SELF_CHECK_QUIET'];
		vi.restoreAllMocks();
	});

	it('runs all checks without throwing when all pass', async () => {
		await expect(runTaskCliSelfCheck()).resolves.toBeUndefined();
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('suppresses stderr output when CLI_SELF_CHECK_QUIET=1', async () => {
		process.env['CLI_SELF_CHECK_QUIET'] = '1';
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

		await runTaskCliSelfCheck();

		expect(stderrSpy).not.toHaveBeenCalled();
		expect(exitSpy).not.toHaveBeenCalled();
	});
});

describe('runTaskCliRollback', () => {
	let written: string[];
	let sandbox: string;
	let savedXdg: string | undefined;
	let pkgManifest: string;

	beforeEach(async () => {
		const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
		vi.mocked(fs.existsSync).mockImplementation(realFs.existsSync);
		vi.mocked(fs.readFileSync).mockImplementation(realFs.readFileSync);
		// The restored package: an installed app-module, copied (staged) before it is registered.
		sandbox = realFs.mkdtempSync(path.join(os.tmpdir(), 'task-rollback-'));
		savedXdg = process.env['XDG_CONFIG_HOME'];
		process.env['XDG_CONFIG_HOME'] = path.join(sandbox, 'xdg');
		realFs.mkdirSync(path.join(sandbox, 'pkg', 'app-module'), { recursive: true });
		pkgManifest = path.join(sandbox, 'pkg', 'app-module', 'manifest.json');
		realFs.writeFileSync(pkgManifest, JSON.stringify({ version: '1.2.3' }));
		written = [];
		vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
			written.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
			written.push(String(chunk));
			return true;
		});
		sdk.describeRegistration.mockImplementation(
			(outcome: { status: string }) => `app-core: described ${outcome.status}`
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (savedXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
		else process.env['XDG_CONFIG_HOME'] = savedXdg;
		fs.rmSync(sandbox, { recursive: true, force: true });
	});

	it('delegates to cliRollbackCommand', async () => {
		const { cliRollbackCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		sdk.registerModule.mockResolvedValue({ status: 'skipped' });
		await runTaskCliRollback({ resolveManifest: () => pkgManifest });
		expect(cliRollbackCommand).toHaveBeenCalledWith('@wadeck-app/task-cli', expect.any(String));
	});

	it('tells app-core about the restored app-module once the files are back, and prints the answer', async () => {
		const { cliRollbackCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		const order: string[] = [];
		vi.mocked(cliRollbackCommand).mockImplementation(() => {
			order.push('rollback');
			return Promise.resolve();
		});
		sdk.registerModule.mockImplementation(() => {
			order.push('register');
			return Promise.resolve({ status: 'registered' });
		});

		await runTaskCliRollback({ resolveManifest: () => pkgManifest });

		expect(order).toEqual(['rollback', 'register']);
		// The copy in the config dir is registered, not the npm folder (which the next update replaces).
		expect(sdk.registerModule).toHaveBeenCalledWith({
			id: 'task',
			manifestPath: path.join(sandbox, 'xdg', 'task', 'app-module', '1.2.3', 'manifest.json'),
		});
		expect(written.join('')).toContain('app-core: described registered');
	});

	it('does not touch app-core when the rollback itself fails (shared-cli exits or throws)', async () => {
		const { cliRollbackCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		vi.mocked(cliRollbackCommand).mockRejectedValue(new Error('npm install failed'));

		await expect(runTaskCliRollback({ resolveManifest: () => pkgManifest })).rejects.toThrow('npm install failed');

		expect(sdk.registerModule).not.toHaveBeenCalled();
	});

	it('never fails the rollback when app-core refuses: the message says how to retry', async () => {
		sdk.registerModule.mockResolvedValue({ status: 'refused' });
		sdk.describeRegistration.mockReturnValue('app-core: refused the module (bad manifest)');

		await expect(runTaskCliRollback({ resolveManifest: () => pkgManifest })).resolves.toBeUndefined();

		expect(written.join('')).toContain('app-core: refused the module (bad manifest)');
		expect(written.join('')).toContain('task cli register');
	});

	it('never fails the rollback when the SDK rejects', async () => {
		sdk.registerModule.mockRejectedValue(new Error('socket hang up'));

		await expect(runTaskCliRollback({ resolveManifest: () => pkgManifest })).resolves.toBeUndefined();

		expect(written.join('')).toContain('socket hang up');
	});

	it('never fails the rollback when the restored version ships no app-module: says app-core may still point at it', async () => {
		await expect(
			runTaskCliRollback({
				resolveManifest: () => {
					throw new Error('No app-module manifest found. Looked for /pkg/app-module/manifest.json');
				},
			})
		).resolves.toBeUndefined();

		expect(sdk.registerModule).not.toHaveBeenCalled();
		const output = written.join('');
		expect(output).toContain('No app-module manifest found');
		expect(output).toContain('task cli unregister');
	});
});

describe('runTaskCliVersion', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('delegates to cliVersionCommand with pkgName and channel', async () => {
		const { cliVersionCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		const { readChannelFromConfig } = await import('@wadeck-app/shared-cli/ChannelConfig');
		vi.mocked(readChannelFromConfig).mockReturnValue('edge');

		await runTaskCliVersion();

		expect(cliVersionCommand).toHaveBeenCalledWith('@wadeck-app/task-cli', expect.any(String), 'edge');
	});

	it('completes without throwing', async () => {
		await expect(runTaskCliVersion()).resolves.toBeUndefined();
	});
});

describe('getCurrentTaskVersion', () => {
	it('returns a non-empty string', () => {
		const version = getCurrentTaskVersion();
		expect(typeof version).toBe('string');
		expect(version.length).toBeGreaterThan(0);
	});
});

describe('runTaskCliUpdate on a dev build', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('refuses with the dev-build line, exits non-zero and never starts the updater', async () => {
		const { cliUpdateCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		// The vitest define version (2026.01.01-000000-0-TEST0000) is not a CalVer release stamp.
		const written: string[] = [];
		vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
			written.push(String(chunk));
			return true;
		});
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
			throw new Error(`process.exit(${code})`);
		}) as any;

		await expect(runTaskCliUpdate({ rawArgs: [] })).rejects.toThrow('process.exit(1)');

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(written.join('')).toContain(': refusing to update the global install of task;');
		expect(cliUpdateCommand).not.toHaveBeenCalled();
	});

	it('still allows --check (read-only) on a dev build', async () => {
		const { cliVersionCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		await runTaskCliUpdate({ check: true, rawArgs: ['--check'] });
		expect(cliVersionCommand).toHaveBeenCalled();
	});
});

describe('update state "applying"', () => {
	let sandbox: string;
	let savedXdg: string | undefined;
	let written: string[];
	let exitSpy: ReturnType<typeof vi.spyOn>;

	function writeApplying(pid: number): void {
		const dir = path.join(sandbox, 'task');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'update-state.json'),
			JSON.stringify({
				status: 'applying',
				pid,
				targetVersion: '2',
				previousVersion: '1',
				currentVersion: '1',
				timestamp: Date.now(),
			})
		);
	}

	beforeEach(() => {
		sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'task-applying-'));
		savedXdg = process.env['XDG_CONFIG_HOME'];
		process.env['XDG_CONFIG_HOME'] = sandbox;
		written = [];
		vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
			written.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
			written.push(String(chunk));
			return true;
		});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
			throw new Error(`process.exit(${code})`);
		}) as any;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (savedXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
		else process.env['XDG_CONFIG_HOME'] = savedXdg;
		fs.rmSync(sandbox, { recursive: true, force: true });
	});

	it('`cli version` tells that an install was interrupted when the installer pid is dead', async () => {
		// Above any real pid range.
		writeApplying(2147483646);
		await runTaskCliVersion();
		expect(written.join('')).toContain('interrupted');
		expect(written.join('')).toContain('task cli update');
	});

	it('`cli version` stays silent about the state while the installer is alive', async () => {
		writeApplying(process.pid);
		await runTaskCliVersion();
		expect(written.join('')).not.toContain('interrupted');
	});

	it('`cli rollback` refuses while an install is running: it would race the installer', async () => {
		const { cliRollbackCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		writeApplying(process.pid);
		await expect(runTaskCliRollback({ resolveManifest: () => 'unused' })).rejects.toThrow('process.exit(1)');
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(written.join('')).toContain(`pid ${process.pid}`);
		expect(cliRollbackCommand).not.toHaveBeenCalled();
	});

	it('`cli rollback` refuses on an interrupted install and points to the repair (`cli update`)', async () => {
		const { cliRollbackCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		writeApplying(2147483646);
		await expect(runTaskCliRollback({ resolveManifest: () => 'unused' })).rejects.toThrow('process.exit(1)');
		expect(written.join('')).toContain('task cli update');
		expect(cliRollbackCommand).not.toHaveBeenCalled();
	});
});
