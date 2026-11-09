// LIVE run of `task migrate` against the real GitHub API. NOT part of `npm test` or CI: run it by hand.
//
//   npm run build
//   GH_TEST_TOKEN=<fine-grained token: Issues read/write + Metadata read on the repo> \
//   GH_TEST_REPO=wadeck-app/temp-test-api-for-issues \
//   node scripts/live-github-migrate.mjs
//
// What it does, in an isolated registry (temp XDG_CONFIG_HOME, queue off), through the CLI entry of task (runTaskCommand):
//   1. seeds a small LOCAL project (parents, children, a grandchild, blockedBy / duplicateOf / causedBy links, labels, a label GitHub refuses,
//      type, metadata, comments with authors, a done and a cancelled task);
//   2. `task migrate --dry-run` into a second project whose strategy is the real repository: asserts it sends no request that changes anything;
//   3. the plan is BLOCKED by its losses, then runs with them allowed: asserts the issues, parents, dependencies, labels, close reasons and
//      comments on GitHub itself (the API read directly), and the read-back of the run;
//   4. runs the same migration again: asserts it creates nothing and sends no write;
//   5. migrates BACK, from GitHub into a third LOCAL project, and compares every task with the first one;
//   6. cleanup (always): every open issue of the run is CLOSED as not_planned and every label the run created is deleted; asserts both.
//
// Exit codes: 0 all assertions passed, 1 an assertion failed, 2 the environment is not set (a clear message, never a silent skip).
// The token is only read from the environment (GH_TEST_TOKEN, also the tokenEnv of the project config); it is never printed, written or
// logged (every text is redacted before output). It is used against api.github.com for the one repository named by GH_TEST_REPO.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const token = process.env.GH_TEST_TOKEN ?? '';
const repo = process.env.GH_TEST_REPO ?? '';
if (token === '' || repo === '') {
	console.error(
		[
			'live-github-migrate: GH_TEST_TOKEN and GH_TEST_REPO must both be set; nothing was run.',
			'  GH_TEST_TOKEN  a fine-grained token with Issues read/write and Metadata read on the repository',
			'  GH_TEST_REPO   owner/name of a THROWAWAY repository (for example wadeck-app/temp-test-api-for-issues)',
		].join('\n')
	);
	process.exit(2);
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
	console.error(`live-github-migrate: GH_TEST_REPO "${repo}" is not of the form owner/name.`);
	process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..');
const distFiles = {
	service: path.join(root, 'packages/task-service/dist/index.js'),
	cli: path.join(root, 'packages/task-cli/dist/TaskIndex.js'),
};
for (const [name, file] of Object.entries(distFiles)) {
	if (!fs.existsSync(file)) {
		console.error(`live-github-migrate: ${file} does not exist (the ${name} is not built). Run: npm run build`);
		process.exit(2);
	}
}

// ---- an isolated world: registry, config dir and home in a temp folder; no queue ----
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'task-live-migrate-'));
process.env.XDG_CONFIG_HOME = path.join(world, 'xdg');
process.env['HOME'] = world;
process.env['USERPROFILE'] = world;
process.env.QUEUE_SDK_OFF = '1';

const redact = text => String(text).split(token).join('***');
const log = (...parts) => console.log(redact(parts.join(' ')));

// ---- every request of the run goes through this counter: the migration, the CLI and the checks all use the global fetch ----
const requests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
	const method = (init?.method ?? 'GET').toUpperCase();
	const url = typeof input === 'string' ? input : (input?.url ?? String(input));
	requests.push({ method, url: url.replace(/^https?:\/\/[^/]+/, '') });
	return realFetch(input, init);
};
/** The requests other than GET made since `mark` (a GraphQL query is a POST, but none is sent by a migration). */
const writesSince = mark => requests.slice(mark).filter(request => request.method !== 'GET');

