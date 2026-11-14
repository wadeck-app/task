// LIVE smoke run of the github strategy against the real GitHub API. NOT part of `npm test` or CI: run it by hand.
//
//   npm run build
//   GH_TEST_TOKEN=<fine-grained token: Issues read/write + Metadata read on the repo> \
//   GH_TEST_REPO=wadeck-app/temp-test-api-for-issues \
//   node scripts/live-github-smoke.mjs
//
// Phase 1 (reads): seeds a few issues, labels, sub-issues, a dependency and comments through the official REST API with the token
// (every title starts with "[task-api-test]"), runs the service and CLI reads against them in an isolated registry (temp
// XDG_CONFIG_HOME, queue off) and asserts the mapped results.
// Phase 2 (writes): exercises EVERY write of the strategy through the real code (service and CLI entry) on issues the strategy
// creates itself -- create (also in a terminal status), status, title, description, type, labels, meta (labels, then body block),
// parent, blockedBy and duplicateOf links, comments, expectedRevision, labels sync, tombstone and hard deletion -- and checks what
// GitHub holds after each, with the API read directly. It also prints what the real server answered where the fake server models it.
// Cleanup (always, also on failure): every issue of this run is CLOSED as not_planned (a hard-deleted one is gone) and every label
// the run created is deleted; labels that existed before are left alone.
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

