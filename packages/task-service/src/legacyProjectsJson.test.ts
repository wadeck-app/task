// The legacy task-only projects.json is never read since stage 2b-1: only the shared project registry lists projects.
import * as fs from 'node:fs';
import * as path from 'node:path';

import { listKnownProjects } from './knownProjects.js';
import { createSharedRegistrySandbox } from './testHelpers.js';

describe('the legacy projects.json', () => {
	it('is never read: a corrupt one next to the shared registry changes nothing', () => {
		const sandbox = createSharedRegistrySandbox();
		try {
			const configDir = path.join(sandbox.root, 'task-config');
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(path.join(configDir, 'projects.json'), '{ not json');

			expect(listKnownProjects({ env: sandbox.env })).toEqual({ projects: [], registryProblem: null });
		} finally {
			sandbox.cleanup();
		}
	});
});
