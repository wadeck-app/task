import { describe, expect, it, vi } from 'vitest';
import { runAppCoreCommand, type AppCoreCommandDeps } from './AppCoreCommand.js';

function deps(overrides: Partial<AppCoreCommandDeps> = {}): AppCoreCommandDeps {
	return {
		resolveManifest: vi.fn(() => '/abs/app-module/manifest.json'),
		register: vi.fn(async () => ({
			ok: true,
			status: 'registered',
			message: 'app-core: module "task" registered',
		})),
		unregister: vi.fn(async () => ({
			ok: true,
			status: 'unregistered',
			message: 'app-core: module "task" removed',
		})),
		...overrides,
	};
}

describe('runAppCoreCommand register', () => {
	it('registers the resolved manifest and prints the answer of app-core, exit 0', async () => {
		const d = deps();
		const result = await runAppCoreCommand('register', false, d);
		expect(d.register).toHaveBeenCalledWith('/abs/app-module/manifest.json');
		expect(result).toEqual({ exitCode: 0, output: 'app-core: module "task" registered' });
	});

	it('exits 0 with a clear message when app-core is absent or not running (deferred / skipped)', async () => {
		for (const status of ['deferred', 'skipped']) {
			const d = deps({
				register: vi.fn(async () => ({ ok: true, status, message: `app-core: ${status} message` })),
			});
			const result = await runAppCoreCommand('register', false, d);
			expect(result).toEqual({ exitCode: 0, output: `app-core: ${status} message` });
		}
	});

	it('exits non-zero with the reason when app-core refuses', async () => {
		const d = deps({
			register: vi.fn(async () => ({
				ok: false,
				status: 'refused',
				message: 'app-core: refused module "task" (HTTP 400): bad manifest',
			})),
		});
		const result = await runAppCoreCommand('register', false, d);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('bad manifest');
	});

	it('exits non-zero, naming both paths, when no manifest can be found', async () => {
		const d = deps({
			resolveManifest: vi.fn(() => {
				throw new Error('No app-module manifest found. Looked for /a and /b.');
			}),
		});
		const result = await runAppCoreCommand('register', false, d);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('/a');
		expect(result.output).toContain('/b');
		expect(d.register).not.toHaveBeenCalled();
	});

	it('--json: an ok result carries status and message', async () => {
		const result = await runAppCoreCommand('register', true, deps());
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual({
			ok: true,
			status: 'registered',
			message: 'app-core: module "task" registered',
		});
	});

	it('exits 0 when the registration is unconfirmed, printing the message with the retry command (not a failure, not "registered")', async () => {
		const message = 'app-core: registration of module "task" not confirmed: timeout. Run: task cli register';
		const d = deps({ register: vi.fn(async () => ({ ok: true, status: 'unconfirmed', message })) });
		expect(await runAppCoreCommand('register', false, d)).toEqual({ exitCode: 0, output: message });
		const json = await runAppCoreCommand('register', true, d);
		expect(json.exitCode).toBe(0);
		expect(JSON.parse(json.output)).toEqual({ ok: true, status: 'unconfirmed', message });
	});

	it('--json: failures are {"error": ...} like the other commands, with a non-zero exit', async () => {
		const d = deps({
			register: vi.fn(async () => ({
				ok: false,
				status: 'failed',
				message: 'app-core: registration failed: boom',
			})),
		});
		const result = await runAppCoreCommand('register', true, d);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.output)).toEqual({ error: 'app-core: registration failed: boom', status: 'failed' });
	});

	it('--json: a missing manifest is {"error": ...} too', async () => {
		const d = deps({
			resolveManifest: vi.fn(() => {
				throw new Error('nothing here');
			}),
		});
		const result = await runAppCoreCommand('register', true, d);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.output)).toEqual({ error: 'nothing here' });
	});
});

describe('runAppCoreCommand unregister', () => {
	it('does not need a manifest and prints the answer of app-core', async () => {
		const d = deps({
			resolveManifest: vi.fn(() => {
				throw new Error('must not be called');
			}),
		});
		const result = await runAppCoreCommand('unregister', false, d);
		expect(result).toEqual({ exitCode: 0, output: 'app-core: module "task" removed' });
	});

	it('exits non-zero with the reason when app-core refuses', async () => {
		const d = deps({
			unregister: vi.fn(async () => ({
				ok: false,
				status: 'refused',
				message: 'app-core: refused module "task" (HTTP 500): x',
			})),
		});
		const result = await runAppCoreCommand('unregister', false, d);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('HTTP 500');
	});
});
