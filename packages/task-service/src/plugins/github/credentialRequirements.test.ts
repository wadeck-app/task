import {
	CREDENTIAL_REQUIREMENTS,
	deniedPermissionHint,
	namePermissions,
	requirementFor,
	tokenHowTo,
} from './credentialRequirements.js';

describe('the github credential table', () => {
	it('has one row per key, with permissions written the way the GitHub token page prints them', () => {
		const keys = CREDENTIAL_REQUIREMENTS.map(row => row.key);
		expect(new Set(keys).size).toBe(keys.length);
		for (const row of CREDENTIAL_REQUIREMENTS) {
			for (const name of row.fineGrained) expect(name).toMatch(/^[A-Z][A-Za-z ]+: (Read|Read and write)$/);
			expect(row.probe.request).not.toBe('');
			expect(row.evidence).toMatch(/^(live 2026-11-08|documented|unverified)/);
		}
	});

	it('marks as required only what every command needs', () => {
		expect(CREDENTIAL_REQUIREMENTS.filter(row => row.required).map(row => row.key)).toEqual(['metadata', 'read']);
	});

	it('says that labels need no permission of their own: reading them is Issues: Read, creating them Issues: Read and write', () => {
		expect(requirementFor('labels').fineGrained).toEqual(['Issues: Read']);
		expect(requirementFor('labels-write').fineGrained).toEqual(['Issues: Read and write']);
		expect(CREDENTIAL_REQUIREMENTS.flatMap(row => row.fineGrained)).not.toContain('Labels: Read');
	});

	it('makes hard delete a role of the user of the token, not a permission of the token', () => {
		const row = requirementFor('delete');
		expect(row.role).toBe('repository administrator');
		expect(row.probe.request).toContain('permissions.admin');
	});

	it('throws on a key that is not in the table', () => {
		expect(() => requirementFor('nope' as never)).toThrow(/not in the table/);
	});

	it('gives a how-to with the exact GitHub UI path and every permission', () => {
		const text = tokenHowTo().join('\n');
		expect(text).toContain('Settings > Developer settings > Personal access tokens > Fine-grained tokens');
		expect(text).toContain('Issues: Read and write');
		expect(text).toContain('Metadata: Read');
		expect(text).toContain('repo');
	});
});

describe('namePermissions', () => {
	it.each([
		['issues=write', ['Issues: Read and write']],
		['issues=read', ['Issues: Read']],
		['issues=read; metadata=read', ['Issues: Read', 'Metadata: Read']],
		['issues=read, pull_requests=read', ['Issues: Read', 'Pull requests: Read']],
		['administration=write', ['Administration: Read and write']],
	])('reads %j', (header, expected) => {
		expect(namePermissions(header)).toEqual(expected);
	});

	it('keeps what it does not understand as written, never drops it', () => {
		expect(namePermissions('issues=triage')).toEqual(['Issues: triage']);
		expect(namePermissions('something')).toEqual(['something']);
	});
});

describe('deniedPermissionHint', () => {
	it('names the permission, GitHub header, the repository, the UI path and where the token is read from', () => {
		const hint = deniedPermissionHint('issues=write', 'acme/shop', 'the variable GITHUB_TOKEN');
		expect(hint).toContain('Issues: Read and write');
		expect(hint).toContain('issues=write');
		expect(hint).toContain('acme/shop');
		expect(hint).toContain('GITHUB_TOKEN');
		expect(hint).toContain('Fine-grained tokens');
		expect(hint).toContain('docs.github.com');
	});

	it('without the header, names what a read of the strategy needs', () => {
		const hint = deniedPermissionHint(undefined, 'acme/shop', 'the variable GITHUB_TOKEN', true);
		expect(hint).toContain('Issues: Read and write');
		expect(hint).toContain('Metadata: Read');
	});
});
