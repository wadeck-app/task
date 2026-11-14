import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LOCAL_CAPABILITIES } from '../backend/capabilities';
import type { BackendCapabilities } from '../backend/capabilities';
import { LocalFileBackend } from '../backend/LocalFileBackend';
import type { TaskBackend } from '../backend/TaskBackend';
import { TaskStore } from '../TaskStore';
import {
	assertDeclaredCapabilities,
	BACKEND_CONTRACT_CASES,
	runBackendContract,
	runContractCase,
} from './backendContract';
import type { BackendFixture } from './backendContract';
import { RESTRICTED_CAPABILITIES, RestrictedBackend } from './restrictedBackend';

function localFixture(): { store: TaskStore; backend: LocalFileBackend; dispose: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-backend-contract-'));
	const tasksDir = path.join(root, 'data', 'tasks');
	fs.mkdirSync(tasksDir, { recursive: true });
	const store = new TaskStore(tasksDir);
	return {
		store,
		backend: new LocalFileBackend(store),
		dispose: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

// A backend that declares fewer capabilities and refuses loudly: the whole suite must pass, the gated cases through
// their "asserts UnsupportedByBackendError" branch (never skipped).
runBackendContract(
	'RestrictedBackend (labels, meta, comments, hierarchy, two link types, delete, search, concurrency off)',
	() => {
		const fixture = localFixture();
		return { backend: new RestrictedBackend(fixture.store), dispose: fixture.dispose };
	},
	RESTRICTED_CAPABILITIES
);

/** The same backend under another declaration, without touching its behaviour. */
function declaring(backend: TaskBackend, capabilities: BackendCapabilities): TaskBackend {
	return Object.assign(Object.create(backend) as TaskBackend, { capabilities });
}

describe('the contract itself', () => {
	it('every case that needs a capability also says what must be refused when it is missing', () => {
		const gated = BACKEND_CONTRACT_CASES.filter(c => c.needs !== undefined);
		expect(gated.length).toBeGreaterThan(10);
		for (const contractCase of gated) {
			expect(contractCase.attempt, `${contractCase.group}: ${contractCase.name}`).toBeTypeOf('function');
		}
	});

	it('case names are unique (they are the names of the generated tests)', () => {
		const names = BACKEND_CONTRACT_CASES.map(c => `${c.group}: ${c.name}`);
		expect(new Set(names).size).toBe(names.length);
	});

	it('covers every group of the design (1.7)', () => {
		const groups = new Set(BACKEND_CONTRACT_CASES.map(c => c.group));
		for (const group of ['crud', 'status', 'fields', 'graph', 'concurrency', 'delete', 'atomicity', 'search']) {
			expect(groups.has(group), group).toBe(true);
		}
	});

	// A backend that declares a capability away but still answers: the gated case must FAIL (a silent success is a lie).
	it.each([
		['labels', { ...LOCAL_CAPABILITIES, labels: false }],
		['meta', { ...LOCAL_CAPABILITIES, meta: false }],
		['comments', { ...LOCAL_CAPABILITIES, comments: false }],
		['priority', { ...LOCAL_CAPABILITIES, priority: false }],
		['assignee', { ...LOCAL_CAPABILITIES, assignee: false }],
		['claim', { ...LOCAL_CAPABILITIES, claim: false }],
		['hierarchy', { ...LOCAL_CAPABILITIES, hierarchy: 'none' as const }],
		['linkTypes', { ...LOCAL_CAPABILITIES, linkTypes: ['blockedBy'] as BackendCapabilities['linkTypes'] }],
		['delete', { ...LOCAL_CAPABILITIES, delete: 'no' as const }],
		['search', { ...LOCAL_CAPABILITIES, search: 'none' as const }],
		['concurrency', { ...LOCAL_CAPABILITIES, concurrency: 'none' as const }],
	] as const)('fails a backend that declares %s unsupported but still performs it', async (capability, declared) => {
		const gated = BACKEND_CONTRACT_CASES.filter(c => c.needs?.capability === capability);
		expect(gated.length).toBeGreaterThan(0);
		const failed: string[] = [];
		for (const contractCase of gated) {
			const fixture = localFixture();
			try {
				await runContractCase(contractCase, { backend: declaring(fixture.backend, declared) }, {});
			} catch {
				failed.push(contractCase.name);
			} finally {
				fixture.dispose();
			}
		}
		// Every case whose need is now unmet fails; the ones whose need still holds (a link type kept) pass.
		const unmet = gated.filter(c => !c.needs!.met(declared));
		expect(unmet.length).toBeGreaterThan(0);
		expect(failed.sort()).toEqual(unmet.map(c => c.name).sort());
	});

	// The opposite lie: declares a capability but refuses it.
	it('fails a backend that declares meta supported but refuses it with UnsupportedByBackendError', async () => {
		const metaCases = BACKEND_CONTRACT_CASES.filter(c => c.needs?.capability === 'meta');
		expect(metaCases.length).toBeGreaterThan(0);
		for (const contractCase of metaCases) {
			const fixture = localFixture();
			try {
				const refusing = new RestrictedBackend(fixture.store);
				const lying = declaring(refusing, { ...RESTRICTED_CAPABILITIES, meta: true });
				await expect(runContractCase(contractCase, { backend: lying }, {})).rejects.toThrow();
			} finally {
				fixture.dispose();
			}
		}
	});

	it('fails loudly, naming the missing operation, a backend that lacks the optional priority / claim operations', async () => {
		const fixture = localFixture();
		try {
			const lacking = Object.assign(Object.create(fixture.backend) as TaskBackend, {
				setPriority: undefined,
				claim: undefined,
			});
			const priorityCase = BACKEND_CONTRACT_CASES.find(c => c.needs?.capability === 'priority')!;
			await expect(runContractCase(priorityCase, { backend: lacking }, {})).rejects.toThrow(
				/does not implement setPriority/
			);
			const claimCase = BACKEND_CONTRACT_CASES.find(c => c.needs?.capability === 'claim')!;
			await expect(runContractCase(claimCase, { backend: lacking }, {})).rejects.toThrow(
				/does not implement claim/
			);
		} finally {
			fixture.dispose();
		}
	});

	it('refuses a backend whose declared capabilities differ from the expected ones, naming the difference', () => {
		const fixture = localFixture();
		try {
			expect(() =>
				assertDeclaredCapabilities(
					declaring(fixture.backend, { ...LOCAL_CAPABILITIES, meta: false }),
					LOCAL_CAPABILITIES
				)
			).toThrow(/capabilities.*meta/s);
			expect(() => assertDeclaredCapabilities(fixture.backend, LOCAL_CAPABILITIES)).not.toThrow();
		} finally {
			fixture.dispose();
		}
	});

	it('exposes the fixture type other backends build', () => {
		const fixture: BackendFixture = localFixture();
		expect(fixture.backend.kind).toBe('local');
		void fixture.dispose?.();
	});
});
