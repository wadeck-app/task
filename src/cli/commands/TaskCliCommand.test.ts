import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCurrentTaskVersion, runTaskCliRollback, runTaskCliSelfCheck, runTaskCliVersion } from './TaskCliCommand.js';

vi.mock('node:fs', async () => {
	const real = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...real,
		// Wrap as vi.fn() so tests can override with mockReturnValue; default to real behavior.
		existsSync: vi.fn().mockImplementation(real.existsSync),
		readFileSync: vi.fn().mockImplementation(real.readFileSync),
		unlinkSync: vi.fn().mockImplementation(real.unlinkSync),
	};
});
vi.mock('node:child_process', () => ({
	execFile: vi.fn(),
	execFileSync: vi.fn(),
}));

// Make execFileAsync (promisified execFile) resolve with a version string.
// util.promisify expects cb(err, value) -- pass {stdout,stderr} as the single value.
function mockExecFileSuccess(stdout = '1.0.0\n'): void {
	vi.mocked(cp.execFile).mockImplementation((...args: unknown[]) => {
		const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
		cb(null, { stdout, stderr: '' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return {} as any;
	});
}

describe('runTaskCliSelfCheck', () => {
	let exitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		// Restore real fs behavior -- previous tests may have called vi.restoreAllMocks()
		// which strips the mockImplementation from the module-level vi.fn() wrappers.
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

	it('suppresses stdout output when CLI_SELF_CHECK_QUIET=1', async () => {
		process.env['CLI_SELF_CHECK_QUIET'] = '1';
		const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

		await runTaskCliSelfCheck();

		expect(stdoutSpy).not.toHaveBeenCalled();
		expect(exitSpy).not.toHaveBeenCalled();
	});
});

describe('runTaskCliRollback', () => {
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;
	let stdoutSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
			throw new Error(`process.exit(${_code})`);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		}) as any;
		stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('calls npm install -g with the correct version when state is valid', () => {
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ previousVersion: '2.0.1' }));
		vi.mocked(fs.unlinkSync).mockImplementation(() => {});

		runTaskCliRollback();

		// On Windows npm-cli.js is used; on other systems 'npm' is called directly.
		// Assert the version appears in the args regardless of which executable is used.
		const call = vi.mocked(cp.execFileSync).mock.calls[0];
		expect(call).toBeDefined();
		const argsJoined = (call as unknown[]).flat().join(' ');
		expect(argsJoined).toContain('install');
		expect(argsJoined).toContain('@wadeck-app/task-cli@2.0.1');
		expect(stdoutSpy).toHaveBeenCalledWith('Rolled back to v2.0.1\n');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('calls process.exit(1) when previousVersion fails VERSION_RE validation', () => {
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ previousVersion: 'bad-version' }));

		expect(() => runTaskCliRollback()).toThrow('process.exit(1)');

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(vi.mocked(cp.execFileSync)).not.toHaveBeenCalled();
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid or missing previousVersion'));
	});

	it('calls process.exit(1) when the state file is missing', () => {
		vi.mocked(fs.existsSync).mockReturnValue(false);

		expect(() => runTaskCliRollback()).toThrow('process.exit(1)');

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(vi.mocked(cp.execFileSync)).not.toHaveBeenCalled();
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('No update state found'));
	});
});

describe('runTaskCliVersion', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('completes without throwing when npm view succeeds', async () => {
		mockExecFileSuccess('1.5.0\n');
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

		await expect(runTaskCliVersion()).resolves.toBeUndefined();
	});

	it('writes the installed version to stdout', async () => {
		mockExecFileSuccess('1.5.0\n');
		const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

		await runTaskCliVersion();

		const calls = stdoutSpy.mock.calls.map(c => String(c[0])).join('');
		expect(calls).toContain('task v');
		expect(calls).toContain('(installed)');
	});

	it('writes to stderr without throwing when npm view fails', async () => {
		vi.mocked(cp.execFile).mockImplementation((...args: unknown[]) => {
			const cb = args[args.length - 1] as (err: Error) => void;
			cb(new Error('network error'));
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return {} as any;
		});
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

		await expect(runTaskCliVersion()).resolves.toBeUndefined();
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Could not fetch latest version'));
	});
});

describe('getCurrentTaskVersion', () => {
	it('returns a non-empty string', () => {
		const version = getCurrentTaskVersion();
		expect(typeof version).toBe('string');
		expect(version.length).toBeGreaterThan(0);
	});
});
