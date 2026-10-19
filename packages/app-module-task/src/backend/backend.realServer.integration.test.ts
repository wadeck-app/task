import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { TaskStore } from '@wadeck-app/task-core';
import { registerProject } from '@wadeck-app/task-service';

/**
 * Builds the module with `app-core-cli package` and serves the result through a REAL app-core server
 * (`app-core-cli dev` boots app-core's own buildServer), then calls the routes over HTTP. backend.test.ts calls
 * the handlers directly, so it cannot see how the router fills `req.params`/`req.query`/`req.body`, nor whether
 * the packaged CJS bundle (task-core + task-service inlined) loads and runs.
 *
 * Only event-free mutations (labels, meta, type, parent, types, delete) and rejected requests are sent over HTTP: a
 * mutation that produces events (create, status, link, unlink) would run the REAL queue sink (`queue push`) on the
 * developer's machine, and the sink cannot be injected into a packaged server. Event delivery is covered in
 * backend.test.ts with a fake sink.
 */

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER_START_TIMEOUT_MS = 30_000;
const PACKAGE_TIMEOUT_MS = 60_000;

const cliPackageJson = createRequire(import.meta.url).resolve('@wadeck-app/app-core-cli/package.json');
const cliEntry = join(dirname(cliPackageJson), 'dist/cli.bundle.js');

let child: ChildProcess | undefined;
let workDir: string;
let projectDir: string;
let baseUrl: string;
let taskId: string;

/** `app-core-cli package` into a folder outside the module (check refuses any other folder at the module root). */
function packageModule(out: string): void {
	try {
		execFileSync(
			process.execPath,
			[cliEntry, 'package', packageDir, '--out', out, '--version', '0.0.0-test-real-server'],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PACKAGE_TIMEOUT_MS, windowsHide: true }
		);
	} catch (err) {
		const failure = err as { stdout?: string; stderr?: string };
		throw new Error(`app-core-cli package failed:\n${failure.stdout ?? ''}${failure.stderr ?? ''}`);
	}
}

function startServer(builtModule: string, xdgConfigHome: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = '';
		const timer = setTimeout(
			() =>
				reject(
					new Error(
						`app-core-cli dev did not print its URL within ${SERVER_START_TIMEOUT_MS} ms. Output so far:\n${output}`
					)
				),
			SERVER_START_TIMEOUT_MS
		);
		// node + the CLI file, no shell: child.kill() reaches the real server process
		child = spawn(process.execPath, [cliEntry, 'dev', builtModule], {
			windowsHide: true,
			// Port 0: a free port, never the developer's real app-core on 4850.
			// XDG_CONFIG_HOME: the module reads <xdg>/task/projects.json, so the fixture registry, not the real one.
			env: { ...process.env, APP_CORE_PORT: '0', XDG_CONFIG_HOME: xdgConfigHome },
		});
		const onData = (chunk: Buffer): void => {
			output += chunk.toString();
			const match = /app-core-cli dev: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
			if (match) {
				clearTimeout(timer);
				resolve(match[1]!);
			}
		};
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);
		child.on('error', err => {
			clearTimeout(timer);
			reject(err);
		});
		child.on('exit', code => {
			clearTimeout(timer);
			reject(new Error(`app-core-cli dev exited early (code ${code}). Output:\n${output}`));
		});
	});
}

