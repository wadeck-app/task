// LIVE smoke of the remote strategy through the BUNDLED CLI (dist-bundle/task.cjs). NOT part of `npm test` or CI: run it by hand, in
// steps, so that `task serve` is a real background process of your shell and is stopped by its PID:
//
//   BUNDLE_VERSION=0.0.0-local npm run bundle
//   node scripts/live-remote-smoke.mjs prepare              # isolated registry with A (served), B (client), C (local); prints the serve command
//   <start the printed `serve` command in the background; it prints one JSON line with its url>
//   node scripts/live-remote-smoke.mjs run <world> <url>    # drives the client commands against that url, asserts, prints a summary
//   node scripts/live-remote-smoke.mjs wrong-token <world> <url>   # a client with another token
//   <stop the server by its PID>
//   node scripts/live-remote-smoke.mjs after <world> <url>  # with the server stopped: the unreachable-server messages; then removes the world
//
// Everything runs in a temp world (XDG_CONFIG_HOME, HOME, USERPROFILE point into it, QUEUE_SDK_OFF=1: events are never pushed, they come
// back `dropped`, which is how this script SEES that the server tried to raise them and that the client did not). The real queue, the real
// registry and the real app-core are never touched. The token is only in the environment of the processes started here; it is never printed.
//
// Exit codes: 0 all assertions passed, 1 an assertion failed, 2 the environment or the arguments are wrong (a clear message).
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const bundle = path.join(root, 'packages/task-cli/dist-bundle/task.cjs');
const TOKEN = 'live-remote-smoke-token-0123456789abcdef';

const [, , mode, worldArg, url] = process.argv;

function die(message, code = 2) {
	console.error(`live-remote-smoke: ${message}`);
	process.exit(code);
}

if (!['prepare', 'run', 'wrong-token', 'after'].includes(mode ?? '')) {
	die(
		'usage: node scripts/live-remote-smoke.mjs prepare | run <world file> <url> | wrong-token <world file> <url> | after <world file> <url>'
	);
}
if (!fs.existsSync(bundle)) die(`${bundle} does not exist. Run: BUNDLE_VERSION=0.0.0-local npm run bundle`);

const STATUSES = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
`;

const envOf = (world, token = TOKEN) => ({
	...process.env,
	XDG_CONFIG_HOME: path.join(world.dir, 'xdg'),
	HOME: world.dir,
	USERPROFILE: world.dir,
	QUEUE_SDK_OFF: '1',
	TASK_SMOKE_TOKEN: token,
	TASK_SERVE_TOKEN: TOKEN,
});

if (mode === 'prepare') {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-live-remote-'));
	const registryEnv = { XDG_CONFIG_HOME: path.join(dir, 'xdg') };
	const sdk = await import('@wadeck-app/project-sdk');
	const registryDir = sdk.defaultRegistryDir(registryEnv);
	const projects = {};
	for (const name of ['smoke-a', 'smoke-b', 'smoke-c']) {
		const folder = path.join(dir, 'work', name);
		fs.mkdirSync(folder, { recursive: true });
		const added = await sdk.addProject(registryDir, { name, path: folder });
		const configFolder = sdk.projectToolDir(registryDir, added.id, 'task', 'config');
		fs.mkdirSync(configFolder, { recursive: true });
		fs.writeFileSync(path.join(configFolder, 'config.yml'), STATUSES);
		projects[name] = {
			id: added.id,
			folder,
			configFile: path.join(configFolder, 'config.yml'),
			dataDir: sdk.projectToolDir(registryDir, added.id, 'task', 'data'),
		};
	}
	const worldFile = path.join(dir, 'world.json');
	fs.writeFileSync(worldFile, JSON.stringify({ dir, projects }, null, 2));
	console.log(`world file: ${worldFile}`);
	console.log(`serve from: ${projects['smoke-a'].folder}`);
	console.log(
		`serve env : XDG_CONFIG_HOME=${path.join(dir, 'xdg')} HOME=${dir} USERPROFILE=${dir} QUEUE_SDK_OFF=1 TASK_SERVE_TOKEN=<the smoke token, see TOKEN in this script>`
	);
	console.log(`serve cmd : node ${bundle} serve -p smoke-a --port 0 --json`);
	process.exit(0);
}

const world = JSON.parse(fs.readFileSync(worldArg ?? die('the world file is missing'), 'utf8'));
if (url === undefined) die('the url task serve printed is missing');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
	if (condition) {
		passed++;
		console.log(`  ok    ${name}`);
	} else {
		failed++;
		console.log(`  FAIL  ${name}${detail === '' ? '' : `\n          ${detail.replaceAll('\n', '\n          ')}`}`);
	}
}

/** Runs the bundled CLI as a project of the world. */
function task(project, args, token = TOKEN) {
	const result = spawnSync('node', [bundle, '-p', project, ...args], {
		env: envOf(world, token),
		cwd: world.projects[project].folder,
		encoding: 'utf8',
		timeout: 60_000,
	});
	return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' };
}

const clientConfig = (target, extra = '') => `${STATUSES}strategy:
    type: remote
    options:
