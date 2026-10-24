import * as fs from 'node:fs';
import * as path from 'node:path';

import { inspectRegisteredProjects } from './projectsHealth.js';
import { ownConfigFile } from './storage.js';
import { resolveProject } from './resolveProject.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

describe('inspectRegisteredProjects', () => {
	let sandbox: SharedRegistrySandbox;

	beforeEach(() => {
		sandbox = createSharedRegistrySandbox();
	});

	afterEach(() => {
		sandbox.cleanup();
	});

	it('is empty when nothing is registered', () => {
		expect(inspectRegisteredProjects({ env: sandbox.env })).toEqual([]);
	});

	it('reports a healthy project, a vanished folder (informational) and an unreadable config', async () => {
		const ok = sandbox.dir('ok');
		await sandbox.register('ok', ok);
		const gone = sandbox.dir('gone');
		await sandbox.register('gone', gone);
		fs.rmSync(gone, { recursive: true });
		const broken = sandbox.dir('broken');
		await sandbox.register('broken', broken);
		const resolved = resolveProject({ cwd: broken, env: sandbox.env });
		fs.mkdirSync(path.dirname(ownConfigFile(resolved.storage)), { recursive: true });
		fs.writeFileSync(ownConfigFile(resolved.storage), 'statuses: [unclosed');

		const [a, b, c] = inspectRegisteredProjects({ env: sandbox.env });

		expect(a).toEqual({ path: path.resolve(ok), exists: true, error: null });
		expect(b).toEqual({ path: path.resolve(gone), exists: false, error: null });
		expect(c).toMatchObject({ path: path.resolve(broken), exists: true });
		expect(c!.error).toContain('config.yml');
	});
});
