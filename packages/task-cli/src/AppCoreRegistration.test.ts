import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
	registerModule: vi.fn(),
	unregisterModule: vi.fn(),
	describeRegistration: vi.fn(),
}));
vi.mock('@wadeck-app/app-core-sdk/register', () => sdk);

import {
	APP_CORE_MODULE_ID,
	attemptRegistration,
	attemptUnregistration,
	registerWithAppCore,
	unregisterFromAppCore,
} from './AppCoreRegistration.js';

let lines: { source: string; message: string }[];
const log = (entry: { source: string; message: string }): void => {
	lines.push(entry);
};

beforeEach(() => {
	lines = [];
	// mockReset is on in vitest.config, so every test sets what it needs.
	sdk.describeRegistration.mockImplementation((outcome: { status: string }) => `described:${outcome.status}`);
});

describe('APP_CORE_MODULE_ID', () => {
	it('is "task"', () => {
		expect(APP_CORE_MODULE_ID).toBe('task');
	});
});

describe('attemptRegistration', () => {
	it.each([
		['registered', true],
		['deferred', true],
		['skipped', true],
		['refused', false],
	])('maps the app-core outcome "%s" to ok=%s and keeps the SDK wording', async (status, ok) => {
		sdk.registerModule.mockResolvedValue({ status });
		const result = await attemptRegistration('/abs/manifest.json');
		expect(sdk.registerModule).toHaveBeenCalledWith({ id: 'task', manifestPath: '/abs/manifest.json' });
		expect(result).toEqual({ ok, status, message: `described:${status}` });
	});

	it('reports a rejection of the SDK (bad APP_CORE_PORT, missing manifest) as failed, with the reason', async () => {
		sdk.registerModule.mockRejectedValue(new Error('APP_CORE_PORT "abc" is not a port'));
		const result = await attemptRegistration('/abs/manifest.json');
		expect(result.ok).toBe(false);
		expect(result.status).toBe('failed');
		expect(result.message).toContain('APP_CORE_PORT "abc" is not a port');
	});
});

describe('attemptUnregistration', () => {
	it.each([
		['unregistered', true],
		['not-registered', true],
		['cleared', true],
		['skipped', true],
		['refused', false],
	])('maps the app-core outcome "%s" to ok=%s', async (status, ok) => {
		sdk.unregisterModule.mockResolvedValue({ status });
		const result = await attemptUnregistration();
		expect(sdk.unregisterModule).toHaveBeenCalledWith({ id: 'task' });
		expect(result).toEqual({ ok, status, message: `described:${status}` });
	});

	it('reports a rejection of the SDK as failed, with the reason', async () => {
		sdk.unregisterModule.mockRejectedValue(new Error('boom'));
		const result = await attemptUnregistration();
		expect(result).toMatchObject({ ok: false, status: 'failed' });
		expect(result.message).toContain('boom');
	});
});

describe('registerWithAppCore (best-effort)', () => {
	it('logs what app-core answered', async () => {
		sdk.registerModule.mockResolvedValue({ status: 'registered' });
		await registerWithAppCore('/abs/manifest.json', log);
		expect(lines).toEqual([{ source: 'AppCoreRegistration', message: 'described:registered' }]);
	});

	it('logs the refusal of app-core instead of hiding it', async () => {
		sdk.registerModule.mockResolvedValue({ status: 'refused' });
		await registerWithAppCore('/abs/manifest.json', log);
		expect(lines[0]!.message).toBe('described:refused');
	});

	it('never throws when the SDK rejects, and logs the failure', async () => {
		sdk.registerModule.mockRejectedValue(new Error('no such manifest'));
		await expect(registerWithAppCore('/abs/manifest.json', log)).resolves.toBeUndefined();
		expect(lines[0]!.message).toContain('no such manifest');
	});
});

describe('unregisterFromAppCore (best-effort)', () => {
	it('logs what app-core answered and never throws', async () => {
		sdk.unregisterModule.mockRejectedValue(new Error('boom'));
		await expect(unregisterFromAppCore(log)).resolves.toBeUndefined();
		expect(lines[0]!.message).toContain('boom');
	});
});
