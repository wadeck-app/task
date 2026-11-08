// LIVE smoke run of the github strategy against the real GitHub API. NOT part of `npm test` or CI: run it by hand.
//
//   npm run build
//   GH_TEST_TOKEN=<fine-grained token: Issues read/write + Metadata read on the repo> \
//   GH_TEST_REPO=wadeck-app/temp-test-api-for-issues \
//   node scripts/live-github-smoke.mjs
//
// The strategy is READ-ONLY, so task creates no data: the script seeds a few issues, labels, sub-issues, dependencies and comments
// through the official REST API with the token (every title starts with "[task-api-test]"), runs the service and CLI reads
// against them in an isolated registry (temp XDG_CONFIG_HOME, queue off), asserts the mapped results, then CLOSES the seeded issues
// (not_planned) and deletes the labels it created. Cleanup runs on failure too.
//
// Exit codes: 0 all assertions passed, 1 an assertion failed, 2 the environment is not set (a clear message, never a silent skip).
// The token is only read from the environment; it is never printed, written or logged (every text is redacted before output).
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
			'live-github-smoke: GH_TEST_TOKEN and GH_TEST_REPO must both be set; nothing was run.',
			'  GH_TEST_TOKEN  a fine-grained token with Issues read/write and Metadata read on the repository',
			'  GH_TEST_REPO   owner/name of a THROWAWAY repository (for example wadeck-app/temp-test-api-for-issues)',
		].join('\n')
	);
	process.exit(2);
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
	console.error(`live-github-smoke: GH_TEST_REPO "${repo}" is not of the form owner/name.`);
	process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..');
const distFiles = {
	service: path.join(root, 'packages/task-service/dist/index.js'),
	cli: path.join(root, 'packages/task-cli/dist/TaskIndex.js'),
};
for (const [name, file] of Object.entries(distFiles)) {
	if (!fs.existsSync(file)) {
		console.error(`live-github-smoke: ${file} does not exist (the ${name} is not built). Run: npm run build`);
		process.exit(2);
	}
}

// ---- an isolated world: registry, config dir and home in a temp folder; no queue ----
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'task-live-smoke-'));
process.env.XDG_CONFIG_HOME = path.join(world, 'xdg');
process.env['HOME'] = world;
process.env['USERPROFILE'] = world;
process.env.QUEUE_SDK_OFF = '1';

const redact = text => String(text).split(token).join('***');
const log = (...parts) => console.log(redact(parts.join(' ')));

// ---- the seeding client: official REST API, nothing but fetch ----
const API = 'https://api.github.com';
const headers = {
	authorization: `Bearer ${token}`,
	accept: 'application/vnd.github+json',
	'x-github-api-version': '2022-11-28',
	'user-agent': 'task-live-smoke',
	'content-type': 'application/json',
};
const timings = new Map();
let seedCalls = 0;

