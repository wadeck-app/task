import { UnsupportedByBackendError } from '@wadeck-app/task-core';
import type { LabelSyncReport } from '@wadeck-app/task-core';

import { describeError } from './describeError.js';
import { syncLabels } from './syncLabels.js';
import { createTestContext } from './testHelpers.js';
import type { TestContext } from './testHelpers.js';

describe('syncLabels', () => {
	let t: TestContext;
	beforeEach(() => {
		t = createTestContext();
	});
	afterEach(() => t.cleanup());

	it('is refused on the local strategy, which keeps its labels in the task files, and says what the command is for', async () => {
		const error = await syncLabels(t.ctx, {}).catch((caught: unknown) => caught as Error);

		expect(error).toBeInstanceOf(UnsupportedByBackendError);
		const described = describeError(error);
		expect(described.kind).toBe('unsupported');
		expect(described.hint).toContain('github');
		expect(described.hint).toContain('local');
	});

	it('asks the backend, passes --dry-run, and returns its report as is', async () => {
		const report: LabelSyncReport = {
			dryRun: true,
			wanted: [{ name: 'status:x', kind: 'status', why: 'status "x"' }],
			created: ['status:x'],
			existing: [],
			notes: [],
		};
		const seen: unknown[] = [];
		const ctx = {
			...t.ctx,
			store: {
				...t.ctx.store,
				kind: 'github' as const,
				syncLabels: (options: unknown) => {
					seen.push(options);
					return Promise.resolve(report);
				},
			},
		};

		expect(await syncLabels(ctx, { dryRun: true })).toBe(report);
		expect(seen).toEqual([{ dryRun: true }]);
	});

	it('a gitlab backend is asked for its labels like a github one', async () => {
		const report = { dryRun: false, wanted: [], created: ['status:x'], existing: [], notes: [] };
		const ctx = {
			...t.ctx,
			store: { ...t.ctx.store, kind: 'gitlab' as const, syncLabels: () => Promise.resolve(report) },
		};

		expect(await syncLabels(ctx, {})).toBe(report);
	});

	it('a backend of another kind that cannot create labels is refused the same way', async () => {
		const ctx = { ...t.ctx, store: { ...t.ctx.store, kind: 'remote' as const } };

		const error = await syncLabels(ctx, {}).catch((caught: unknown) => caught as Error);

		expect(error).toBeInstanceOf(UnsupportedByBackendError);
	});
});
