import { describe, expect, it } from 'vitest';

import { formatUpdateNotice } from './updateNotice.js';

const alive = () => true;
const dead = () => false;

describe('formatUpdateNotice', () => {
	it('says nothing without a state', () => {
		expect(formatUpdateNotice(null, dead)).toBeUndefined();
	});

	it('reports a success with the target version', () => {
		expect(
			formatUpdateNotice({ status: 'success', targetVersion: '2026.10.25-020-6cb52900', timestamp: 1 }, dead)
		).toBe('[task] Updated to v2026.10.25-020-6cb52900');
	});

	it('never prints "vundefined" when a success carries no version', () => {
		const notice = formatUpdateNotice({ status: 'success', timestamp: 1 }, dead);
		expect(notice).toBeDefined();
		expect(notice).not.toContain('undefined');
		expect(notice).not.toContain('Updated to v');
	});

	it('reports the failure reason of a rollback instead of always blaming the self-check', () => {
		const notice = formatUpdateNotice(
			{
				status: 'rolled-back',
				targetVersion: '2',
				previousVersion: '1',
				error: 'npm install reported success but package.json is missing',
				timestamp: 1,
			},
			dead
		);
		expect(notice).toContain('Rolled back to v1');
		expect(notice).toContain('npm install reported success but package.json is missing');
		expect(notice).not.toContain('self-check failed');
		expect(notice).toContain('task cli logs');
	});

	it('reports an interrupted install repaired by the updater as such', () => {
		const notice = formatUpdateNotice(
			{
				status: 'rolled-back',
				targetVersion: '2',
				previousVersion: '1',
				error: 'interrupted install repaired: 1 restored',
				timestamp: 1,
			},
			dead
		);
		expect(notice).toContain('interrupted install repaired: 1 restored');
	});

	it('reports a failed update with its error', () => {
		expect(formatUpdateNotice({ status: 'failed', error: 'boom', timestamp: 1 }, dead)).toContain('boom');
	});

	describe('applying', () => {
		it('stays quiet while the installer process is alive: an update is running, not interrupted', () => {
			const notice = formatUpdateNotice(
				{ status: 'applying', pid: 4242, targetVersion: '2', previousVersion: '1', timestamp: 1 },
				alive
			);
			expect(notice).toBeUndefined();
		});

		it('reports an interrupted install when the installer pid is gone, never "updated to"', () => {
			const isAlive = (pid: number | undefined) => {
				expect(pid).toBe(4242);
				return false;
			};
			const notice = formatUpdateNotice(
				{ status: 'applying', pid: 4242, targetVersion: '2', previousVersion: '1', timestamp: 1 },
				isAlive
			);
			expect(notice).toContain('interrupted');
			expect(notice).toContain('v2');
			expect(notice).toContain('v1');
			expect(notice).toContain('task cli update');
			expect(notice).not.toMatch(/updated to/i);
		});

		it('reports an interrupted install when no pid was journalled', () => {
			const notice = formatUpdateNotice({ status: 'applying', targetVersion: '2', timestamp: 1 }, dead);
			expect(notice).toContain('interrupted');
		});
	});
});
