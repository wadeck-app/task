// SMOKE of the `migrating` strategy end to end through the BUNDLED CLI: a local project with tasks is migrated in the background to GitHub
// (`task strategy migrate start`, the real detached worker), then finalized, and read back through the plain github strategy; a second
// project is aborted. NOT part of `npm test` or CI: run it by hand.
//
//   BUNDLE_VERSION=0.0.0-local npm run bundle --workspace=packages/task-cli
//   npm run build
//   node scripts/live-migrating-smoke.mjs --mock                        # against the FAKE GitHub server of the tests: no token, no network
//   GH_TEST_TOKEN=<fine-grained token: Issues read/write + Metadata read on the repo> \
//   GH_TEST_REPO=<owner/name of a THROWAWAY repository> \
//   node scripts/live-migrating-smoke.mjs                               # LIVE: the real GitHub API
//
// Options: --tasks <n> (tasks of the finalized project, default 6, at least 4), --timeout <seconds> (wait for the worker, default 120 with
// --mock, 1800 live; it is a rate-limited move: GitHub caps content writes), --keep (leave the temp world in place and print its path).
//
// STATUS OF THIS SCRIPT: written together with phase P4, NEVER RUN LIVE by its author (no token was available), and the mock mode needs the
// bundle to be built first. Treat the first live run as the verification of the whole feature, and read its output before trusting it.
//
// What it does, in an isolated registry (temp XDG_CONFIG_HOME, HOME, USERPROFILE; QUEUE_SDK_OFF=1: no event is pushed), through
// `packages/task-cli/dist-bundle/task.cjs`:
//   1. seeds a LOCAL project (parents, children, a blockedBy link, labels, a type, statuses, a comment) and writes a migrating config:
//      current = local, new = the repository (labels carry the identity block: fills.meta labels);
//   2. `strategy migrate start --dry-run`: asserts the plan and that nothing was written (no state, no issue);
//   3. `strategy migrate start --allow-loss all`: a real background worker; polls `status` until ready-to-finalize (or fails with the log);
//   4. checks GitHub itself (API, or the fake) for one issue per task; `finalize`: asserts the config switch, the backup, the id map, the
//      summary event outcome, that finalizing again changes nothing, and that `task list` now reads the tasks through the github strategy
//      alone while an OLD id no longer resolves (the documented limit);
//   5. a second project: start, wait, `abort` (refused: tasks live in new), `abort --keep-moved`: asserts the project is local again and the
//      issues were NOT closed or deleted;
//   6. cleanup (always, live): every open issue of the run is closed as not_planned and every label the run created is deleted.
//
// Exit codes: 0 all assertions passed, 1 an assertion failed, 2 the environment is not set (a clear message, never a silent skip).
// The token is only read from the environment and passed to the CLI processes started here; it is never printed (every text is redacted).
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const MOCK = args.includes('--mock');
const KEEP = args.includes('--keep');
const option = (name, fallback) => {
	const at = args.indexOf(name);
	if (at === -1) return fallback;
	const value = Number(args[at + 1]);
	if (!Number.isInteger(value) || value < 1) {
		console.error(`live-migrating-smoke: ${name} needs a whole number of at least 1.`);
		process.exit(2);
	}
	return value;
};
const TASKS = option('--tasks', 6);
const TIMEOUT_S = option('--timeout', MOCK ? 120 : 1800);
if (TASKS < 4) {
	console.error(
		'live-migrating-smoke: --tasks must be at least 4 (the seed has a parent, two children and a blocker).'
	);
	process.exit(2);
}

let token = process.env.GH_TEST_TOKEN ?? '';
let repo = process.env.GH_TEST_REPO ?? '';
if (!MOCK) {
	if (token === '' || repo === '') {
		console.error(
			[
				'live-migrating-smoke: GH_TEST_TOKEN and GH_TEST_REPO must both be set (or pass --mock); nothing was run.',
				'  GH_TEST_TOKEN  a fine-grained token with Issues read/write and Metadata read on the repository',
				'  GH_TEST_REPO   owner/name of a THROWAWAY repository',
			].join('\n')
		);
		process.exit(2);
	}
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
		console.error(`live-migrating-smoke: GH_TEST_REPO "${repo}" is not of the form owner/name.`);
		process.exit(2);
	}
}

