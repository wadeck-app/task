import { BACKEND_CAPABILITY_NAMES, BACKEND_KINDS, LOCAL_CAPABILITIES } from './capabilities';

describe('the runtime lists that mirror the capability types', () => {
	it('BACKEND_CAPABILITY_NAMES holds exactly the keys of BackendCapabilities (LOCAL_CAPABILITIES has them all)', () => {
		expect([...BACKEND_CAPABILITY_NAMES].sort()).toEqual(Object.keys(LOCAL_CAPABILITIES).sort());
	});

	it('BACKEND_KINDS lists the four kinds of the design', () => {
		expect([...BACKEND_KINDS]).toEqual(['local', 'github', 'gitlab', 'remote']);
	});
});

describe('the events capability', () => {
	it('the local store emits its events from the process that changes the tasks', () => {
		expect(LOCAL_CAPABILITIES.events).toBe('client');
	});
});

describe('the priority, assignee and claim capabilities', () => {
	it('the local store holds all three', () => {
		expect(LOCAL_CAPABILITIES.priority).toBe(true);
		expect(LOCAL_CAPABILITIES.assignee).toBe(true);
		expect(LOCAL_CAPABILITIES.claim).toBe(true);
	});

	it('are named in the runtime list, so a fill or a strategy table can refer to them', () => {
		for (const name of ['priority', 'assignee', 'claim'] as const) {
			expect(BACKEND_CAPABILITY_NAMES).toContain(name);
		}
	});
});

describe('the writes capability', () => {
	it('the local store writes in full', () => {
		expect(LOCAL_CAPABILITIES.writes).toBe('full');
	});
});
