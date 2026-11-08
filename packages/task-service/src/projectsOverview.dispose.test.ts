import * as fs from 'node:fs';
import * as path from 'node:path';

import { openResolvedProject } from './openContext.js';
import { resolveProject } from './resolveProject.js';
import { listTasksAcrossProjects, summarizeProjects } from './projectsOverview.js';
import { ownConfigFile } from './storage.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

// The cross-project views open one context per project: each is released once it has been read (design 3A.3, lifecycle).
const probe = vi.hoisted(() => ({ disposers: [] as Array<ReturnType<typeof vi.fn>> }));

vi.mock('./openContext.js', async importOriginal => {
	const actual = await importOriginal<typeof import('./openContext.js')>();
	return {
		...actual,
		openTaskContext: (...args: Parameters<typeof actual.openTaskContext>) => {
			const ctx = actual.openTaskContext(...args);
			const dispose = vi.fn(() => ctx.dispose?.() ?? Promise.resolve());
			probe.disposers.push(dispose);
			return { ...ctx, dispose };
		},
	};
});

let sandbox: SharedRegistrySandbox;

beforeEach(async () => {
	probe.disposers.length = 0;
	sandbox = createSharedRegistrySandbox();
	for (const name of ['alpha', 'beta']) {
		const dir = sandbox.dir(name);
		await sandbox.register(name, dir);
		const resolved = resolveProject({ cwd: dir, env: sandbox.env });
		fs.mkdirSync(path.dirname(ownConfigFile(resolved.storage)), { recursive: true });
		fs.writeFileSync(ownConfigFile(resolved.storage), 'statuses:\n  - backlog\n');
		// The setup context is not under test: forget its disposer.
		await openResolvedProject(resolved).store.create({ title: name, status: 'backlog' });
	}
	probe.disposers.length = 0;
});

afterEach(() => {
	sandbox.cleanup();
});

describe('cross-project views release the context of each project', () => {
	it('summarizeProjects disposes each project once', async () => {
		await summarizeProjects({ env: sandbox.env });

		expect(probe.disposers).toHaveLength(2);
		for (const dispose of probe.disposers) expect(dispose).toHaveBeenCalledTimes(1);
	});

	it('listTasksAcrossProjects disposes each project once', async () => {
		await listTasksAcrossProjects({ env: sandbox.env });

		expect(probe.disposers).toHaveLength(2);
		for (const dispose of probe.disposers) expect(dispose).toHaveBeenCalledTimes(1);
	});
});