const root = path.resolve(import.meta.dirname, '..');
const bundle = path.join(root, 'packages/task-cli/dist-bundle/task.cjs');
const serviceDist = path.join(root, 'packages/task-service/dist/index.js');
for (const file of [bundle, serviceDist]) {
	if (!fs.existsSync(file)) {
		console.error(
			`live-migrating-smoke: ${file} does not exist. Run: BUNDLE_VERSION=0.0.0-local npm run bundle --workspace=packages/task-cli, and: npm run build`
		);
		process.exit(2);
	}
}

// ---- the world: registry, home and config in a temp folder; no queue ----
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'task-live-migrating-'));
const redact = text => (token === '' ? String(text) : String(text).split(token).join('***'));
const log = (...parts) => console.log(redact(parts.join(' ')));

let fake;
if (MOCK) {
	const { FakeGitHub } = await import('@wadeck-app/task-service/fakeGitHub');
	fake = await FakeGitHub.start({ repo: 'acme/smoke', searchLagRequests: 0 });
	token = fake.token;
	repo = fake.repo;
}
const baseUrl = MOCK ? fake.baseUrl : 'https://api.github.com';

const env = {
	...process.env,
	XDG_CONFIG_HOME: path.join(world, 'xdg'),
	HOME: world,
	USERPROFILE: world,
	QUEUE_SDK_OFF: '1',
	TASK_SMOKE_TOKEN: token,
};
// A real updater or app-core registration must never start from a smoke run.
const configDir = path.join(world, 'task-config');
fs.mkdirSync(path.join(configDir), { recursive: true });

/** Runs the bundled CLI (async: the fake server of --mock lives in THIS process and must keep answering). */
function task(project, ...cliArgs) {
	return new Promise(resolve => {
		const all = project === undefined ? cliArgs : ['-p', project, ...cliArgs];
		execFile(
			process.execPath,
			[bundle, '--config', configDir, ...all],
			{ cwd: path.join(world, 'work'), env, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 },
			(error, stdout, stderr) => {
				const output = redact(stdout);
				let json;
				try {
					json = JSON.parse(output);
				} catch {
					json = undefined;
				}
				resolve({ exitCode: error === null ? 0 : (error.code ?? 1), output, stderr: redact(stderr), json });
			}
		);
	});
}

// ---- assertions ----
const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok });
	log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || detail === '' ? '' : `\n        ${detail}`}`);
}
const eq = (name, actual, expected) =>
	check(
		name,
		JSON.stringify(actual) === JSON.stringify(expected),
		`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
	);