${extra}        transport:
            type: plain-http
            options:
                url: ${target}
                tokenEnv: TASK_SMOKE_TOKEN
                timeoutSeconds: 5
`;

const tasksIn = project => {
	const dir = path.join(world.projects[project].dataDir, 'tasks');
	return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
};

const B = 'smoke-b';
const A = 'smoke-a';
const C = 'smoke-c';

if (mode === 'run') {
	fs.writeFileSync(world.projects[B].configFile, clientConfig(url, `        project: ${A}\n`));
	console.log(`client project ${B} -> ${url} (server project ${A})`);

	console.log('\nstrategy');
	const show = task(B, ['strategy', 'show']);
	check(
		'strategy show names the remote plugin and the events row',
		show.code === 0 && /remote/.test(show.out) && /events\s+native\s+server/.test(show.out),
		show.out
	);
	check('strategy show never prints the token', !show.out.includes(TOKEN) && !show.err.includes(TOKEN));
	const checkResult = task(B, ['strategy', 'check']);
	check(
		'strategy check is ok against the live server',
		checkResult.code === 0 && /Result: ok/.test(checkResult.out),
		checkResult.out + checkResult.err
	);
	check(
		'strategy check shows reachable, auth, protocol, project, statuses, events',
		['reachable', 'auth', 'protocol', 'project', 'statuses', 'events'].every(n =>
			new RegExp(`\\n\\s+${n}\\s+ok`).test(checkResult.out)
		),
		checkResult.out
	);

	console.log('\nthe commands, from B');
	const created = task(B, ['new', 'First remote task', '--json']);
	check('new exits 0', created.code === 0, created.out + created.err);
	const first = JSON.parse(created.out).id;
	const second = JSON.parse(task(B, ['new', 'Second remote task', '--json']).out).id;
	check(
		'the task files are in the SERVER project data dir',
		tasksIn(A).length === 2 && tasksIn(A).includes(`${first}.json`)
	);
	check(
		'nothing is in the CLIENT project data dir',
		tasksIn(B).length === 0 && !fs.existsSync(path.join(world.projects[B].dataDir, 'task-index.json'))
	);
	const list = task(B, ['list', '--json']);
	check('list shows both tasks', list.code === 0 && JSON.parse(list.out).length === 2, list.out + list.err);
	const status = task(B, ['set-status', first, 'in-progress']);
	check('set-status exits 0', status.code === 0, status.out + status.err);
	check(
		'show reads the new status back',
		JSON.parse(task(B, ['show', first, '--json']).out).status === 'in-progress'
	);
	const comment = task(B, ['comment', first, 'hello from the other machine', '--author', 'smoke']);
	check('comment exits 0', comment.code === 0, comment.out + comment.err);
	const link = task(B, ['link', second, 'blockedBy', first]);
	check('link exits 0', link.code === 0, link.out + link.err);
	check('the blocker is in the links of the blocked task', /blockedBy/.test(task(B, ['links', second]).out));
	const done = task(B, ['set-status', first, 'done']);
	check('set-status done exits 0 (and unblocks the other task)', done.code === 0, done.out + done.err);
	const stored = JSON.parse(fs.readFileSync(path.join(world.projects[A].dataDir, 'tasks', `${first}.json`), 'utf8'));
	check(
		'the comment and the status are in the server file',
		stored.status === 'done' &&
			stored.comments?.[0]?.text === 'hello from the other machine' &&
			stored.comments[0].author === 'smoke'
	);
	const conflict = task(B, ['set-status', first, 'done']);
	check(
		'a conflict is exit 1 with the local wording',
		conflict.code === 1 && /already in status "done"/.test(conflict.err + conflict.out),
		conflict.out + conflict.err
	);
	const missing = task(B, ['show', 'zzzzzzzz']);
	check(
		'a missing task is exit 1 "Task not found"',
		missing.code === 1 && /Task not found/.test(missing.err + missing.out),
		missing.out + missing.err
	);
	// QUEUE_SDK_OFF=1 makes every delivery `dropped`: the only event warnings the client prints are the ones the SERVER relays ("the server
	// could not deliver"); an event the client raised itself would read "was not delivered" without that phrase, and would show twice.
	const steps = [created, status, comment, link, done];
	const warnings = steps.flatMap(r => r.err.split('\n').filter(line => /event/i.test(line)));
	check(
		'every event warning of the client is relayed from the server (the server raised the events, the client raised none)',
		warnings.length > 0 && warnings.every(line => /but the server could not deliver the event/.test(line)),
		warnings.join('\n')
	);
	const relayed = warnings.map(line => /event (\w+) to its queue/.exec(line)?.[1]);
	check(
		'the server tried to raise exactly the events of the commands, once each, in order',
		JSON.stringify(relayed) ===
			JSON.stringify([
				'onTaskCreated',
				'onStatusChange',
				'onTaskCommentAdded',
				'onTaskLinked',
				'onStatusChange',
				'onTaskUnblocked',
			]),
		JSON.stringify(relayed)
	);

	console.log('\nmigrate: C (local) -> B (remote), then B -> C2 check by listing');
	const seed = task(C, ['new', 'Local one', '--json']);
	const localId = JSON.parse(seed.out).id;
	task(C, ['new', 'Local two', '--parent', localId, '--json']);
	task(C, ['add-label', localId, 'from-local']);
	const dryRun = spawnSync('node', [bundle, 'migrate', '--from', C, '--to', B, '--dry-run'], {
		env: envOf(world),
		cwd: world.dir,
		encoding: 'utf8',
	});
	check(
		'migrate --dry-run local -> remote plans without writing',
		dryRun.status === 0 && tasksIn(A).length === 2,
		dryRun.stdout + dryRun.stderr
	);
	const run = spawnSync('node', [bundle, 'migrate', '--from', C, '--to', B, '--allow-loss', 'all'], {
		env: envOf(world),
		cwd: world.dir,
		encoding: 'utf8',
	});
	check('migrate local -> remote completes', run.status === 0, run.stdout + run.stderr);
	check('the migrated tasks are on the server (2 + 2)', tasksIn(A).length === 4, `found ${tasksIn(A).length}`);
	check(
		'migrate says the summary event is not raised for a remote target',
		/raised by its server/.test(run.stdout + run.stderr),
		run.stdout + run.stderr
	);
	const again = spawnSync('node', [bundle, 'migrate', '--from', C, '--to', B, '--allow-loss', 'all'], {
		env: envOf(world),
		cwd: world.dir,
		encoding: 'utf8',
	});
	check(
		'the same migration again creates nothing',
		again.status === 0 && tasksIn(A).length === 4,
		again.stdout + again.stderr
	);

	console.log('\ndelete');
	const del = task(B, ['delete', second]);
	check(
		'delete exits 0 and removes the file on the server',
		del.code === 0 && !tasksIn(A).includes(`${second}.json`),
		del.out + del.err
	);
	check('the client data dir is still empty', tasksIn(B).length === 0);

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}

if (mode === 'wrong-token') {
	fs.writeFileSync(world.projects[B].configFile, clientConfig(url));
	const wrong = task(B, ['list'], 'another-token-0123456789abcdef');
	check(
		'a wrong token is exit 1 "refused the token" with what to compare',
		wrong.code === 1 &&
			/refused the token/.test(wrong.err + wrong.out) &&
			/started with/.test(wrong.err + wrong.out),
		wrong.out + wrong.err
	);
	check(
		'the token is never printed',
		!(wrong.out + wrong.err).includes('another-token') && !(wrong.out + wrong.err).includes(TOKEN)
	);
	const unset = spawnSync('node', [bundle, '-p', B, 'list'], {
		env: { ...envOf(world), TASK_SMOKE_TOKEN: '' },
		cwd: world.projects[B].folder,
		encoding: 'utf8',
	});
	check(
		'no token on the client is exit 1 naming the variable',
		unset.status === 1 && /TASK_SMOKE_TOKEN is not set/.test(unset.stderr + unset.stdout),
		unset.stdout + unset.stderr
	);
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}

if (mode === 'after') {
	fs.writeFileSync(world.projects[B].configFile, clientConfig(url));
	const list = task(B, ['list']);
	check(
		'a stopped server is exit 1 "Cannot reach" with the address and `task serve`',
		list.code === 1 && /Cannot reach/.test(list.err + list.out) && /task serve/.test(list.err + list.out),
		list.out + list.err
	);
	const checkResult = task(B, ['strategy', 'check']);
	check(
		'strategy check fails on the reachable line with the fix',
		checkResult.code === 1 &&
			/reachable\s+error/.test(checkResult.err + checkResult.out) &&
			/Result: FAILED/.test(checkResult.err + checkResult.out),
		checkResult.out + checkResult.err
	);
	fs.rmSync(world.dir, { recursive: true, force: true });
	console.log(`\nworld removed: ${world.dir}`);
	console.log(`${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}