async function api(method, route, body, { allow = [] } = {}) {
	const started = performance.now();
	const response = await fetch(`${API}${route}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	const ms = performance.now() - started;
	const key = `${method} ${route.replace(/\d+/g, 'N').replace(/\?.*/, '')}`;
	timings.set(key, [...(timings.get(key) ?? []), ms]);
	if (!response.ok && !allow.includes(response.status)) {
		throw new Error(`${method} ${route} -> ${response.status}: ${redact(text).slice(0, 300)}`);
	}
	return { status: response.status, body: text === '' ? undefined : JSON.parse(text), headers: response.headers };
}

/** Every item of a paginated list. */
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

// Every request of the run goes through this counter (the seeding client and the strategy both use the global fetch).
let requestCount = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
	requestCount += 1;
	return realFetch(...args);
};

const readTimings = [];
const writeTimings = [];
async function timed(name, run, into = readTimings) {
	const started = performance.now();
	const requests = requestCount;
	try {
		return await run();
	} finally {
		into.push([name, performance.now() - started, requestCount - requests]);
	}
}

const run = Math.random().toString(36).slice(2, 8);
const PREFIX = '[task-api-test]';
const title = text => `${PREFIX} ${text} ${run}`;
let preexistingLabels = new Set();
let rateAtStart;
let exitCode = 0;

try {
	log(`live-github-smoke: repository ${repo}, run ${run}`);
	rateAtStart = (await api('GET', '/rate_limit')).body.resources;
	preexistingLabels = new Set((await apiAll(`/repos/${repo}/labels`)).map(label => label.name.toLowerCase()));
	const repoInfo = (await api('GET', `/repos/${repo}`)).body;
	log(`token permissions on the repository: ${JSON.stringify(repoInfo.permissions)}`);

	// ================================================================ phase 1: reads
	log('\n== phase 1: seeding through the official REST API');
	const wantedLabels = [
		['status:in-progress', '0e8a16', 'task: status in progress'],
		['type:bug', 'd73a4a', 'task: type bug'],
		['smoke:billing', 'ededed', 'task smoke run label'],
	];
	for (const [name, color, description] of wantedLabels) {
		if (!preexistingLabels.has(name)) await api('POST', `/repos/${repo}/labels`, { name, color, description });
	}
	const issue = async (text, extra = {}) =>
		(await api('POST', `/repos/${repo}/issues`, { title: title(text), ...extra })).body;
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
	await api('PATCH', `/repos/${repo}/issues/${A.number}`, { title: title(`smoke parent renamed ${word}`) });
	await api('POST', `/repos/${repo}/issues/${B.number}/labels`, { labels: ['status:in-progress'] });
	// The history groups the events of a second: two changes a person makes must be further apart than that to read as two.
	await new Promise(resolve => setTimeout(resolve, 2500));
	await api('DELETE', `/repos/${repo}/issues/${B.number}/labels/${encodeURIComponent('status:in-progress')}`);
	log(`seeded issues ${[A, B, C, D, E, F, G, H].map(i => i.number).join(', ')}`);

	// ---- the project: registry + config
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
	const STATUSES_YAML = `statuses:
    - backlog
    - in-progress
    - review
    - { name: done, terminal: true }
    - { name: cancelled, terminal: true, outcome: negative }
    - { name: duplicate, terminal: true, outcome: negative }
types:
    - bug
    - feature
`;
	const STRATEGY_YAML = (top, options) => `${top}strategy:
    type: github
${options}`;
	const BASE_OPTIONS = `    options:
        repo: ${repo}
        tokenEnv: GH_TEST_TOKEN
        cache: { ttlSeconds: 0 }
        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: 'status:in-progress' }
            review: { state: open, label: 'status:review' }
            done: { state: closed }
            cancelled: { state: closed, reason: not_planned }
            duplicate: { state: closed, reason: duplicate }
`;
	const writeConfig = (fidelity, extra) =>
		fs.writeFileSync(
			configFile,
			STRATEGY_YAML(`${STATUSES_YAML}`, `    fidelity: ${fidelity}\n${BASE_OPTIONS}${extra}`)
		);
	// phase 1 reads: the mapping of the seeded statuses has no review/duplicate in use, which is fine
	writeConfig('strict', '');
	const ctx = () => service.openResolvedProject(resolved);
	const id = n => String(n);

	// ---- strategy check
	log('\n== task strategy check');
	const target = {
		storage: resolved.storage,
		project: { id: resolved.id, name: resolved.name, path: resolved.path },
		env: process.env,
	};
	const checked = await timed('strategy check', () => service.checkStrategy(target));
	for (const line of checked.lines)
		log(
			`  ${line.name.padEnd(13)} ${line.status.padEnd(5)} ${line.text}${line.fix ? `\n  ${' '.repeat(19)}fix: ${line.fix}` : ''}`
		);
	check('strategy check has no error', checked.ok, `${checked.errors} error(s)`);
	const writesLine = checked.lines.find(line => line.name === 'writes');
	check(
		'strategy check: writes line is ok (the token can write)',
		writesLine?.status === 'ok',
		JSON.stringify(writesLine)
	);

	// ---- reads through the service
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
		'show A: revision is <updated_at>#<etag>#<one hash per part>',
		/^\d{4}-.*Z#[0-9a-f]+#([0-9a-f]{6}\.){7}[0-9a-f]{6}$/.test(shownA.revision),
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
	const found = await timed('find', () => service.searchTasks(c1, { q: `smoke parent renamed ${word}` }));
	check(
		'find locates the parent from the list',
		found.some(hit => hit.id === id(A.number)),
		JSON.stringify(found.map(h => h.id))
	);

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

	// ---- reads through the CLI entry
	const stderrLines = [];
	const cliRun = async (...args) => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = chunk => {
			stderrLines.push(redact(String(chunk)));
			return true;
		};
		const started = performance.now();
		const requests = requestCount;
		try {
			return await cli.runTaskCommand(args, projectDir);
		} finally {
			process.stderr.write = original;
			const label = `task ${args.slice(0, 2).join(' ')}`;
			([
				'new',
				'set-status',
				'set-title',
				'set-description',
				'set-type',
				'unset-type',
				'add-label',
				'remove-label',
				'set-meta',
				'unset-meta',
				'set-parent',
				'remove-parent',
				'link',
				'unlink',
				'comment',
				'comment-edit',
				'comment-rm',
				'delete',
			].includes(args[0])
				? writeTimings
				: readTimings
			).push([label, performance.now() - started, requestCount - requests]);
		}
	};
	const cliJson = async (...args) => {
		const result = await cliRun(...args, '--json');
		return { ...result, json: result.exitCode === 0 ? JSON.parse(result.output) : undefined };
	};
	log('\n== reads through the CLI entry (runTaskCommand)');
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
	const cliFind = await cliRun('find', word);
	check('task find', cliFind.exitCode === 0 && cliFind.output.includes(id(H.number)), cliFind.output.slice(0, 200));
	const cliStatus = await cliRun('status', 'list');
	check('task status list', cliStatus.exitCode === 0 && cliStatus.output.includes('cancelled'), cliStatus.output);
	const cliCheck = await cliRun('strategy', 'check');
	check(
		'task strategy check',
		cliCheck.exitCode === 0 && cliCheck.output.includes('Result: ok'),
		cliCheck.output.slice(-400)
	);

	// ================================================================ phase 2: writes
	log('\n== phase 2: writes through the real strategy (service and CLI entry), checked on GitHub');
	const get = async n => (await api('GET', `/repos/${repo}/issues/${n}`)).body;
	const labelsOn = issue_ => issue_.labels.map(label => label.name);
	const timeline = async n => (await api('GET', `/repos/${repo}/issues/${n}/timeline?per_page=100`)).body;

	// ---- labels sync
	writeConfig(
		'degrade',
		`        fills:
            meta: labels
            delete: tombstone
            linkTypes.duplicateOf: duplicate-marker
        typeMap: {}
`
	);
	const dry = await cliRun('labels', 'sync', '--dry-run');
	check(
		'labels sync --dry-run lists what it would create and creates nothing',
		dry.exitCode === 0 &&
			dry.output.includes('would create') &&
			!(await apiAll(`/repos/${repo}/labels`)).some(l => l.name === 'status:review'),
		dry.output.slice(0, 400)
	);
	const synced = await cliJson('labels', 'sync');
	check(
		'labels sync creates the missing labels',
		synced.exitCode === 0 &&
			synced.json.created.includes('status:review') &&
			synced.json.created.includes('task:deleted') &&
			synced.json.created.includes('type:feature'),
		JSON.stringify(synced.json)
	);
	const reviewLabel = (await api('GET', `/repos/${repo}/labels/${encodeURIComponent('status:review')}`)).body;
	check(
		'labels sync gives them a colour and a description',
		reviewLabel.color !== 'ededed' && typeof reviewLabel.description === 'string',
		JSON.stringify(reviewLabel)
	);
	const syncedAgain = await cliJson('labels', 'sync');
	check(
		'a second labels sync creates nothing',
		syncedAgain.exitCode === 0 && syncedAgain.json.created.length === 0,
		JSON.stringify(syncedAgain.json)
	);

	// ---- create
	const root = await cliJson('new', title('w root'), '--description', 'root body text');
	check(
		'task new creates the issue (backlog)',
		root.exitCode === 0 && root.json.status === 'backlog',
		root.output.slice(0, 300)
	);
	const rootN = Number(root.json.id);
	let g = await get(rootN);
	eq(
		'new: title, body and no label on GitHub',
		[g.title, g.body, labelsOn(g)],
		[title('w root'), 'root body text', []]
	);
	const child = await cliJson('new', title('w child'), '--parent', root.json.id);
	const childN = Number(child.json.id);
	g = await get(childN);
	check(
		'task new --parent attaches the sub-issue',
		child.exitCode === 0 && g.parent_issue_url?.endsWith(`/issues/${rootN}`),
		child.output.slice(0, 300)
	);
	const c3 = ctx();
	const doneOnCreate = await timed(
		'create in a terminal status (create + PATCH)',
		() => c3.store.create({ title: title('w done on create'), status: 'done' }),
		writeTimings
	);
	g = await get(Number(doneOnCreate.id));
	eq(
		'create in a terminal status: closed as completed (state is ignored on create, so a PATCH followed)',
		[g.state, g.state_reason, doneOnCreate.status],
		['closed', 'completed', 'done']
	);
	const cancelledOnCreate = await c3.store.create({ title: title('w cancelled on create'), status: 'cancelled' });
	g = await get(Number(cancelledOnCreate.id));
	eq('create cancelled: closed as not planned', [g.state, g.state_reason], ['closed', 'not_planned']);

	// ---- status: one PATCH each, no spurious intermediate status in the history
	for (const [status, expectState, expectLabels] of [
		['in-progress', 'open', ['status:in-progress']],
		['review', 'open', ['status:review']],
		['done', 'closed', []],
		['cancelled', 'closed', []],
		['backlog', 'open', []],
	]) {
		const moved = await cliJson('set-status', root.json.id, status);
		g = await get(rootN);
		eq(
			`set-status ${status}: GitHub holds state ${expectState} and labels ${JSON.stringify(expectLabels)}`,
			[moved.exitCode, g.state, labelsOn(g)],
			[0, expectState, expectLabels]
		);
	}
	g = await get(rootN);
	eq('set-status cancelled then backlog: reason follows (reopened)', [g.state, g.state_reason], ['open', 'reopened']);
	await cliRun('set-status', root.json.id, 'done');
	await cliRun('set-status', root.json.id, 'cancelled');
	g = await get(rootN);
	eq(
		'closed completed -> closed not planned: the reason changed with state: closed in the body',
		[g.state, g.state_reason],
		['closed', 'not_planned']
	);
	await cliRun('set-status', root.json.id, 'in-progress');
	const recordRoot = await cliJson('show', root.json.id);
	eq(
		'the history shows each status once, in order',
		recordRoot.json.history.map(h => h.status),
		['backlog', 'in-progress', 'review', 'done', 'cancelled', 'backlog', 'done', 'cancelled', 'in-progress']
	);
	const same = await cliRun('set-status', root.json.id, 'in-progress');
	check(
		'the current status is refused (exit 1), nothing sent',
		same.exitCode === 1 && same.output.includes('already in status'),
		same.output
	);

	// ---- title, description
	const renamed = await cliJson('set-title', root.json.id, title('w root renamed'));
	g = await get(rootN);
	check('set-title renames the issue', renamed.exitCode === 0 && g.title === title('w root renamed'));
	const described = await cliJson('set-description', root.json.id, 'a new body');
	g = await get(rootN);
	check(
		'set-description writes the body',
		described.exitCode === 0 && g.body === 'a new body',
		JSON.stringify(g.body)
	);

	// ---- type (label)
	const typed = await cliJson('set-type', root.json.id, 'bug');
	g = await get(rootN);
	check(
		'set-type bug: the label type:bug',
		typed.exitCode === 0 && labelsOn(g).includes('type:bug') && typed.json.type === 'bug',
		JSON.stringify(labelsOn(g))
	);
	const retyped = await cliJson('set-type', root.json.id, 'feature');
	g = await get(rootN);
	eq(
		'set-type feature: ONE swap, never two type labels',
		[retyped.exitCode, labelsOn(g).filter(l => l.startsWith('type:'))],
		[0, ['type:feature']]
	);
	const untyped = await cliJson('unset-type', root.json.id);
	g = await get(rootN);
	check('unset-type removes the label', untyped.exitCode === 0 && !labelsOn(g).some(l => l.startsWith('type:')));

	// ---- labels
	await cliRun('add-label', root.json.id, `smoke-${run}`);
	g = await get(rootN);
	check('add-label creates a missing label and adds it', labelsOn(g).includes(`smoke-${run}`));
	await cliRun('remove-label', root.json.id, `smoke-${run}`);
	g = await get(rootN);
	check('remove-label removes it', !labelsOn(g).includes(`smoke-${run}`));
	const tooLong = await cliRun('add-label', root.json.id, 'x'.repeat(51));
	check(
		'a label over 50 characters is refused before any request, with the limit',
		tooLong.exitCode === 1 && tooLong.output.includes('50'),
		tooLong.output
	);
	const reserved = await cliRun('add-label', root.json.id, 'status:review');
	check(
		'a status label cannot be added as a plain label',
		reserved.exitCode === 1 && reserved.output.includes('task set-status'),
		reserved.output
	);

	// ---- meta as labels
	const m1 = await cliJson('set-meta', root.json.id, 'owner', 'ann');
	g = await get(rootN);
	check(
		'set-meta (fills.meta: labels): the label meta:owner=ann',
		m1.exitCode === 0 && labelsOn(g).includes('meta:owner=ann') && m1.json.meta?.owner === 'ann',
		JSON.stringify(labelsOn(g))
	);
	await cliRun('set-meta', root.json.id, 'owner', 'bob');
	g = await get(rootN);
	eq(
		'set-meta again: the old label is replaced in one PATCH',
		labelsOn(g).filter(l => l.startsWith('meta:')),
		['meta:owner=bob']
	);
	const m3 = await cliRun('set-meta', root.json.id, 'k', 'v'.repeat(60));
	check(
		'a meta that does not fit a label is a limit error that points to body-block',
		m3.exitCode === 1 && m3.output.includes('body-block'),
		m3.output
	);
	await cliRun('unset-meta', root.json.id, 'owner');
	g = await get(rootN);
	check('unset-meta removes the label', !labelsOn(g).some(l => l.startsWith('meta:')));

	// ---- parent
	const other = await cliJson('new', title('w other root'));
	const otherN = Number(other.json.id);
	await cliRun('set-parent', child.json.id, other.json.id);
	g = await get(childN);
	check(
		'set-parent moves the sub-issue (replace_parent)',
		g.parent_issue_url?.endsWith(`/issues/${otherN}`),
		g.parent_issue_url
	);
	const cycle = await cliRun('set-parent', other.json.id, child.json.id);
	check(
		'a parent cycle is refused with the cycle spelled out',
		cycle.exitCode === 1 && cycle.output.includes('cycle'),
		cycle.output
	);
	await cliRun('remove-parent', child.json.id);
	g = await get(childN);
	check('remove-parent detaches it', g.parent_issue_url === undefined || g.parent_issue_url === null);
	const noParent = await cliRun('remove-parent', child.json.id);
	check(
		'remove-parent on a root task is exit 1',
		noParent.exitCode === 1 && noParent.output.includes('has no parent'),
		noParent.output
	);

	// ---- links
	// The dependency LIST is immediate, the counts of the issue lag 1 to 2 s (measured): the list is what is checked.
	const blockersOf = async n =>
		(await apiAll(`/repos/${repo}/issues/${n}/dependencies/blocked_by`)).map(i => i.number);
	await cliRun('link', root.json.id, 'blockedBy', other.json.id);
	eq('link blockedBy: GitHub dependency', await blockersOf(rootN), [otherN]);
	const shownLinked = await cliJson('show', root.json.id);
	eq('and task shows it at once, although GitHub counts it late', shownLinked.json.links, [
		{ type: 'blockedBy', target: other.json.id },
	]);
	const dupLink = await cliRun('link', root.json.id, 'blockedBy', other.json.id);
	check(
		'the same link twice is refused',
		dupLink.exitCode === 1 && dupLink.output.includes('already blockedBy'),
		dupLink.output
	);
	const cyc = await cliRun('link', other.json.id, 'blockedBy', root.json.id);
	check(
		'a link cycle is refused with the cycle spelled out',
		cyc.exitCode === 1 && cyc.output.includes('cycle'),
		cyc.output
	);
	await cliRun('unlink', root.json.id, 'blockedBy', other.json.id);
	eq('unlink: the dependency is gone', await blockersOf(rootN), []);
	const shownUnlinked = await cliJson('show', root.json.id);
	check(
		'and task shows it gone at once',
		shownUnlinked.json.links === undefined,
		JSON.stringify(shownUnlinked.json.links)
	);
	const causedBy = await cliRun('link', root.json.id, 'causedBy', other.json.id);
	check(
		'causedBy has no GitHub equivalent: exit 1 with a hint',
		causedBy.exitCode === 1 && causedBy.output.includes('blockedBy'),
		causedBy.output
	);

	// duplicateOf (marker + close)
	const dup = await cliJson('new', title('w duplicate'), '--description', 'same as the other');
	const dupN = Number(dup.json.id);
	await cliRun('link', dup.json.id, 'duplicateOf', other.json.id);
	g = await get(dupN);
	check(
		'link duplicateOf: closed as a duplicate with the marker in the body',
		g.state === 'closed' &&
			g.state_reason === 'duplicate' &&
			g.body.includes('"duplicateOf"') &&
			g.body.startsWith('same as the other'),
		JSON.stringify([g.state, g.state_reason, g.body])
	);
	const dupRecord = await cliJson('show', dup.json.id);
	check(
		'the duplicate reads back: status duplicate, link, description without the block',
		dupRecord.json.status === 'duplicate' &&
			dupRecord.json.links?.[0]?.target === other.json.id &&
			dupRecord.json.description === 'same as the other',
		JSON.stringify(dupRecord.json)
	);
	const otherLinks = await cliRun('links', other.json.id);
	check(
		'the original lists its duplicate (inverse read from the blocks)',
		otherLinks.exitCode === 0 &&
			JSON.parse(otherLinks.output)
				.duplicates.map(t => t.id)
				.includes(dup.json.id),
		otherLinks.output.slice(0, 300)
	);
	check(
		'a warning says duplicateOf is emulated',
		stderrLines.join('').includes('duplicateOf is emulated'),
		stderrLines.join('').slice(-300)
	);
	await cliRun('unlink', dup.json.id, 'duplicateOf', other.json.id);
	g = await get(dupN);
	check(
		'unlink duplicateOf removes the marker only',
		!g.body.includes('task:begin') && g.state === 'closed',
		JSON.stringify(g.body)
	);

	// ---- comments
	const added = await cliJson('comment', root.json.id, 'first live note');
	check(
		'comment adds a comment as the user of the token',
		(added.exitCode === 0 && typeof added.json.comment?.author === 'string') || added.exitCode === 0,
		added.output.slice(0, 300)
	);
	const comments1 = await cliJson('comments', root.json.id);
	const commentId = comments1.json[0].id;
	await cliRun('comment-edit', root.json.id, commentId, 'edited live note');
	const apiComments = await apiAll(`/repos/${repo}/issues/${rootN}/comments`);
	check(
		'comment-edit changes the text',
		apiComments.some(c => String(c.id) === commentId && c.body === 'edited live note')
	);
	await cliRun('comment-rm', root.json.id, commentId);
	check('comment-rm removes it', (await apiAll(`/repos/${repo}/issues/${rootN}/comments`)).length === 0);
	const authored = await cliRun('comment', root.json.id, 'x', '--author', 'ann');
	check(
		'a chosen author is refused',
		authored.exitCode === 1 && authored.output.includes('--author'),
		authored.output
	);

	// ---- consistency: expectedRevision
	log('\n== consistency: expectedRevision against changes made on GitHub');
	const c4 = ctx();
	const base = await c4.store.get(String(rootN));
	await api('POST', `/repos/${repo}/issues/${rootN}/comments`, { body: 'a note from someone else' });
	const afterComment = await timed(
		'setTitle with the revision of before a comment',
		() => c4.store.setTitle(String(rootN), title('w root renamed twice'), { expectedRevision: base.revision }),
		writeTimings
	);
	check(
		'a comment made elsewhere is not a conflict for a rename',
		afterComment.title === title('w root renamed twice')
	);
	const base2 = await c4.store.get(String(rootN));
	await api('PATCH', `/repos/${repo}/issues/${rootN}`, { title: title('w renamed on GitHub') });
	let stale;
	try {
		await c4.store.setTitle(String(rootN), title('w mine'), { expectedRevision: base2.revision });
	} catch (error) {
		stale = error;
	}
	check(
		'a rename made on GitHub since the read is a StaleRevisionError',
		stale?.name === 'StaleRevisionError',
		String(stale)
	);
	g = await get(rootN);
	check('and nothing was written', g.title === title('w renamed on GitHub'), g.title);
	await c4.dispose();

	// ---- history and activity of what was done through task
	log('\n== activity of the writes (GitHub timeline is the source)');
	const act = await cliRun('history', root.json.id, '--all');
	check(
		'history --all shows the writes made through task',
		act.exitCode === 0 && /Title edited/.test(act.output) && /Label/i.test(act.output) && /Type/i.test(act.output),
		act.output.slice(0, 600)
	);
	const tl = await timeline(rootN);
	const doneAt = tl.filter(e => e.event === 'closed');
	check('the closes of the status changes are in the timeline', doneAt.length >= 2, String(doneAt.length));

	// ---- tombstone delete
	const gone = await cliJson('new', title('w to tombstone'));
	const goneN = Number(gone.json.id);
	const child2 = await cliJson('new', title('w tombstone child'), '--parent', gone.json.id);
	const deleted = await cliRun('delete', gone.json.id);
	g = await get(goneN);
	check(
		'delete (tombstone): closed as not planned with the label task:deleted',
		deleted.exitCode === 0 &&
			g.state === 'closed' &&
			g.state_reason === 'not_planned' &&
			labelsOn(g).includes('task:deleted'),
		`${deleted.output.slice(0, 200)} ${JSON.stringify([g.state, g.state_reason, labelsOn(g)])}`
	);
	const listAfter = JSON.parse((await cliRun('list', '--all', '--json')).output);
	check('the tombstone is hidden from list --all', !listAfter.some(t => t.id === gone.json.id));
	const childAfter = await get(Number(child2.json.id));
	check(
		'its child became a root task',
		childAfter.parent_issue_url === undefined || childAfter.parent_issue_url === null
	);
	check('a warning says delete is emulated', stderrLines.join('').includes('delete is emulated'));

	// ---- phase 2b: body block meta, native type, hard delete
	writeConfig(
		'degrade',
		`        typeMap: { bug: { issueType: Bug } }
        fills:
            meta: body-block
            delete: hard
`
	);
	const blockTask = await cliJson('new', title('w block meta'), '--description', 'visible text');
	const blockN = Number(blockTask.json.id);
	const bm = await cliJson('set-meta', blockTask.json.id, 'notes', 'a, b and a very long value '.repeat(5));
	g = await get(blockN);
	check(
		'set-meta (body-block): any text fits, the description is kept',
		bm.exitCode === 0 &&
			g.body.startsWith('visible text') &&
			g.body.includes('task:begin') &&
			labelsOn(g).length === 0,
		JSON.stringify(g.body).slice(0, 200)
	);
	await cliRun('set-description', blockTask.json.id, 'new visible text');
	g = await get(blockN);
	check(
		'set-description keeps the managed block',
		g.body.startsWith('new visible text') && g.body.includes('"notes"'),
		JSON.stringify(g.body).slice(0, 200)
	);
	const bshow = await cliJson('show', blockTask.json.id);
	check('the block meta reads back', bshow.json.meta?.notes?.startsWith('a, b'), JSON.stringify(bshow.json.meta));
	check('a warning says meta is emulated', stderrLines.join('').includes('meta is emulated'));
	await cliRun('unset-meta', blockTask.json.id, 'notes');
	g = await get(blockN);
	check(
		'unset-meta drops the block with its last key',
		!g.body.includes('task:begin') && g.body === 'new visible text',
		JSON.stringify(g.body)
	);
	const nativeType = await cliJson('set-type', blockTask.json.id, 'bug');
	g = await get(blockN);
	check(
		'set-type with typeMap.issueType sets the native issue type',
		nativeType.exitCode === 0 && g.type?.name === 'Bug',
		JSON.stringify(g.type)
	);
	await cliRun('unset-type', blockTask.json.id);
	g = await get(blockN);
	check('unset-type clears the native type', g.type === null || g.type === undefined);
	const hard = await cliJson('new', title('w to hard delete'));
	const hardN = Number(hard.json.id);
	const hardDel = await cliRun('delete', hard.json.id);
	const afterHard = await api('GET', `/repos/${repo}/issues/${hardN}`, undefined, { allow: [410, 404] });
	check(
		'delete (hard): GraphQL deleteIssue, the issue is gone (410)',
		hardDel.exitCode === 0 && afterHard.status === 410,
		`${hardDel.output.slice(0, 200)} -> ${afterHard.status}`
	);

	// ---- fidelity probes: what the real server sent (to keep the fake server faithful)
	log('\n== what the real server sent (to keep the fake server faithful)');
	const probe = async (n, kinds) => {
		const events = await timeline(n);
		for (const kind of kinds) {
			const event = events.find(e => e.event === kind);
			log(`  timeline ${kind}: ${event === undefined ? 'not seen' : Object.keys(event).sort().join(', ')}`);
		}
	};
	await probe(rootN, ['labeled', 'unlabeled', 'closed', 'reopened', 'renamed', 'issue_type_added']);
	const instants = tl
		.filter(e => ['closed', 'unlabeled', 'labeled', 'reopened'].includes(e.event))
		.map(e => `${e.event}@${e.created_at.slice(11)}`);
	log(`  state and label events of the status changes: ${instants.join(' ')}`);
	const rootIssue = await get(rootN);
	log(
		`  revision of root: ${await (async () => {
			const c5 = ctx();
			const r = await c5.store.get(String(rootN));
			await c5.dispose();
			return r.revision;
		})()}`
	);
	log(`  issue keys: ${Object.keys(rootIssue).sort().join(', ')}`);
	const stderrWarnings = stderrLines
		.join('')
		.split('\n')
		.filter(l => l.startsWith('warning:'));
	log(`  warnings printed on stderr by the writes: ${stderrWarnings.length}`);
	for (const line of [...new Set(stderrWarnings)]) log(`    ${line.slice(0, 220)}`);
} catch (error) {
	exitCode = 1;
	log(`\nlive-github-smoke: FAILED with an exception: ${error instanceof Error ? error.stack : error}`);
} finally {
	// ---------------------------------------------------------------- cleanup (always)
	log('\n== cleanup');
	let closed = 0;
	try {
		const open = await apiAll(`/repos/${repo}/issues?state=open`);
		for (const item of open.filter(
			i => i.pull_request === undefined && i.title.startsWith(PREFIX) && i.title.includes(run)
		)) {
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
	for (const [name, ms, requests] of readTimings)
		log(`  ${String(Math.round(ms)).padStart(6)}  ${String(requests).padStart(3)} requests  ${name}`);
	log(
		'\n== latencies of the writes through task (ms; each includes the 1 s spacing between its calls, the re-reads and the final record)'
	);
	for (const [name, ms, requests] of writeTimings)
		log(`  ${String(Math.round(ms)).padStart(6)}  ${String(requests).padStart(3)} requests  ${name}`);
	log('\n== latency of the direct API calls (median ms, count)');
	for (const [name, values] of [...timings].sort())
		log(`  ${String(Math.round(median(values))).padStart(6)}  x${String(values.length).padStart(3)}  ${name}`);
	fs.rmSync(world, { recursive: true, force: true });
}

const failed = results.filter(r => !r.ok);
log(
	`\nlive-github-smoke: ${results.length - failed.length} of ${results.length} assertions passed${failed.length > 0 ? `; FAILED: ${failed.map(f => f.name).join(' | ')}` : ''}`
);
process.exit(failed.length > 0 ? 1 : exitCode);
