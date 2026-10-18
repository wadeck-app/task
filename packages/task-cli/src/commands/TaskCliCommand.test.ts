import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCurrentTaskVersion, runTaskCliRollback, runTaskCliSelfCheck, runTaskCliVersion } from './TaskCliCommand.js';

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

	beforeEach(() => {
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
	});

	it('delegates to cliRollbackCommand', async () => {
		const { cliRollbackCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		sdk.registerModule.mockResolvedValue({ status: 'skipped' });
		await runTaskCliRollback({ resolveManifest: () => '/pkg/app-module/manifest.json' });
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

		await runTaskCliRollback({ resolveManifest: () => '/pkg/app-module/manifest.json' });

		expect(order).toEqual(['rollback', 'register']);
		expect(sdk.registerModule).toHaveBeenCalledWith({ id: 'task', manifestPath: '/pkg/app-module/manifest.json' });
		expect(written.join('')).toContain('app-core: described registered');
	});

	it('does not touch app-core when the rollback itself fails (shared-cli exits or throws)', async () => {
		const { cliRollbackCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		vi.mocked(cliRollbackCommand).mockRejectedValue(new Error('npm install failed'));

		await expect(runTaskCliRollback({ resolveManifest: () => '/pkg/app-module/manifest.json' })).rejects.toThrow(
			'npm install failed'
		);

		expect(sdk.registerModule).not.toHaveBeenCalled();
	});

	it('never fails the rollback when app-core refuses: the message says how to retry', async () => {
		sdk.registerModule.mockResolvedValue({ status: 'refused' });
		sdk.describeRegistration.mockReturnValue('app-core: refused the module (bad manifest)');

		await expect(
			runTaskCliRollback({ resolveManifest: () => '/pkg/app-module/manifest.json' })
		).resolves.toBeUndefined();

		expect(written.join('')).toContain('app-core: refused the module (bad manifest)');
		expect(written.join('')).toContain('task cli register');
	});

	it('never fails the rollback when the SDK rejects', async () => {
		sdk.registerModule.mockRejectedValue(new Error('socket hang up'));

		await expect(
			runTaskCliRollback({ resolveManifest: () => '/pkg/app-module/manifest.json' })
		).resolves.toBeUndefined();

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