describe('the packaged module through a real app-core server', () => {
	beforeAll(
		async () => {
			workDir = mkdtempSync(join(tmpdir(), 'app-module-task-real-server-'));
			const xdg = join(workDir, 'xdg');
			projectDir = join(workDir, 'proj');
			mkdirSync(join(projectDir, '.task', 'tasks'), { recursive: true });
			writeFileSync(join(projectDir, '.task', 'config.yml'), 'statuses:\n  - backlog\n  - done\n');
			taskId = new TaskStore(join(projectDir, '.task', 'tasks')).create(
				'seeded over the filesystem',
				'backlog'
			).id;
			registerProject(join(xdg, 'task'), projectDir);
			const builtModule = join(workDir, 'module');
			packageModule(builtModule);
			baseUrl = await startServer(builtModule, xdg);
		},
		SERVER_START_TIMEOUT_MS + PACKAGE_TIMEOUT_MS + 5_000
	);

	afterAll(() => {
		child?.kill();
		rmSync(workDir, { recursive: true, force: true });
	});

	async function call(
		method: string,
		path: string,
		body?: unknown
	): Promise<{ status: number; body: Record<string, any> }> {
		const response = await fetch(`${baseUrl}/api/modules/task${path}`, {
			method,
			...(body === undefined
				? {}
				: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
		});
		return { status: response.status, body: (await response.json()) as Record<string, any> };
	}

	const q = (): string => `project=${encodeURIComponent(projectDir)}`;

	it('GET /projects lists the fixture project', async () => {
		const { status, body } = await call('GET', '/projects');
		expect(status).toBe(200);
		expect(body['projects']).toEqual([
			{
				name: 'proj',
				path: projectDir,
				exists: true,
				initialized: true,
				openCount: 1,
				error: null,
				href: `/modules/task/tasks?project=${encodeURIComponent(projectDir)}`,
			},
		]);
	});

	it('GET /tasks reads ?project from the real query string and returns the seeded task', async () => {
		const { status, body } = await call('GET', `/tasks?${q()}`);
		expect(status).toBe(200);
		expect(body['tasks'].map((t: { id: string }) => t.id)).toEqual([taskId]);
	});

	it('GET /tasks without ?project uses the only registered project', async () => {
		const { status, body } = await call('GET', '/tasks');
		expect(status).toBe(200);
		expect(body['project']).toEqual({ name: 'proj', path: projectDir });
	});

	it('GET /tasks/:id hands the real id param (by prefix) to the handler', async () => {
		const { status, body } = await call('GET', `/tasks/${taskId.slice(0, 8)}?${q()}`);
		expect(status).toBe(200);
		expect(body['task']['id']).toBe(taskId);
	});

	it('GET /tasks/:id answers 404 naming the unknown id (not "undefined")', async () => {
		const { status, body } = await call('GET', `/tasks/nope?${q()}`);
		expect(status).toBe(404);
		expect(body['error']).toBe('Task not found: nope');
	});

	it('GET /summary counts the seeded task', async () => {
		const { status, body } = await call('GET', '/summary');
		expect(status).toBe(200);
		expect(body).toMatchObject({ scope: 'all', open: 1, total: 1, skipped: [] });
	});

	it('an unregistered project is a 404 with the task init fix', async () => {
		const { status, body } = await call('GET', `/tasks?project=${encodeURIComponent(join(workDir, 'elsewhere'))}`);
		expect(status).toBe(404);
		expect(body['hint']).toContain('task init');
	});

	it('POST /tasks with an invalid body is a 400 (the JSON body reaches the handler), creating nothing', async () => {
		const { status, body } = await call('POST', `/tasks?${q()}`, { description: '' });
		expect(status).toBe(400);
		expect(body['hint']).toContain('description');
	});

	it('POST /tasks/:id/status with an unknown status is a 400 with the valid ones', async () => {
		const { status, body } = await call('POST', `/tasks/${taskId}/status?${q()}`, { status: 'dnoe' });
		expect(status).toBe(400);
		expect(body['validStatuses']).toEqual(['backlog', 'done']);
		expect(body['suggestions']).toEqual(['done']);
	});

	it('POST then DELETE a label: body, id param and the URL-decoded :label param all arrive', async () => {
		const added = await call('POST', `/tasks/${taskId}/labels?${q()}`, { label: 'needs review' });
		expect(added.status).toBe(200);
		expect(added.body['task']['labels']).toEqual(['needs review']);
		const removed = await call('DELETE', `/tasks/${taskId}/labels/${encodeURIComponent('needs review')}?${q()}`);
		expect(removed.status).toBe(200);
		expect(removed.body['task']['labels'] ?? []).toEqual([]);
	});

	it('DELETE /tasks/:id/links reads type and target from the real query string (409: no such link)', async () => {
		const { status, body } = await call('DELETE', `/tasks/${taskId}/links?${q()}&type=blockedBy&target=${taskId}`);
		expect(status).toBe(409);
		expect(body['error']).toContain('is not blockedBy');
	});

	describe('hierarchy, links, types, meta and delete (event-free routes)', () => {
		let childId: string;

		beforeAll(() => {
			childId = new TaskStore(join(projectDir, '.task', 'tasks')).create('child seeded', 'backlog').id;
		});

		it('POST /tasks/:id/parent reads the id param and the JSON body, then GET /tree, /children and /ancestors show it', async () => {
			const set = await call('POST', `/tasks/${childId}/parent?${q()}`, { parent: taskId.slice(0, 8) });
			expect(set.status).toBe(200);
			expect(set.body['task']['parentId']).toBe(taskId);

			const tree = await call('GET', `/tree?${q()}`);
			expect(tree.status).toBe(200);
			expect(tree.body['rows'].map((r: { id: string; depth: number }) => [r.id, r.depth])).toEqual([
				[taskId, 0],
				[childId, 1],
			]);

			const children = await call('GET', `/tasks/${taskId}/children?${q()}&recursive=true`);
			expect(children.body['children'][0]).toMatchObject({ id: childId, children: [] });

			const ancestors = await call('GET', `/tasks/${childId}/ancestors?${q()}`);
			expect(ancestors.body['ancestors'].map((a: { id: string }) => a.id)).toEqual([taskId]);
		});

		it('GET /tasks/:id/links answers the (empty) link rows of a task', async () => {
			const { status, body } = await call('GET', `/tasks/${childId}/links?${q()}`);
			expect(status).toBe(200);
			expect(body).toMatchObject({ id: childId, rows: [] });
		});

		it('types: POST adds, GET lists, POST /tasks/:id/type validates against them, DELETE removes (and 404s on a typo)', async () => {
			expect((await call('POST', `/types?${q()}`, { name: 'bug' })).body['types']).toEqual(['bug']);
			expect((await call('GET', `/types?${q()}`)).body['rows']).toEqual([{ name: 'bug' }]);
			const bad = await call('POST', `/tasks/${childId}/type?${q()}`, { type: 'bugg' });
			expect(bad.status).toBe(400);
			const good = await call('POST', `/tasks/${childId}/type?${q()}`, { type: 'bug' });
			expect(good.body['task']['type']).toBe('bug');
			const typo = await call('DELETE', `/types/bugg?${q()}`);
			expect(typo.status).toBe(404);
			const removed = await call('DELETE', `/types/bug?${q()}`);
			expect(removed.body['types']).toEqual([]);
		});

		it('POST /tasks/:id/meta then GET /tasks/:id shows the metadata rows', async () => {
			const set = await call('POST', `/tasks/${childId}/meta?${q()}`, { key: 'owner', value: 'ann' });
			expect(set.status).toBe(200);
			const detail = await call('GET', `/tasks/${childId}?${q()}`);
			expect(detail.body['metaRows']).toEqual([{ key: 'owner', value: 'ann' }]);
		});

		it('POST /tasks/delete/plan previews, and POST /tasks/delete without confirm deletes nothing (400 with the plan)', async () => {
			const plan = await call('POST', `/tasks/delete/plan?${q()}`, { ids: [childId] });
			expect(plan.status).toBe(200);
			expect(plan.body).toMatchObject({ count: 1 });
			const refused = await call('POST', `/tasks/delete?${q()}`, { ids: [childId] });
			expect(refused.status).toBe(400);
			expect(refused.body['plan']).toMatchObject({ count: 1 });
			const still = await call('GET', `/tasks/${childId}?${q()}`);
			expect(still.status).toBe(200);
		});

		it('POST /tasks/delete with confirm:true deletes the child (the static /tasks/delete wins over /tasks/:id)', async () => {
			const done = await call('POST', `/tasks/delete?${q()}`, { ids: [childId], confirm: true });
			expect(done.status).toBe(200);
			expect(done.body['deletedCount']).toBe(1);
			expect((await call('GET', `/tasks/${childId}?${q()}`)).status).toBe(404);
		});
	});
});
