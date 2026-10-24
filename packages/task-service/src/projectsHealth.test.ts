import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { inspectRegisteredProjects } from './projectsHealth.js';
import { addLegacyEntry } from './testHelpers.js';

describe('inspectRegisteredProjects', () => {
	let root: string;
	let configDir: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-health-'));
		configDir = path.join(root, 'config');
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('is empty when nothing is registered', () => {
		expect(inspectRegisteredProjects(configDir)).toEqual([]);
	});

	it('reports a healthy project, a missing directory, an uninitialized one and an unreadable config', () => {
		const ok = path.join(root, 'ok');
		fs.mkdirSync(path.join(ok, '.task', 'tasks'), { recursive: true });
		fs.writeFileSync(path.join(ok, '.task', 'config.yml'), 'statuses:\n  - todo\n  - done\n');
		const gone = path.join(root, 'gone');
		const bare = path.join(root, 'bare');
		fs.mkdirSync(bare);
		const broken = path.join(root, 'broken');
		fs.mkdirSync(path.join(broken, '.task', 'tasks'), { recursive: true });
		fs.writeFileSync(path.join(broken, '.task', 'config.yml'), 'statuses: [unclosed');
		for (const dir of [ok, gone, bare, broken]) addLegacyEntry(configDir, dir);

		const [a, b, c, d] = inspectRegisteredProjects(configDir);
		expect(a).toEqual({ path: ok, exists: true, initialized: true, error: null });
		expect(b).toMatchObject({ path: gone, exists: false, initialized: false });
		expect(b!.error).toContain('does not exist');
		expect(c).toMatchObject({ path: bare, exists: true, initialized: false });
		expect(c!.error).toContain('project add');
		expect(d).toMatchObject({ path: broken, exists: true, initialized: true });
		expect(d!.error).toEqual(expect.any(String));
	});
});