// ---- GitHub, read directly (the fake answers the same routes) ----
const headers = {
	authorization: `Bearer ${token}`,
	accept: 'application/vnd.github+json',
	'x-github-api-version': '2022-11-28',
	'user-agent': 'task-live-migrating-smoke',
	'content-type': 'application/json',
};
async function api(method, route, body) {
	const response = await fetch(`${baseUrl}${route}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}: ${redact(text).slice(0, 300)}`);
	return text === '' ? undefined : JSON.parse(text);
}
async function apiAll(route) {
	const items = [];
	for (let page = 1; page < 30; page++) {
		const body = await api('GET', `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
		items.push(...body);
		if (body.length < 100) break;
	}
	return items;
}
const runId = Math.random().toString(36).slice(2, 8);
const PREFIX = '[task-api-test]';
const title = text => `${PREFIX} mw ${text} ${runId}`;
const issuesOfRun = async () =>
	(await apiAll(`/repos/${repo}/issues?state=all`)).filter(
		item => item.pull_request === undefined && item.title.startsWith(PREFIX) && item.title.includes(runId)
	);

let preexistingLabels = new Set();
let exitCode = 0;
const started = Date.now();

const STATUSES = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
types:
    - bug
    - feature
`;
const migratingConfig = `${STATUSES}strategy:
    type: migrating
    options:
        budget: { requestsPerMinute: 60 }
        current: { type: local }
        new:
            type: github
            options:
                repo: ${repo}
                baseUrl: ${baseUrl}
                tokenEnv: TASK_SMOKE_TOKEN
                cache: { ttlSeconds: 0 }
                writeSpacingSeconds: ${MOCK ? 0 : 1}
                priorityStorage: label
                fills: { meta: labels }
                statusMap:
                    backlog: { state: open }
                    in-progress: { state: open, label: 'status:in-progress' }
                    done: { state: closed }
`;

async function waitForReady(project, label) {
	const deadline = Date.now() + TIMEOUT_S * 1000;
	let last = '';
	for (;;) {
		const status = await task(project, 'strategy', 'migrate', 'status', '--json');
		const report = status.json ?? {};
		const line = `${report.status ?? '?'} ${report.counts?.moved ?? '?'}/${report.counts?.total ?? '?'} moved, worker ${report.worker?.running ? 'running' : 'not running'}`;
		if (line !== last) log(`    ${label}: ${line}`);
		last = line;
		if (report.status === 'ready-to-finalize') return report;
		if (
			report.status === 'stopped' ||
			(report.status === 'running' && report.worker?.running === false && !report.worker?.starting)
		) {
			const tail = await task(project, 'strategy', 'migrate', 'log', '--tail', '15');
			throw new Error(`${label}: the worker stopped (${line}). Next: ${report.next}\n${tail.output}`);
		}
		if (Date.now() > deadline)
			throw new Error(`${label}: not ready after ${TIMEOUT_S} s (${line}); raise --timeout`);
		await new Promise(resolve => setTimeout(resolve, MOCK ? 300 : 5000));
	}
}

try {
	log(`live-migrating-smoke: ${MOCK ? 'MOCK (fake GitHub)' : `LIVE ${repo}`}, run ${runId}, ${TASKS} tasks`);
	if (!MOCK) {
		preexistingLabels = new Set((await apiAll(`/repos/${repo}/labels`)).map(label => label.name.toLowerCase()));
	}
	const sdk = await import('@wadeck-app/project-sdk');
	const service = await import(pathToFileURL(serviceDist).href);
	Object.assign(process.env, {
		XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
		HOME: world,
		USERPROFILE: world,
		QUEUE_SDK_OFF: '1',
	});
	const registryDir = sdk.defaultRegistryDir(process.env);
	const register = async name => {
		const dir = path.join(world, 'work', name);
		fs.mkdirSync(dir, { recursive: true });
		await sdk.addProject(registryDir, { name, path: dir });
		return service.resolveProject({ cwd: dir, env: process.env });
	};
	const seed = async (resolved, count) => {
		const configFile = service.ownConfigFile(resolved.storage);
		fs.mkdirSync(path.dirname(configFile), { recursive: true });
		fs.writeFileSync(configFile, STATUSES);
		const ctx = service.openResolvedProject(resolved);
		const parent = await ctx.store.create({ title: title(`${resolved.name} parent`), status: 'backlog' });
		const child = await ctx.store.create({
			title: title(`${resolved.name} child`),
			status: 'in-progress',
			parentId: parent.id,
		});
		const blocker = await ctx.store.create({ title: title(`${resolved.name} blocker`), status: 'backlog' });
		const blocked = await ctx.store.create({ title: title(`${resolved.name} blocked`), status: 'backlog' });
		await ctx.store.addLink(blocked.id, 'blockedBy', blocker.id);
		await ctx.store.setType(parent.id, 'feature');
		await ctx.store.addLabel(child.id, 'smoke');
		await ctx.store.addComment(parent.id, 'a note', { author: 'ann' });
		const ids = [parent.id, child.id, blocker.id, blocked.id];
		for (let n = ids.length; n < count; n++) {
			ids.push((await ctx.store.create({ title: title(`${resolved.name} extra ${n}`), status: 'backlog' })).id);
		}
		await ctx.dispose?.();
		fs.writeFileSync(configFile, migratingConfig);
		return { configFile, ids };
	};

	// ================================================================ 1-4. finalize
	log('\n== 1. a local project with tasks and a migrating config');
	const shop = await register('mw-shop');
	const seeded = await seed(shop, TASKS);
	eq('seeded tasks', seeded.ids.length, TASKS);
	const original = fs.readFileSync(seeded.configFile, 'utf8');

	log('\n== 2. start --dry-run');
	const dry = await task('mw-shop', 'strategy', 'migrate', 'start', '--dry-run', '--json');
	eq('dry run: exit 0', dry.exitCode, 0);
	eq('dry run: tasks to move', dry.json?.plan?.tasks, TASKS);
	check('dry run: no state was written', !fs.existsSync(path.join(shop.storage.dataDir, 'migrating', 'state.json')));
	if (MOCK) eq('dry run: the server was not written to', fake.writes().length, 0);
	else eq('dry run: no issue on GitHub', (await issuesOfRun()).length, 0);

	log('\n== 3. start: the real background worker');
	const start = await task('mw-shop', 'strategy', 'migrate', 'start', '--allow-loss', 'all', '--json');
	eq('start: exit 0', start.exitCode, 0);
	check('start: the worker is running', start.json?.worker?.running === true, start.output + start.stderr);
	await waitForReady('mw-shop', 'finalize project');
	const status = await task('mw-shop', 'strategy', 'migrate', 'status');
	log(
		status.output
			.split('\n')
			.map(line => `    ${line}`)
			.join('\n')
	);
	eq(
		'status: ready to finalize, next action names finalize',
		/task strategy migrate finalize/.test(status.output),
		true
	);
	const issues = MOCK ? undefined : await issuesOfRun();
	if (!MOCK) eq('GitHub: one issue per task', issues.length, TASKS);

	log('\n== 4. finalize');
	const early = await task('mw-shop', 'strategy', 'migrate', 'abort', '--json');
	eq('abort without --keep-moved is refused while tasks live in new', early.exitCode, 1);
	check('the refusal names --keep-moved', /--keep-moved/.test(early.output), early.output);
	eq('the config is untouched by the refused abort', fs.readFileSync(seeded.configFile, 'utf8'), original);
	const fin = await task('mw-shop', 'strategy', 'migrate', 'finalize', '--json');
	eq('finalize: exit 0', fin.exitCode, 0);
	eq('finalize: outcome', fin.json?.outcome, 'finished');
	eq('finalize: every task moved', fin.json?.moved, TASKS);
	const switched = fs.readFileSync(seeded.configFile, 'utf8');
	check(
		'config.yml now has the github strategy',
		/type: github/.test(switched) && !/type: migrating/.test(switched),
		switched
	);
	eq('the old config is kept', fs.readFileSync(`${seeded.configFile}.before-migration`, 'utf8'), original);
	const idMap = JSON.parse(fs.readFileSync(path.join(shop.storage.dataDir, 'migrating', 'idmap.json'), 'utf8'));
	eq('id map: one entry per task', idMap.map(entry => entry.from).sort(), [...seeded.ids].sort());
	const again = await task('mw-shop', 'strategy', 'migrate', 'finalize', '--json');
	eq('finalize again: already finished, exit 0', [again.exitCode, again.json?.outcome], [0, 'already-finished']);
	const listed = await task('mw-shop', 'list', '--json');
	eq(
		'the project lists every task through the github strategy alone',
		Array.isArray(listed.json) ? listed.json.length : listed.output,
		TASKS
	);
	const oldId = seeded.ids[0];
	const oldShow = await task('mw-shop', 'show', oldId, '--json');
	eq('an OLD id no longer resolves (documented limit)', oldShow.exitCode, 1);
	const newShow = await task('mw-shop', 'show', idMap.find(entry => entry.from === oldId).to, '--json');
	eq('the id of the id map does', newShow.exitCode, 0);
	if (!MOCK) {
		eq(
			'GitHub: nothing was closed by finalize',
			(await issuesOfRun()).filter(item => item.state === 'closed').length,
			0
		);
	}

	// ================================================================ 5. abort
	log('\n== 5. a second project: abort');
	const spare = await register('mw-spare');
	const second = await seed(spare, 4);
	await task('mw-spare', 'strategy', 'migrate', 'start', '--allow-loss', 'all', '--json');
	await waitForReady('mw-spare', 'abort project');
	const writesBefore = MOCK ? fake.writes().length : (await issuesOfRun()).length;
	const kept = await task('mw-spare', 'strategy', 'migrate', 'abort', '--keep-moved', '--json');
	eq('abort --keep-moved: exit 0', kept.exitCode, 0);
	eq('abort --keep-moved: every moved task is listed', kept.json?.moved?.length, 4);
	check(
		'abort: the warning says they left the project',
		/no longer part of this project/.test((kept.json?.warnings ?? []).join(' '))
	);
	check(
		'the config of the aborted project is local again',
		!/migrating/.test(fs.readFileSync(second.configFile, 'utf8'))
	);
	eq('the aborted project lists its 4 tasks again', (await task('mw-spare', 'list', '--json')).json?.length, 4);
	if (MOCK) eq('abort wrote nothing to the server', fake.writes().length, writesBefore);
	else eq('abort closed no issue', (await issuesOfRun()).filter(item => item.state === 'closed').length, 0);
	eq(
		'abort again: already aborted, exit 0',
		(await task('mw-spare', 'strategy', 'migrate', 'abort', '--json')).json?.outcome,
		'already-aborted'
	);
} catch (error) {
	exitCode = 1;
	log(`\nlive-migrating-smoke: FAILED with an exception: ${error instanceof Error ? error.stack : error}`);
} finally {
	// ---------------------------------------------------------------- cleanup (always)
	log('\n== 6. cleanup');
	if (MOCK) {
		await fake.stop();
	} else {
		let closed = 0;
		try {
			for (const item of await issuesOfRun()) {
				if (item.state === 'closed') continue;
				try {
					await api('PATCH', `/repos/${repo}/issues/${item.number}`, {
						state: 'closed',
						state_reason: 'not_planned',
					});
					closed += 1;
				} catch (error) {
					exitCode = 1;
					log(`  could not close #${item.number}: ${error.message}`);
				}
			}
		} catch (error) {
			exitCode = 1;
			log(`  could not list the issues: ${error.message}`);
		}
		let deleted = 0;
		try {
			for (const label of await apiAll(`/repos/${repo}/labels`)) {
				if (preexistingLabels.has(label.name.toLowerCase())) continue;
				try {
					await api('DELETE', `/repos/${repo}/labels/${encodeURIComponent(label.name)}`);
					deleted += 1;
				} catch (error) {
					exitCode = 1;
					log(`  could not delete the label ${label.name}: ${error.message}`);
				}
			}
		} catch (error) {
			exitCode = 1;
			log(`  could not list the labels: ${error.message}`);
		}
		log(`  closed ${closed} issue(s) of this run as not_planned, deleted ${deleted} label(s) the run created`);
	}
	log(`\n  total ${Math.round((Date.now() - started) / 1000)} s`);
	if (KEEP) log(`  the world is kept: ${world}`);
	else fs.rmSync(world, { recursive: true, force: true });
}

const failed = results.filter(result => !result.ok);
log(
	`\nlive-migrating-smoke: ${results.length - failed.length} of ${results.length} assertions passed${failed.length > 0 ? `; FAILED: ${failed.map(f => f.name).join(' | ')}` : ''}`
);
process.exit(failed.length > 0 ? 1 : exitCode);
