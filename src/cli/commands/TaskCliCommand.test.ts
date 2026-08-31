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
	afterEach(() => { vi.restoreAllMocks(); });

	it('delegates to cliRollbackCommand', async () => {
		const { cliRollbackCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		await runTaskCliRollback();
		expect(cliRollbackCommand).toHaveBeenCalledWith('@wadeck-app/task-cli', expect.any(String));
	});
});

describe('runTaskCliVersion', () => {
	afterEach(() => { vi.restoreAllMocks(); });

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
