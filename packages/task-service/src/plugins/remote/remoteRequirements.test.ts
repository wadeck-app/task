import { REMOTE_REQUIREMENTS, remoteRequirementFor, remoteTokenHowTo } from './remoteRequirements.js';

describe('the remote credential table', () => {
	it('has one row per key, each with a probe, its evidence and what both machines must hold', () => {
		const keys = REMOTE_REQUIREMENTS.map(row => row.key);
		expect(keys).toEqual(['reachable', 'auth', 'protocol', 'project', 'server-token']);
		for (const row of REMOTE_REQUIREMENTS) {
			expect(row.probe.request).not.toBe('');
			expect(row.evidence).not.toBe('');
			expect(row.needs).not.toBe('');
		}
	});

	it('says that one shared token gives everything: there is no read-only token and no per-capability permission', () => {
		expect(remoteTokenHowTo().join('\n')).toContain('no read-only token');
	});

	it('only the server can tell how strong its token is, so that row is not tested from here', () => {
		expect(remoteRequirementFor('server-token').probe.kind).toBe('none');
		expect(remoteRequirementFor('auth').probe.kind).toBe('get');
	});

	it('throws on a key that is not in the table', () => {
		expect(() => remoteRequirementFor('nope' as never)).toThrow(/not in the table/);
	});

	it('gives a how-to naming both machines, the variables, 16 characters, mode 600 and the same value', () => {
		const text = remoteTokenHowTo().join('\n');
		expect(text).toContain('TASK_SERVE_TOKEN');
		expect(text).toContain('--token-file');
		expect(text).toContain('tokenEnv');
		expect(text).toContain('16');
		expect(text).toContain('chmod 600');
		expect(text).toContain('the SAME value');
	});
});