async function api(method, route, body, { allow = [] } = {}) {
	const started = performance.now();
	const response = await fetch(`${API}${route}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	const ms = performance.now() - started;
	seedCalls += 1;
	const key = `${method} ${route.replace(/\d+/g, 'N').replace(/\?.*/, '')}`;
	timings.set(key, [...(timings.get(key) ?? []), ms]);
	if (!response.ok && !allow.includes(response.status)) {
		throw new Error(`${method} ${route} -> ${response.status}: ${redact(text).slice(0, 300)}`);
	}
	return { status: response.status, body: text === '' ? undefined : JSON.parse(text), headers: response.headers };
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

const readTimings = [];
async function timed(name, run) {
	const started = performance.now();
	try {
		return await run();
	} finally {
		readTimings.push([name, performance.now() - started]);
	}
}

const run = Math.random().toString(36).slice(2, 8);
const PREFIX = '[task-api-test]';
const seeded = []; // issue numbers to close
const createdLabels = []; // label names to delete
let rateAtStart;
let exitCode = 0;

try {
	log(`live-github-smoke: repository ${repo}, run ${run}`);
	rateAtStart = (await api('GET', '/rate_limit')).body.resources;

	// ---------------------------------------------------------------- seed
	log('\n== seeding through the official REST API');
	const wantedLabels = [
		['status:in-progress', '0e8a16', 'task: status in progress'],
		['type:bug', 'd73a4a', 'task: type bug'],
		['smoke:billing', 'ededed', 'task smoke run label'],
	];
	for (const [name, color, description] of wantedLabels) {
		const existing = await api('GET', `/repos/${repo}/labels/${encodeURIComponent(name)}`, undefined, {
			allow: [404],
		});
		if (existing.status === 404) {
			await api('POST', `/repos/${repo}/labels`, { name, color, description });
			createdLabels.push(name);
		}
	}
	const issue = async (title, extra = {}) => {
		const created = (await api('POST', `/repos/${repo}/issues`, { title: `${PREFIX} ${title} ${run}`, ...extra }))
			.body;
		seeded.push(created.number);
		return created;
	};
	const A = await issue('smoke parent', {
		body: 'Parent body for the smoke run',
		labels: ['smoke:billing', 'status:in-progress', 'type:bug'],
	});
	const B = await issue('smoke child one');
	const C = await issue('smoke child two');
	const D = await issue('smoke grandchild');
	const E = await issue('smoke blocker');
	const F = await issue('smoke cancelled');
	const G = await issue('smoke duplicate', {
		body: `Real text\n\n<!-- task:begin v1 -->{"links":[{"type":"duplicateOf","target":"PENDING"}]}<!-- task:end -->`,
	});
	const word = `zxqsmoke${run}`;
	const H = await issue(`searchable ${word}`);
	await api('POST', `/repos/${repo}/issues/${A.number}/sub_issues`, { sub_issue_id: B.id });
	await api('POST', `/repos/${repo}/issues/${A.number}/sub_issues`, { sub_issue_id: C.id });
	await api('POST', `/repos/${repo}/issues/${B.number}/sub_issues`, { sub_issue_id: D.id });
	await api('POST', `/repos/${repo}/issues/${B.number}/dependencies/blocked_by`, { issue_id: E.id });
	await api('POST', `/repos/${repo}/issues/${D.number}/comments`, { body: 'first note' });
	await api('POST', `/repos/${repo}/issues/${D.number}/comments`, { body: 'second note' });
	await api('PATCH', `/repos/${repo}/issues/${C.number}`, { state: 'closed', state_reason: 'completed' });
	await api('PATCH', `/repos/${repo}/issues/${F.number}`, { state: 'closed', state_reason: 'not_planned' });
	await api('PATCH', `/repos/${repo}/issues/${G.number}`, {
		body: `Real text\n\n<!-- task:begin v1 -->{"links":[{"type":"duplicateOf","target":"${E.number}"}]}<!-- task:end -->`,
	});
	await api('PATCH', `/repos/${repo}/issues/${A.number}`, { title: `${PREFIX} smoke parent renamed ${run}` });
	await api('POST', `/repos/${repo}/issues/${B.number}/labels`, { labels: ['status:in-progress'] });
	await api('DELETE', `/repos/${repo}/issues/${B.number}/labels/${encodeURIComponent('status:in-progress')}`);
	log(`seeded issues ${seeded.join(', ')}`);

	// ---------------------------------------------------------------- the project: registry + config
	const sdk = await import('@wadeck-app/project-sdk');
	const service = await import(pathToFileURL(distFiles.service).href);
	const cli = await import(pathToFileURL(distFiles.cli).href);
	const projectDir = path.join(world, 'work', 'smoke');
	fs.mkdirSync(projectDir, { recursive: true });
	const registryDir = sdk.defaultRegistryDir(process.env);
	await sdk.addProject(registryDir, { name: 'smoke', path: projectDir });
	const resolved = service.resolveProject({ cwd: projectDir, env: process.env });
	const configFile = service.ownConfigFile(resolved.storage);
	fs.mkdirSync(path.dirname(configFile), { recursive: true });
	fs.writeFileSync(
		configFile,
		`statuses:
    - backlog
    - in-progress
    - { name: done, terminal: true }
    - { name: cancelled, terminal: true, outcome: negative }
strategy:
    type: github
    options:
        repo: ${repo}
        tokenEnv: GH_TEST_TOKEN
        cache: { ttlSeconds: 0 }
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status:in-progress' }
            done: { state: closed }
            cancelled: { state: closed, reason: not_planned }
`
	);
	const ctx = () => service.openResolvedProject(resolved);
	const id = n => String(n);

	// ---------------------------------------------------------------- strategy check
	log('\n== task strategy check');
	const checked = await timed('strategy check', () =>
		service.checkStrategy({
			storage: resolved.storage,
			project: { id: resolved.id, name: resolved.name, path: resolved.path },
			env: process.env,
		})
	);
	for (const line of checked.lines)
		log(
			`  ${line.name.padEnd(13)} ${line.status.padEnd(5)} ${line.text}${line.fix ? `\n  ${' '.repeat(19)}fix: ${line.fix}` : ''}`
		);
	check('strategy check has no error', checked.ok, `${checked.errors} error(s)`);

	// ---------------------------------------------------------------- reads through the service
	log('\n== reads through the service');
	const c1 = ctx();
	const all = await timed('list (all, cold cache)', () => service.listTasks(c1, { showAll: true }));
	const byId = new Map(all.map(task => [task.id, task]));
	for (const [label, issue_, status] of [
		['A', A, 'in-progress'],
		['B', B, 'backlog'],
		['C', C, 'done'],
		['D', D, 'backlog'],
		['E', E, 'backlog'],
		['F', F, 'cancelled'],
		['G', G, 'backlog'],
		['H', H, 'backlog'],
	]) {
		eq(`list: #${issue_.number} (${label}) is ${status}`, byId.get(id(issue_.number))?.status, status);
	}
	eq('list: the parent of B is A', byId.get(id(B.number))?.parentId, id(A.number));

	const shownA = await timed('show A (record: issue + timeline + comments)', () => c1.store.get(id(A.number)));
	eq(
		'show A: created with its status label, so its history starts in that status',
		shownA.history.map(h => h.status),
		['in-progress']
	);
	eq('show A: type', shownA.type, 'bug');
	eq('show A: labels hide status and type labels', shownA.labels, ['smoke:billing']);
	eq('show A: description', shownA.description, 'Parent body for the smoke run');
	check('show A: title follows the rename', shownA.title.includes('renamed'), shownA.title);
	const kindsA = (shownA.activity ?? []).map(entry => entry.kind);
	check(
		'show A: activity has the rename and two sub-tasks',
		kindsA.includes('title') && kindsA.filter(k => k === 'child-added').length === 2,
		JSON.stringify(kindsA)
	);
	check(
		'show A: revision looks like <updated_at>#<etag>',
		/^\d{4}-.*Z#[0-9a-f]+$/.test(shownA.revision),
		shownA.revision
	);

	const shownB = await timed('show B', () => c1.store.get(id(B.number)));
	eq('show B: parent', shownB.parentId, id(A.number));
	eq('show B: links', shownB.links, [{ type: 'blockedBy', target: id(E.number) }]);
	eq(
		'show B: history passed through in-progress and back',
		shownB.history.map(h => h.status),
		['backlog', 'in-progress', 'backlog']
	);

	const shownD = await timed('show D (2 comments)', () => c1.store.get(id(D.number)));
	eq(
		'show D: comments',
		(shownD.comments ?? []).map(c => c.text),
		['first note', 'second note']
	);

	const children = await timed('children A', () => c1.store.getChildren(id(A.number)));
	eq('children of A', children.map(t => t.id).sort(), [id(B.number), id(C.number)].sort());
	const tree = await timed('full tree of D', () => c1.store.getFullTree(id(D.number)));
	eq('full tree of D is rooted at A', tree.id, id(A.number));
	const ancestors = await timed('ancestors of D', () => c1.store.getAncestors(id(D.number)));
	eq(
		'ancestors of D',
		ancestors.map(t => t.id),
		[id(B.number), id(A.number)]
	);
	const linksB = await timed('links B', () => c1.store.getLinks(id(B.number)));
	eq(
		'B is blocked by E',
		linksB.blockedBy.map(t => t.id),
		[id(E.number)]
	);
	eq(
		'E blocks B',
		(await c1.store.getLinks(id(E.number))).blocks.map(t => t.id),
		[id(B.number)]
	);
	const linksG = await c1.store.getLinks(id(G.number));
	eq(
		'G is a duplicate of E (from the managed block)',
		linksG.duplicateOf.map(t => t.id),
		[id(E.number)]
	);
	check('G description hides the block', (await c1.store.get(id(G.number))).description === 'Real text');
	const labels = await timed('labels', () => service.listLabels(c1));
	check(
		'labels count smoke:billing once',
		labels.some(l => l.label === 'smoke:billing' && l.count === 1),
		JSON.stringify(labels)
	);
	const activity = await timed('history --all A', () => service.getTaskActivity(c1, { id: id(A.number) }));
	check(
		'activity rows are readable sentences',
		activity.rows.length >= 3 && activity.rows.every(row => row.text !== ''),
		JSON.stringify(activity.rows.map(r => r.text))
	);
	const found = await timed('find', () => service.searchTasks(c1, { q: 'smoke parent' }));
	check(
		'find locates the parent from the list',
		found.some(hit => hit.id === id(A.number)),
		JSON.stringify(found.map(h => h.id))
	);

	// native search: the index lags behind a write (about 7 s measured), so poll
	log('\n== native search (not read-your-writes)');
	let searchHit = false;
	let waited = 0;
	for (let attempt = 0; attempt < 20 && !searchHit; attempt++) {
		const page = await c1.store.listPage({ text: word });
		searchHit = page.items.some(t => t.id === id(H.number));
		if (!searchHit) {
			await new Promise(r => setTimeout(r, 3000));
			waited += 3;
		}
	}
	check(`search finds the new issue (waited about ${waited} s for the index)`, searchHit);
	await c1.dispose();

	// ---------------------------------------------------------------- conditional requests
	log('\n== conditional requests (ETag / 304) and the quota');
	const beforeCore = (await api('GET', '/rate_limit')).body.resources.core.remaining;
	const c2 = ctx();
	await timed('list (second run, 304s)', () => service.listTasks(c2, { showAll: true }));
	await c2.dispose();
	const afterCore = (await api('GET', '/rate_limit')).body.resources.core.remaining;
	check('a second list costs no quota (304)', afterCore >= beforeCore - 1, `remaining ${beforeCore} -> ${afterCore}`);
	check(
		'the cache folder exists in the project data and holds no token',
		(() => {
			const dir = path.join(resolved.storage.dataDir, 'cache', 'github');
			const files = fs.readdirSync(dir);
			return (
				files.length > 0 && files.every(file => !fs.readFileSync(path.join(dir, file), 'utf8').includes(token))
			);
		})()
	);

	// ---------------------------------------------------------------- the CLI entry
	log('\n== reads and writes through the CLI entry (runTaskCommand)');
	const cliRun = async (...args) => {
		const started = performance.now();
		const result = await cli.runTaskCommand(args, projectDir);
		readTimings.push([`task ${args.slice(0, 2).join(' ')}`, performance.now() - started]);
		return result;
	};
	const cliList = await cliRun('list', '--all', '--json');
	check('task list --all --json exits 0', cliList.exitCode === 0, cliList.output.slice(0, 200));
	check(
		'task list shows the seeded issues',
		JSON.parse(cliList.output).some(t => t.id === id(A.number))
	);
	const cliShow = await cliRun('show', id(B.number), '--json');
	check(
		'task show B --json',
		cliShow.exitCode === 0 && JSON.parse(cliShow.output).parentId === id(A.number),
		cliShow.output.slice(0, 200)
	);
	const cliTree = await cliRun('tree', id(D.number));
	check(
		'task tree D',
		cliTree.exitCode === 0 && JSON.parse(cliTree.output).id === id(A.number),
		cliTree.output.slice(0, 200)
	);
	const cliLinks = await cliRun('links', id(B.number));
	check(
		'task links B',
		cliLinks.exitCode === 0 && JSON.parse(cliLinks.output).blockedBy.length === 1,
		cliLinks.output.slice(0, 200)
	);
	const cliComments = await cliRun('comments', id(D.number));
	check(
		'task comments D',
		cliComments.exitCode === 0 && cliComments.output.includes('second note'),
		cliComments.output.slice(0, 200)
	);
	const cliHistory = await cliRun('history', id(A.number), '--all');
	check(
		'task history A --all',
		cliHistory.exitCode === 0 && cliHistory.output.includes('Title edited'),
		cliHistory.output.slice(0, 300)
	);
	const cliFind = await cliRun('find', 'searchable');
	check('task find', cliFind.exitCode === 0 && cliFind.output.includes(id(H.number)), cliFind.output.slice(0, 200));
	const cliLabels = await cliRun('labels', '--json');
	check('task labels', cliLabels.exitCode === 0, cliLabels.output.slice(0, 200));
	const cliStatus = await cliRun('status', 'list');
	check('task status list', cliStatus.exitCode === 0 && cliStatus.output.includes('cancelled'), cliStatus.output);
	const cliCheck = await cliRun('strategy', 'check');
	check(
		'task strategy check',
		cliCheck.exitCode === 0 && cliCheck.output.includes('Result: ok'),
		cliCheck.output.slice(-400)
	);
	const write = await cliRun('set-status', id(A.number), 'done');
	check(
		'a write exits 1 with the stage-1 hint',
		write.exitCode === 1 && write.output.includes('read-only in this version (stage 1'),
		write.output.slice(0, 300)
	);
	const created = await cliRun('new', 'must not be created');
	check('task new exits 1', created.exitCode === 1);
	const stillOpen = await api('GET', `/repos/${repo}/issues/${A.number}`);
	check('the write did not reach GitHub (A is still open)', stillOpen.body.state === 'open');

	// ---------------------------------------------------------------- fidelity probes: what the real server sends
	log('\n== what the real server sent (to keep the fake server faithful)');
	const probe = async (n, kinds) => {
		const events = (await api('GET', `/repos/${repo}/issues/${n}/timeline?per_page=100`)).body;
		for (const kind of kinds) {
			const event = events.find(e => e.event === kind);
			log(`  timeline ${kind}: ${event === undefined ? 'not seen' : Object.keys(event).sort().join(', ')}`);
			if (event !== undefined) {
				for (const key of ['sub_issue', 'parent_issue', 'blocked_by', 'blocking', 'issue_type']) {
					if (event[key] !== undefined)
						log(
							`    ${key}: ${Object.keys(event[key]).sort().join(', ')}${event[key].repository ? ' (repository: ' + Object.keys(event[key].repository).slice(0, 6).join(', ') + ')' : ''}`
						);
				}
			}
		}
	};
	await probe(A.number, ['labeled', 'renamed', 'sub_issue_added']);
	await probe(B.number, ['parent_issue_added', 'blocked_by_added', 'labeled', 'unlabeled']);
	await probe(E.number, ['blocking_added']);
	await probe(C.number, ['closed']);
	const issueJson = (await api('GET', `/repos/${repo}/issues/${B.number}`)).body;
	log(`  issue keys: ${Object.keys(issueJson).sort().join(', ')}`);
	log(`  issue_dependencies_summary: ${JSON.stringify(issueJson.issue_dependencies_summary)}`);
	log(
		`  sub_issues_summary of A: ${JSON.stringify((await api('GET', `/repos/${repo}/issues/${A.number}`)).body.sub_issues_summary)}`
	);
} catch (error) {
	exitCode = 1;
	log(`\nlive-github-smoke: FAILED with an exception: ${error instanceof Error ? error.stack : error}`);
} finally {
	// ---------------------------------------------------------------- cleanup (always)
	log('\n== cleanup');
	for (const number of seeded) {
		try {
			await api('PATCH', `/repos/${repo}/issues/${number}`, { state: 'closed', state_reason: 'not_planned' });
		} catch (error) {
			exitCode = 1;
			log(`  could not close #${number}: ${error.message}`);
		}
	}
	for (const name of createdLabels) {
		try {
			await api('DELETE', `/repos/${repo}/labels/${encodeURIComponent(name)}`);
		} catch (error) {
			exitCode = 1;
			log(`  could not delete the label ${name}: ${error.message}`);
		}
	}
	log(
		`  closed ${seeded.length} seeded issue(s) as not_planned, deleted ${createdLabels.length} label(s) it created`
	);
	try {
		const rate = (await api('GET', '/rate_limit')).body.resources;
		if (rateAtStart !== undefined) {
			log(
				`\n== rate limit: core ${rateAtStart.core.remaining} -> ${rate.core.remaining} (${rateAtStart.core.remaining - rate.core.remaining} spent by the whole run, seeding and cleanup included), search ${rateAtStart.search.remaining} -> ${rate.search.remaining}`
			);
		}
	} catch {
		/* the summary is informational */
	}
	const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
	log('\n== latencies of the reads (ms)');
	for (const [name, ms] of readTimings) log(`  ${String(Math.round(ms)).padStart(6)}  ${name}`);
	log('\n== latency of the seeding calls (median ms, count)');
	for (const [name, values] of [...timings].sort())
		log(`  ${String(Math.round(median(values))).padStart(6)}  x${String(values.length).padStart(2)}  ${name}`);
	fs.rmSync(world, { recursive: true, force: true });
}

const failed = results.filter(r => !r.ok);
log(
	`\nlive-github-smoke: ${results.length - failed.length} of ${results.length} assertions passed${failed.length > 0 ? `; FAILED: ${failed.map(f => f.name).join(' | ')}` : ''}`
);
process.exit(failed.length > 0 ? 1 : exitCode);
