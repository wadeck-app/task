import { BACKEND_CAPABILITY_NAMES, BACKEND_KINDS, LOCAL_CAPABILITIES } from './capabilities';

describe('the runtime lists that mirror the capability types', () => {
	it('BACKEND_CAPABILITY_NAMES holds exactly the keys of BackendCapabilities (LOCAL_CAPABILITIES has them all)', () => {
		expect([...BACKEND_CAPABILITY_NAMES].sort()).toEqual(Object.keys(LOCAL_CAPABILITIES).sort());
	});

	it('BACKEND_KINDS lists the four kinds of the design', () => {
		expect([...BACKEND_KINDS]).toEqual(['local', 'github', 'gitlab', 'remote']);
	});
});

describe('the writes capability', () => {
	it('the local store writes in full', () => {
		expect(LOCAL_CAPABILITIES.writes).toBe('full');
	});
});
