import * as fs from 'node:fs';
import * as path from 'node:path';

import { BoardConfigError } from './boardConfig.js';
import { describeProblem, inspectRegisteredProjects } from './projectsHealth.js';
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

		// Importance order: all normal, so by name (broken, gone, ok), not registration order.
		const [c, b, a] = inspectRegisteredProjects({ env: sandbox.env });

		expect(a).toEqual({ path: path.resolve(ok), exists: true, error: null });
		expect(b).toEqual({ path: path.resolve(gone), exists: false, error: null });
		expect(c).toMatchObject({ path: path.resolve(broken), exists: true });
		expect(c!.error).toContain('config.yml');
	});
});

describe('describeProblem', () => {
	it('puts one full stop between a message that already ends with one and its hint', () => {
		const error = new BoardConfigError(
			'config.yml',
			'board.columns[0].statuses[0]',
			'"x" is not a status of this project. Valid statuses: a, b.',
			'Use a name listed under statuses.'
		);

		const text = describeProblem(error);

		expect(text).toContain('Valid statuses: a, b. Use a name listed under statuses.');
		expect(text).not.toContain('..');
	});

	it('adds the full stop when the message has none', () => {
		const error = new BoardConfigError('config.yml', 'board', 'must be a mapping', 'Write columns.');

		expect(describeProblem(error)).toBe('config.yml: board: must be a mapping. Write columns.');
	});
});
