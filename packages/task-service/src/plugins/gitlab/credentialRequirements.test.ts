import {
	CREDENTIAL_REQUIREMENTS,
	deniedPermissionHint,
	parseDeniedPermissions,
	requirementFor,
	tokenHowTo,
} from './credentialRequirements.js';

// The body GitLab.com sent for a call the token could not make (VERIFIED-LIVE 2026-11-09).
const LIVE_DENIAL = {
	error: 'insufficient_granular_scope',
	error_description:
		'Access denied: This operation requires a fine-grained personal access token with the following project permissions: [Project: Read].',
};

describe('the credential table', () => {
	it('has one row per key, with permissions written the way GitLab prints them', () => {
		const keys = CREDENTIAL_REQUIREMENTS.map(row => row.key);
		expect(new Set(keys).size).toBe(keys.length);
		for (const row of CREDENTIAL_REQUIREMENTS) {
			expect(row.fineGrained.length).toBeGreaterThan(0);
			for (const name of row.fineGrained) expect(name).toMatch(/^[A-Z][A-Za-z ]+: [A-Z][A-Za-z ]+$/);
			expect(row.probe.request).not.toBe('');
		}
	});

	it('marks as required only what every command needs', () => {
		const required = CREDENTIAL_REQUIREMENTS.filter(row => row.required).map(row => row.key);
		expect(required).toEqual(['read', 'labels-read']);
	});

	it('throws on a key that is not in the table', () => {
		expect(() => requirementFor('nope' as never)).toThrow(/not in the table/);
	});

	it('gives a how-to that names every project permission once', () => {
		const text = tokenHowTo().join('\n');
		for (const name of [
			'Work Item: Read',
			'Work Item: Create',
			'Work Item: Update',
			'Work Item: Delete',
			'Label: Read',
			'Label: Create',
		]) {
			expect(text.split(name).length - 1, name).toBeGreaterThanOrEqual(1);
		}
		expect(text).toContain('scope api');
	});
});

describe('parseDeniedPermissions', () => {
	it('reads the kind and the permission from the live 403 body', () => {
		expect(parseDeniedPermissions(LIVE_DENIAL)).toEqual({ kind: 'project', permissions: ['Project: Read'] });
	});

	it('reads several permissions and the instance kind', () => {
		expect(
			parseDeniedPermissions({
				error: 'insufficient_granular_scope',
				error_description:
					'Access denied: This operation requires a fine-grained personal access token with the following instance permissions: [Metadata: Read, Work Item: Read].',
			})
		).toEqual({ kind: 'instance', permissions: ['Metadata: Read', 'Work Item: Read'] });
	});

	it.each([
		undefined,
		null,
		'text',
		{ message: '403 Forbidden' },
		{ error: 'insufficient_scope' },
		{ error: 'insufficient_granular_scope' },
	])('answers undefined for %j (a role problem or a classic token has another shape)', body => {
		expect(parseDeniedPermissions(body)).toBeUndefined();
	});
});

describe('deniedPermissionHint', () => {
	it('names the permission, the project and where the token is read from', () => {
		const hint = deniedPermissionHint(
			{ kind: 'project', permissions: ['Work Item: Update'] },
			'the variable GITLAB_TOKEN',
			'acme/shop'
		);
		expect(hint).toContain('Work Item: Update');
		expect(hint).toContain('acme/shop');
		expect(hint).toContain('GITLAB_TOKEN');
		expect(hint).toContain('docs.gitlab.com');
	});
});
