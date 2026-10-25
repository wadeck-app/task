import { describe, expect, it, vi } from 'vitest';

import { devBuildRefusal, isCalVer, scheduleUpdaterUnlessDevBuild } from './devBuildGuard.js';

describe('isCalVer', () => {
	it.each(['2026.10.25-020-6cb52900', '2026.01.01-001-deadbeef', '2026.12.31-1234-0123abcd'])(
		'accepts the CI release stamp %s',
		version => {
			expect(isCalVer(version)).toBe(true);
		}
	);

	it.each([
		'0.0.0-local',
		'0.0.0-dev',
		'0.0.0-test-integration',
		'0.0.1',
		// The local fallback of version.ts (time + commit count + hash) must stay a dev build.
		'2026.10.25-101530-742-6cb52900',
		'2026.10.25-101530-742-DEV',
		'2026.13.01-020-6cb52900',
		'2026.10.25-20-6cb52900',
		'2026.10.25-020-6CB52900',
		'2026.10.25-020-6cb5290',
		'',
	])('rejects the dev version %j', version => {
		expect(isCalVer(version)).toBe(false);
	});

	it('rejects a missing version', () => {
		expect(isCalVer(undefined)).toBe(false);
		expect(isCalVer(null)).toBe(false);
	});
});

describe('devBuildRefusal', () => {
	it('is a single actionable line naming the version and the global package', () => {
		const message = devBuildRefusal('0.0.0-local');
		expect(message).toContain('dev build 0.0.0-local: not updating the global task-cli');
		expect(message).toContain('task cli update');
		expect(message.includes('\n')).toBe(false);
	});
});

describe('scheduleUpdaterUnlessDevBuild', () => {
	it('schedules the background updater for a release', () => {
		const schedule = vi.fn();
		const log = vi.fn();
		scheduleUpdaterUnlessDevBuild('2026.10.25-020-6cb52900', schedule, log);
		expect(schedule).toHaveBeenCalledTimes(1);
		expect(log).not.toHaveBeenCalled();
	});

	it('does not schedule the updater for a dev build and logs the one refusal line instead', () => {
		const schedule = vi.fn();
		const log = vi.fn();
		scheduleUpdaterUnlessDevBuild('0.0.0-local', schedule, log);
		expect(schedule).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith(devBuildRefusal('0.0.0-local'));
	});

	it('never lets a failing log break the command', () => {
		const log = vi.fn(() => {
			throw new Error('disk full');
		});
		expect(() => scheduleUpdaterUnlessDevBuild('0.0.0-local', vi.fn(), log)).not.toThrow();
	});
});
