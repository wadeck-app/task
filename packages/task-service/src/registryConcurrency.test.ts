import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildSync } from 'esbuild';

import { listRegisteredProjects, unregisterProject, registerProject } from './projectsRegistry.js';

const PROCESS_COUNT = 10;
const ROUNDS = 3;

let root: string;
let configDir: string;
let bundle: string;

/** Real processes race on the real file: the bundle lets plain node load projectsRegistry.ts (and task-core) without a build. */
beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-registry-race-'));
	configDir = path.join(root, 'config');
	bundle = path.join(root, 'registry.bundle.mjs');
	buildSync({
		entryPoints: [path.resolve(import.meta.dirname, 'projectsRegistry.ts')],
		outfile: bundle,
		bundle: true,
		platform: 'node',
		format: 'esm',
		alias: { '@wadeck-app/task-core': path.resolve(import.meta.dirname, '../../task-core/src/index.ts') },
		logLevel: 'error',
	});
	fs.writeFileSync(
		path.join(root, 'child.mjs'),
		[
			`import { registerProject, unregisterProject } from './registry.bundle.mjs';`,
			`const [action, configDir, dir, startAt] = process.argv.slice(2);`,
			// Spin until the common start time so every process hits the file together.
			`while (Date.now() < Number(startAt)) {}`,
			`try { (action === 'add' ? registerProject : unregisterProject)(configDir, dir); }`,
			`catch (error) { console.error(error.message); process.exit(1); }`,
			'',
		].join('\n')
	);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(() => fs.rmSync(configDir, { recursive: true, force: true }));

/** Runs one `node child.mjs` per directory, all starting at the same instant; rejects with the stderr of any failure. */
async function runTogether(action: 'add' | 'remove', dirs: string[]): Promise<void> {
	const startAt = Date.now() + 1500;
	await Promise.all(
		dirs.map(
			dir =>
				new Promise<void>((resolve, reject) => {
					const child = spawn(
						process.execPath,
						[path.join(root, 'child.mjs'), action, configDir, dir, String(startAt)],
						{ stdio: ['ignore', 'ignore', 'pipe'] }
					);
					let stderr = '';
					child.stderr.on('data', chunk => (stderr += String(chunk)));
					child.on('error', reject);
					child.on('close', code =>
						code === 0 ? resolve() : reject(new Error(`child for ${dir} exited ${code}: ${stderr}`))
					);
				})
		)
	);
}

function projectDirs(round: number): string[] {
	return Array.from({ length: PROCESS_COUNT }, (_, i) => path.join(root, `project-${round}-${i}`));
}

describe('concurrent registry writers (separate processes)', () => {
	it('keeps every entry when many processes register at the same instant', async () => {
		for (let round = 0; round < ROUNDS; round++) {
			fs.rmSync(configDir, { recursive: true, force: true });
			const dirs = projectDirs(round);
			await runTogether('add', dirs);
			expect(listRegisteredProjects(configDir).sort()).toEqual([...dirs].sort());
		}
	}, 60_000);

	it('keeps the other entries when many processes unregister at the same instant', async () => {
		const dirs = projectDirs(0);
		const survivor = path.join(root, 'survivor');
		for (const dir of [...dirs, survivor]) registerProject(configDir, dir);

		await runTogether('remove', dirs);

		expect(listRegisteredProjects(configDir)).toEqual([survivor]);
	}, 60_000);

	it('leaves neither lock nor temporary file behind', async () => {
		await runTogether('add', projectDirs(0));
		expect(fs.readdirSync(configDir).sort()).toEqual(['projects.json']);
		unregisterProject(configDir, projectDirs(0)[0]!);
		expect(fs.readdirSync(configDir).sort()).toEqual(['projects.json']);
	}, 60_000);
});