const API = 'https://api.github.com';
const headers = {
	authorization: `Bearer ${token}`,
	accept: 'application/vnd.github+json',
	'x-github-api-version': '2022-11-28',
	'user-agent': 'task-live-migrate',
	'content-type': 'application/json',
};
async function api(method, route, body, { allow = [] } = {}) {
	const response = await fetch(`${API}${route}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok && !allow.includes(response.status)) {
		throw new Error(`${method} ${route} -> ${response.status}: ${redact(text).slice(0, 300)}`);
	}
	return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}
async function apiAll(route) {
	const items = [];
	for (let page = 1; page < 30; page++) {
		const { body } = await api('GET', `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
		items.push(...body);
		if (body.length < 100) break;
	}
	return items;
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

const run = Math.random().toString(36).slice(2, 8);
const PREFIX = '[task-api-test]';
const title = text => `${PREFIX} mig ${text} ${run}`;
let preexistingLabels = new Set();
let rateAtStart;
let exitCode = 0;
const started = performance.now();

try {
	log(`live-github-migrate: repository ${repo}, run ${run}`);
	rateAtStart = (await api('GET', '/rate_limit')).body.resources;
	preexistingLabels = new Set((await apiAll(`/repos/${repo}/labels`)).map(label => label.name.toLowerCase()));
	const repoInfo = (await api('GET', `/repos/${repo}`)).body;
	log(`token permissions on the repository: ${JSON.stringify(repoInfo.permissions)}`);

	// ================================================================ the projects
	const sdk = await import('@wadeck-app/project-sdk');
	const service = await import(pathToFileURL(distFiles.service).href);
	const cli = await import(pathToFileURL(distFiles.cli).href);
	const registryDir = sdk.defaultRegistryDir(process.env);
	const resolveProject = async name => {
		const dir = path.join(world, 'work', name);
		fs.mkdirSync(dir, { recursive: true });
		await sdk.addProject(registryDir, { name, path: dir });
		return service.resolveProject({ cwd: dir, env: process.env });
	};
	const STATUSES = `statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
    - { name: cancelled, terminal: true, outcome: negative }
    - { name: duplicate, terminal: true, outcome: negative }
types:
    - bug
    - feature
`;
	const writeConfig = (resolved, extra = '') => {
		const file = service.ownConfigFile(resolved.storage);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, STATUSES + extra);
	};
	const local = await resolveProject('mig-local');
	const hub = await resolveProject('mig-github');
	const back = await resolveProject('mig-back');
	writeConfig(local);
	writeConfig(back);
	// Metadata goes in labels meta:key=value (exact, allowed under strict): the marker of a migrated task fits (35 characters).
	writeConfig(
		hub,
		`strategy:
    type: github
    options:
        repo: ${repo}
        tokenEnv: GH_TEST_TOKEN
        cache: { ttlSeconds: 0 }
        fills:
            meta: labels
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status:in-progress' }
            done: { state: closed }
            cancelled: { state: closed, reason: not_planned }
            duplicate: { state: closed, reason: duplicate }
`
	);

	// ================================================================ 1. seed the local project
	log('\n== 1. seeding the local project');
	const ctx = service.openResolvedProject(local);
	const make = async (name, status = 'backlog', parent) =>
		(
			await ctx.store.create({
				title: title(name),
				status,
				...(parent === undefined ? {} : { parentId: parent }),
			})
		).id;
	const P = await make('parent');
	const C1 = await make('child one', 'backlog', P);
	const C2 = await make('child two', 'backlog', P);
	const G = await make('grandchild', 'backlog', C1);
	const B = await make('blocker');
	const D = await make('shipped');
	const X = await make('cancelled');
	await ctx.store.updateStatus(C2, 'in-progress');
	await ctx.store.updateStatus(D, 'done');
	await ctx.store.updateStatus(X, 'cancelled');
	await ctx.store.setType(P, 'feature');
	await ctx.store.setType(C1, 'bug');
	await ctx.store.addLabel(P, 'smoke-planning');
	await ctx.store.addLabel(P, 'smoke-q4');
	await ctx.store.addLabel(C1, 'x'.repeat(60));
	await ctx.store.setMeta(C1, 'owner', 'ann');
	await ctx.store.setDescription(C2, 'A description\nover two lines');
	await ctx.store.addLink(C2, 'blockedBy', C1);
	await ctx.store.addLink(G, 'blockedBy', B);
	await ctx.store.addLink(X, 'duplicateOf', D);
	await ctx.store.addLink(G, 'causedBy', B);
	await ctx.store.addComment(P, 'First note', { author: 'ann' });
	await ctx.store.addComment(P, 'Second note', { author: 'bob' });
	await ctx.store.addComment(D, 'Shipped without a fuss');
	await ctx.dispose?.();
	const seeded = new Map([
		[P, 'parent'],
		[C1, 'child one'],
		[C2, 'child two'],
		[G, 'grandchild'],
		[B, 'blocker'],
		[D, 'shipped'],
		[X, 'cancelled'],
	]);
	log(`seeded ${seeded.size} local tasks`);

	const cliRun = async (...args) => {
		const result = await cli.runTaskCommand(args, world);
		return {
			...result,
			json: (() => {
				try {
					return JSON.parse(result.output);
				} catch {
					return undefined;
				}
			})(),
		};
	};
	const lossKinds = [...'history created-at links:duplicateOf links:causedBy labels'.split(' ')];
	const allow = lossKinds.join(',');

	// ================================================================ 2. dry run
	log('\n== 2. dry run (no request that changes anything)');
	let mark = requests.length;
	const dry = await cliRun('migrate', '--from', 'mig-local', '--to', 'mig-github', '--dry-run', '--json');
	eq('dry run: exit 0', dry.exitCode, 0);
	eq('dry run: status', dry.json?.status, 'dry-run');
	eq('dry run: would create 7', dry.json?.counts?.created, 7);
	eq('dry run: the blocking kinds', [...(dry.json?.blocking ?? [])].sort(), [...lossKinds].sort());
	eq('dry run: no request other than GET', writesSince(mark), []);
	eq(
		'dry run: nothing on GitHub',
		(await apiAll(`/repos/${repo}/issues?state=all`)).filter(i => i.title.includes(run)).length,
		0
	);
	log(`  estimate: ${JSON.stringify(dry.json?.estimate)}`);
	const dryText = await cliRun('migrate', '--from', 'mig-local', '--to', 'mig-github', '--dry-run');
	log(
		dryText.output
			.split('\n')
			.map(line => `    | ${line}`)
			.join('\n')
	);

	// ================================================================ 3. blocked, then the real run
	log('\n== 3. the plan is blocked by its losses, then runs once they are allowed');
	mark = requests.length;
	const blocked = await cliRun('migrate', '--from', 'mig-local', '--to', 'mig-github', '--json');
	eq('blocked: exit 1', blocked.exitCode, 1);
	eq('blocked: status', blocked.json?.status, 'blocked');
	eq('blocked: no request other than GET', writesSince(mark), []);

	mark = requests.length;
	const t0 = performance.now();
	const real = await cliRun('migrate', '--from', 'mig-local', '--to', 'mig-github', '--allow-loss', allow, '--json');
	const seconds = Math.round((performance.now() - t0) / 1000);
	log(
		`  the run took ${seconds} s and ${requests.length - mark} requests (${writesSince(mark).length} of them writes)`
	);
	eq('run: exit 0', real.exitCode, 0);
	eq('run: status', real.json?.status, 'completed');
	eq('run: created 7', real.json?.counts?.created, 7);
	eq('run: the read-back found no difference', real.json?.verification?.mismatches, []);
	if (real.exitCode !== 0) log(redact(real.output).slice(0, 3000));
	log(
		`  estimate was ${JSON.stringify(dry.json?.estimate)}; actual ${seconds} s, ${requests.length - mark} requests`
	);

	// ---- what GitHub holds, read directly
	log('\n== 3b. what GitHub holds');
	const issues = (await apiAll(`/repos/${repo}/issues?state=all`)).filter(
		i => i.pull_request === undefined && i.title.startsWith(PREFIX) && i.title.includes(run)
	);
	const byName = new Map(
		issues.map(issue => [issue.title.replace(`${PREFIX} mig `, '').replace(` ${run}`, ''), issue])
	);
	eq('github: seven issues', issues.length, 7);
	const num = name => byName.get(name)?.number;
	const allLabelsOf = name => (byName.get(name)?.labels ?? []).map(label => label.name).sort();
	const labelsOf = name => allLabelsOf(name).filter(label => !label.startsWith('meta:migratedFrom='));
	eq(
		'parent: labels (status and type are labels too)',
		labelsOf('parent'),
		['smoke-planning', 'smoke-q4', 'type:feature'].sort()
	);
	eq(
		'child one: type, metadata in labels, the 60-character label refused',
		labelsOf('child one'),
		['meta:owner=ann', 'type:bug'].sort()
	);
	check(
		'child one: the marker is in a label',
		allLabelsOf('child one').some(l => l.startsWith('meta:migratedFrom=')),
		JSON.stringify(labelsOf('child one'))
	);
	check(
		'child two: in progress',
		labelsOf('child two').includes('status:in-progress'),
		JSON.stringify(labelsOf('child two'))
	);
	eq(
		'shipped: closed as completed',
		[byName.get('shipped')?.state, byName.get('shipped')?.state_reason],
		['closed', 'completed']
	);
	eq(
		'cancelled: closed as not planned',
		[byName.get('cancelled')?.state, byName.get('cancelled')?.state_reason],
		['closed', 'not_planned']
	);
	eq('child two: body is the description', byName.get('child two')?.body, 'A description\nover two lines');
	const parentUrl = name => byName.get(name)?.parent_issue_url?.split('/').pop();
	eq('child one: parent', parentUrl('child one'), String(num('parent')));
	eq('child two: parent', parentUrl('child two'), String(num('parent')));
	eq('grandchild: parent', parentUrl('grandchild'), String(num('child one')));
	const blockedBy = async name =>
		(await api('GET', `/repos/${repo}/issues/${num(name)}/dependencies/blocked_by`)).body.map(i => i.number).sort();
	eq('child two: blocked by child one', await blockedBy('child two'), [num('child one')]);
	eq('grandchild: blocked by the blocker', await blockedBy('grandchild'), [num('blocker')]);
	const commentsOf = async name => (await apiAll(`/repos/${repo}/issues/${num(name)}/comments`)).map(c => c.body);
	const parentComments = await commentsOf('parent');
	eq(
		'parent: two comments, in order',
		parentComments.map(body => body.split('\n').pop()),
		['First note', 'Second note']
	);
	check(
		'parent: the first line of a comment has the original time, the author and the marker',
		/^Originally posted \d{4}-\d{2}-\d{2}T[\d:.]+Z by ann \[migrated from [0-9a-f]{8}\/\w{8}#\w+\]/.test(
			parentComments[0] ?? ''
		),
		parentComments[0]
	);
	eq('shipped: one comment', (await commentsOf('shipped')).length, 1);

	// ================================================================ 4. the same migration again
	log('\n== 4. the same migration again');
	mark = requests.length;
	const again = await cliRun('migrate', '--from', 'mig-local', '--to', 'mig-github', '--allow-loss', allow, '--json');
	eq('again: exit 0', again.exitCode, 0);
	eq('again: created 0, skipped 7', [again.json?.counts?.created, again.json?.counts?.skipped], [0, 7]);
	eq('again: no request other than GET', writesSince(mark), []);
	eq(
		'again: still seven issues',
		(await apiAll(`/repos/${repo}/issues?state=all`)).filter(i => i.title.includes(run)).length,
		7
	);

	// ================================================================ 5. back to a local project
	log('\n== 5. migrating back: GitHub into a third local project');
	// The whole repository is migrated back (older issues of the throwaway repository included), except the tombstoned ones task hides.
	const repoIssueCount = (await apiAll(`/repos/${repo}/issues?state=all`)).filter(
		i => i.pull_request === undefined && !(i.labels ?? []).some(label => label.name === 'task:deleted')
	).length;
	log(`  the repository holds ${repoIssueCount} issue(s) that task lists`);
	const backDry = await cliRun('migrate', '--from', 'mig-github', '--to', 'mig-back', '--dry-run', '--json');
	log(`  blocking kinds back: ${JSON.stringify(backDry.json?.blocking)}`);
	eq('back dry run: exit 0', backDry.exitCode, 0);
	const backRun = await cliRun(
		'migrate',
		'--from',
		'mig-github',
		'--to',
		'mig-back',
		'--allow-loss',
		'all',
		'--json'
	);
	if (backRun.exitCode !== 0) log(redact(backRun.output).slice(0, 3000));
	eq('back: exit 0', backRun.exitCode, 0);
	eq('back: one task per issue of the repository', backRun.json?.counts?.created, repoIssueCount);
	eq('back: the read-back found no difference', backRun.json?.verification?.mismatches, []);

	const original = service.openResolvedProject(local);
	const copy = service.openResolvedProject(back);
	const titled = async c => {
		const records = await Promise.all((await c.store.list()).map(summary => c.store.get(summary.id)));
		return new Map(records.map(record => [record.title, record]));
	};
	const a = await titled(original);
	const b = await titled(copy);
	eq('back: one task per issue of the repository, in the copy', b.size, repoIssueCount);
	const nameOf = (map, id) => [...map.values()].find(record => record.id === id)?.title;
	for (const name of seeded.values()) {
		const t = title(name);
		const x = a.get(t);
		const y = b.get(t);
		if (x === undefined || y === undefined) {
			check(`back: ${name} exists in both`, false, `${x === undefined} ${y === undefined}`);
			continue;
		}
		eq(`back: ${name}: status`, y.status, x.status);
		eq(`back: ${name}: type`, y.type, x.type);
		eq(
			`back: ${name}: parent`,
			y.parentId === undefined ? undefined : nameOf(b, y.parentId),
			x.parentId === undefined ? undefined : nameOf(a, x.parentId)
		);
		eq(`back: ${name}: description`, y.description, x.description);
		eq(
			`back: ${name}: blockedBy`,
			(y.links ?? [])
				.filter(l => l.type === 'blockedBy')
				.map(l => nameOf(b, l.target))
				.sort(),
			(x.links ?? [])
				.filter(l => l.type === 'blockedBy')
				.map(l => nameOf(a, l.target))
				.sort()
		);
		eq(
			`back: ${name}: comment texts`,
			(y.comments ?? []).map(c => c.text.split('\n').pop()),
			(x.comments ?? []).map(c => c.text.split('\n').pop())
		);
		const ownMeta = record =>
			Object.fromEntries(Object.entries(record.meta ?? {}).filter(([key]) => key !== 'migratedFrom'));
		eq(`back: ${name}: metadata (the marker aside)`, ownMeta(y), ownMeta(x));
		eq(
			`back: ${name}: labels (the refused one is gone)`,
			[...(y.labels ?? [])].sort(),
			(x.labels ?? []).filter(l => l.length <= 50).sort()
		);
	}
	await original.dispose?.();
	await copy.dispose?.();

	log('\n== 5b. migrating back again');
	const backAgain = await cliRun(
		'migrate',
		'--from',
		'mig-github',
		'--to',
		'mig-back',
		'--allow-loss',
		'all',
		'--json'
	);
	eq(
		'back again: created 0, all skipped',
		[backAgain.json?.counts?.created, backAgain.json?.counts?.skipped],
		[0, repoIssueCount]
	);
} catch (error) {
	exitCode = 1;
	log(`\nlive-github-migrate: FAILED with an exception: ${error instanceof Error ? error.stack : error}`);
} finally {
	// ---------------------------------------------------------------- cleanup (always)
	log('\n== 6. cleanup');
	let closed = 0;
	try {
		// The issue LIST lags a change by seconds (measured): every issue of the run is listed whatever its state, then read by number.
		const all = await apiAll(`/repos/${repo}/issues?state=all`);
		for (const item of all.filter(
			i => i.pull_request === undefined && i.title.startsWith(PREFIX) && i.title.includes(run)
		)) {
			try {
				if ((await api('GET', `/repos/${repo}/issues/${item.number}`)).body.state === 'closed') continue;
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
		log(`  could not list the open issues: ${error.message}`);
	}
	let deletedLabels = 0;
	try {
		for (const label of await apiAll(`/repos/${repo}/labels`)) {
			if (preexistingLabels.has(label.name.toLowerCase())) continue;
			try {
				await api('DELETE', `/repos/${repo}/labels/${encodeURIComponent(label.name)}`);
				deletedLabels += 1;
			} catch (error) {
				exitCode = 1;
				log(`  could not delete the label ${label.name}: ${error.message}`);
			}
		}
	} catch (error) {
		exitCode = 1;
		log(`  could not list the labels: ${error.message}`);
	}
	log(
		`  closed ${closed} open issue(s) of this run as not_planned, deleted ${deletedLabels} label(s) the run created (existing labels untouched)`
	);
	try {
		// The issue LIST lags a change by seconds (measured), so each issue of the run is read by number.
		const ofRun = (await apiAll(`/repos/${repo}/issues?state=all`)).filter(
			i => i.pull_request === undefined && i.title.startsWith(PREFIX) && i.title.includes(run)
		);
		const stillOpen = [];
		for (const item of ofRun) {
			if ((await api('GET', `/repos/${repo}/issues/${item.number}`)).body.state !== 'closed')
				stillOpen.push(item);
		}
		check(
			'cleanup: no issue of the run is left open',
			stillOpen.length === 0,
			stillOpen.map(i => `#${i.number}`).join(', ')
		);
		const labelsNow = new Set((await apiAll(`/repos/${repo}/labels`)).map(label => label.name.toLowerCase()));
		const leftover = [...labelsNow].filter(name => !preexistingLabels.has(name));
		check('cleanup: no label of the run is left', leftover.length === 0, leftover.join(', '));
		const rate = (await api('GET', '/rate_limit')).body.resources;
		if (rateAtStart !== undefined) {
			log(
				`\n== rate limit: core ${rateAtStart.core.remaining} -> ${rate.core.remaining} (${rateAtStart.core.remaining - rate.core.remaining} spent by the whole run)`
			);
		}
	} catch (error) {
		exitCode = 1;
		log(`  could not verify the cleanup: ${error.message}`);
	}
	log(`\n  total ${Math.round((performance.now() - started) / 1000)} s, ${requests.length} requests`);
	fs.rmSync(world, { recursive: true, force: true });
}

const failed = results.filter(r => !r.ok);
log(
	`\nlive-github-migrate: ${results.length - failed.length} of ${results.length} assertions passed${failed.length > 0 ? `; FAILED: ${failed.map(f => f.name).join(' | ')}` : ''}`
);
process.exit(failed.length > 0 ? 1 : exitCode);
