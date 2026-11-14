// LIVE smoke run of the gitlab strategy against the real gitlab.com API (Free tier), or against the local faithful mock. NOT part of
// `npm test` or CI: run it by hand.
//
//   npm run build
//   GL_TEST_TOKEN=<fine-grained token: Work Item and Label permissions on the project> \
//   GL_TEST_PROJECT=group/throwaway-project \
//   node scripts/live-gitlab-smoke.mjs [--json <result file>]
//
//   node scripts/live-gitlab-smoke.mjs --mock [--json <result file>]     (no token, no network: a FakeGitLab on a free port)
//
// The SAME assertions run against both targets, so a difference between the mock and the real server shows as a failing assertion on
// one of them; `scripts/live-gitlab-smoke-diff.mjs a.json b.json` compares two result files (names and ok flags).
//
// What it covers, through the real strategy (service API from packages/task-service/dist and the CLI entry from
// packages/task-cli/dist), in an isolated world (temp XDG_CONFIG_HOME / HOME / USERPROFILE, queue off, own registry):
//   - labels sync (colour, description, group labels and existing labels untouched), then `task migrate` local -> gitlab -> local
//     (the losses the traits declare, the read-back, idempotence, the comparison of the two local projects);
//   - reads of issues seeded through the REST API (status, type, labels, comments, activity from system notes, revision, search);
//   - `task strategy check` (every line, for the token of the run);
//   - writes: create (also in a terminal status), status (ONE PUT each), title, description (CRLF, quick actions refused), type (label,
//     native incident, task type as a label only, test_case refused), labels, meta (labels fill), comments (system notes never
//     listed), links (blockedBy refused, duplicateOf and causedBy through the relate-block fill), hierarchy (child with a parent,
//     set-parent converting to a native Task, remove-parent, children / ancestors / tree, the depth refusals), history and activity,
//     delete (tombstone and hard), `status::` style labels, list pagination, expectedRevision;
//   - per-command timings and request counts, the RateLimit-Remaining at the end.
// Cleanup (always, also on failure): every issue of the run is CLOSED (a hard-deleted one is gone) and the labels of the run are
// removed from it; every label the run created is deleted. A label that existed before the run, a group label (is_project_label
// false) and any label named `type::toto` are NEVER deleted.
//
// The live project allows 100 requests a minute: the strategy WAITS for the window (one notice per wait on stderr) and so does this
// script between its own steps; a wait is never a failure.
//
// Exit codes: 0 all assertions passed, 1 an assertion failed, 2 the environment is not set (a clear message, never a silent skip).
// The token is only read from the environment; it is never printed, written or logged (every text is redacted before output).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- arguments and target
const LIVE_BASE_URL = 'https://gitlab.com/api/v4';
const PROJECT_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;
const MOCK_PROJECT = 'wadeck-app/test-task-gl';

const argv = process.argv.slice(2);
const useMock = argv.includes('--mock');
let jsonFile;
for (let index = 0; index < argv.length; index++) {
	const arg = argv[index];
	if (arg === '--mock') continue;
	if (arg === '--json') {
		jsonFile = argv[index + 1];
		if (jsonFile === undefined || jsonFile.startsWith('--')) {
			console.error('live-gitlab-smoke: --json needs the path of the file to write.');
			process.exit(2);
		}
		index += 1;
		continue;
	}
	console.error(
		`live-gitlab-smoke: unknown argument "${arg}". Usage: node scripts/live-gitlab-smoke.mjs [--mock] [--json <file>]`
	);
	process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..');
const distFiles = {
	service: path.join(root, 'packages/task-service/dist/index.js'),
	cli: path.join(root, 'packages/task-cli/dist/TaskIndex.js'),
	options: path.join(root, 'packages/task-service/dist/plugins/gitlab/gitlabOptions.js'),
	workItems: path.join(root, 'packages/task-service/dist/plugins/gitlab/gitlabWorkItems.js'),
	fake: path.join(root, 'packages/task-service/dist/plugins/gitlab/fakeGitLab.testkit.js'),
};
for (const [name, file] of Object.entries(distFiles)) {
	if (name === 'fake' && !useMock) continue;
	if (!fs.existsSync(file)) {
		console.error(`live-gitlab-smoke: ${file} does not exist (the ${name} is not built). Run: npm run build`);
		process.exit(2);
	}
}

let token = process.env.GL_TEST_TOKEN ?? '';
let project = process.env.GL_TEST_PROJECT ?? '';
let baseUrl = LIVE_BASE_URL;
let fake;
if (useMock) {
	const { FakeGitLab } = await import(pathToFileURL(distFiles.fake).href);
	// A quota that is never reached: the fake counts like GitLab but the run must not sleep for a window it cannot be refused by.
	fake = await FakeGitLab.start({ project: MOCK_PROJECT, rateLimit: { limit: 1_000_000 } });
	token = fake.token;
	project = MOCK_PROJECT;
	baseUrl = fake.baseUrl;
} else {
	if (token === '' || project === '') {
		console.error(
			[
				'live-gitlab-smoke: GL_TEST_TOKEN and GL_TEST_PROJECT must both be set; nothing was run.',
				'  GL_TEST_TOKEN    a fine-grained token with the Work Item and Label permissions (create, read, update, delete) on the project',
				'  GL_TEST_PROJECT  group/project (or group/subgroup/project) of a THROWAWAY gitlab.com project',
				'  (or run against the local mock with --mock: no token, no network)',
			].join('\n')
		);
		process.exit(2);
	}
	if (!PROJECT_PATH.test(project)) {
		console.error(
			`live-gitlab-smoke: GL_TEST_PROJECT "${project}" is not of the form group/project (nested groups: group/subgroup/project).`
		);
		process.exit(2);
	}
}
if (new URL(baseUrl).origin !== new URL(useMock ? fake.baseUrl : LIVE_BASE_URL).origin) {
	console.error(`live-gitlab-smoke: refusing to talk to ${baseUrl}.`);
	process.exit(2);
}
const TARGET_ORIGIN = new URL(baseUrl).origin;
const API_PATH = new URL(baseUrl).pathname.replace(/\/+$/, '');
const TOKEN_VARIABLE = 'GL_TEST_TOKEN';

// ---------------------------------------------------------------- an isolated world: registry, config dir and home in a temp folder; no queue
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'task-gitlab-live-smoke-'));
process.env.XDG_CONFIG_HOME = path.join(world, 'xdg');
process.env['HOME'] = world;
process.env['USERPROFILE'] = world;
process.env.QUEUE_SDK_OFF = '1';
delete process.env.TASK_PROJECT;
// The strategy reads the token from this variable (tokenEnv); in a mock run it is the fake's.
process.env[TOKEN_VARIABLE] = token;

const redact = text => String(text).split(token).join('***');
const log = (...parts) => console.log(redact(parts.join(' ')));

// ---------------------------------------------------------------- every request of the run goes through this counter
const requestLog = [];
const realFetch = globalThis.fetch;
let inDirect = false;
let lastRate;
const projectSegment = new RegExp(`^/projects/[^/]+`);
const normalize = pathname => {
	const relative = pathname.startsWith(API_PATH) ? pathname.slice(API_PATH.length) : pathname;
	return relative.replace(projectSegment, '').replace(/\/\d+/g, '/N') || '/';
};
globalThis.fetch = async (input, init) => {
	const url = new URL(typeof input === 'string' ? input : (input?.url ?? String(input)));
	if (url.origin !== TARGET_ORIGIN) {
		throw new Error(`live-gitlab-smoke: refusing a request to ${url.origin} (only ${TARGET_ORIGIN} is allowed)`);
	}
	const method = (init?.method ?? input?.method ?? 'GET').toUpperCase();
	let kind;
	if (url.pathname.endsWith('/graphql')) {
		kind = typeof init?.body === 'string' && init.body.includes('mutation') ? 'GRAPHQL write' : 'GRAPHQL read';
	} else {
		kind = `${method} ${normalize(url.pathname)}`;
	}
	requestLog.push({ method, kind, direct: inDirect });
	const response = await realFetch(input, init);
	const remaining = response.headers.get('ratelimit-remaining');
	const reset = response.headers.get('ratelimit-reset');
	if (remaining !== null && reset !== null) {
		lastRate = {
			remaining: Number(remaining),
			limit: Number(response.headers.get('ratelimit-limit')),
			reset: Number(reset),
		};
	}
	return response;
};
/** The requests that change something, since `mark`, as `METHOD /path` (GraphQL: `GRAPHQL write`). */
const writesSince = mark =>
	requestLog.slice(mark).filter(entry => entry.method !== 'GET' && entry.kind !== 'GRAPHQL read');
const writeKindsSince = mark => writesSince(mark).map(entry => entry.kind);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The live project allows 100 requests a minute and the strategy only learns its quota from its own answers: before a step, wait
// for the window to reopen when little is left. The fake never refuses a request, so a run against it does not wait.
const RESERVE = 30;
let guardWaits = 0;
let rateNotices = 0;
async function rateGuard() {
	if (useMock || lastRate === undefined) return;
	const ms = lastRate.reset * 1000 - Date.now();
	if (lastRate.remaining >= RESERVE || ms <= 0) return;
	guardWaits += 1;
	log(
		`  (rate limit: ${lastRate.remaining} of ${lastRate.limit} requests left, waiting ${Math.ceil(ms / 1000) + 1} s for the window)`
	);
	await sleep(ms + 1000);
	lastRate = undefined;
}

// ---------------------------------------------------------------- the REST seeding and inspection client: nothing but fetch
const PROJECT_ROUTE = `/projects/${encodeURIComponent(project)}`;

async function api(method, route, body, { allow = [] } = {}) {
	for (let attempt = 0; ; attempt++) {
		await rateGuard();
		inDirect = true;
		let response;
		let text;
		try {
			response = await fetch(
				`${TARGET_ORIGIN}${route === '/graphql' ? API_PATH.replace(/\/v4$/, '') : API_PATH}${route}`,
				{
					method,
					headers: {
						'PRIVATE-TOKEN': token,
						accept: 'application/json',
						'content-type': 'application/json',
						'user-agent': 'task-live-smoke',
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				}
			);
			text = await response.text();
		} finally {
			inDirect = false;
		}
		if (response.status === 429 && attempt < 3) {
			const reset = Number(response.headers.get('ratelimit-reset') ?? 0) * 1000 - Date.now();
			const wait = Math.max(Number(response.headers.get('retry-after') ?? 0) * 1000, reset) + 1000;
			guardWaits += 1;
			log(`  (429 on ${method} ${route.replace(PROJECT_ROUTE, '')}: waiting ${Math.ceil(wait / 1000)} s)`);
			await sleep(wait);
			continue;
		}
		if (!response.ok && !allow.includes(response.status)) {
			throw new Error(`${method} ${route} -> ${response.status}: ${redact(text).slice(0, 300)}`);
		}
		let parsed;
		try {
			parsed = text === '' ? undefined : JSON.parse(text);
		} catch {
			parsed = text;
		}
		return { status: response.status, body: parsed, headers: response.headers };
	}
}

/** Every item of a paginated list. */
async function apiAll(route) {
	const items = [];
	for (let page = 1; page < 60; page++) {
		const { body } = await api('GET', `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
		items.push(...body);
		if (body.length < 100) break;
	}
	return items;
}

const issueRoute = n => `${PROJECT_ROUTE}/issues/${n}`;
let workItemsModule;
/** The parent and the children of an issue as GitLab holds them, read with GraphQL (the REST API has no hierarchy). */
async function hierarchyOf(issue) {
	const answer = (
		await api('POST', '/graphql', {
			query: workItemsModule.GQL_READ,
			variables: { id: workItemsModule.workItemGid(issue.id) },
		})
	).body;
	const widget = (answer?.data?.workItem?.widgets ?? []).find(candidate => candidate.type === 'HIERARCHY');
	return {
		parentIid: widget?.parent?.iid === undefined ? undefined : Number(widget.parent.iid),
		childIids: (widget?.children?.nodes ?? []).map(node => Number(node.iid)).sort((a, b) => a - b),
	};
}
const getIssue = async n => (await api('GET', issueRoute(n))).body;
const labelsOn = issue => [...issue.labels].sort();
const nativeTypeOf = issue => String(issue.issue_type ?? issue.type ?? '').toLowerCase();
const projectLabels = async () => apiAll(`${PROJECT_ROUTE}/labels`);
const notesOf = async n => apiAll(`${issueRoute(n)}/notes?sort=asc&order_by=created_at`);

// ---------------------------------------------------------------- assertions
const results = [];
const names = new Map();
function check(name, ok, detail = '') {
	// A name must be unique and deterministic (no run id, no number): a repeated one gets a stable suffix.
	const count = (names.get(name) ?? 0) + 1;
	names.set(name, count);
	const unique = count === 1 ? name : `${name} (#${count})`;
	const shown = ok || detail === '' ? '' : redact(detail);
	results.push({ name: unique, ok: Boolean(ok), ...(shown === '' ? {} : { detail: shown }) });
	log(
		`${ok ? '  PASS' : '  FAIL'}  ${unique}${shown === '' ? '' : `\n        ${shown.slice(0, 1500).replaceAll('\n', '\n        ')}`}`
	);
}
const eq = (name, actual, expected) =>
	check(
		name,
		JSON.stringify(actual) === JSON.stringify(expected),
		`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
	);

let failedSections = 0;
// Set once the project exists: puts the default configuration back, whatever a section did to it.
let restoreConfig = () => {};
async function section(name, run_) {
	log(`\n== ${name}`);
	try {
		await run_();
	} catch (error) {
		failedSections += 1;
		check(
			`section "${name}" ran to the end`,
			false,
			error instanceof Error ? (error.stack ?? error.message) : String(error)
		);
	} finally {
		restoreConfig();
	}
}
let leaked = 0;

const stepTimings = [];
async function timed(name, run_) {
	await rateGuard();
	const started = performance.now();
	const mark = requestLog.length;
	try {
		return await run_();
	} finally {
		stepTimings.push({ name, ms: Math.round(performance.now() - started), requests: requestLog.length - mark });
	}
}

// ---------------------------------------------------------------- the run
const run = Math.random().toString(36).slice(2, 8);
const PREFIX = '[task-api-test]';
const title = text => `${PREFIX} ${text} ${run}`;
let preexisting = new Map();
// Labels are deleted only when the labels that existed before the run are known: never on a guess.
let preexistingKnown = false;
let exitCode = 0;
const startedAt = performance.now();
let rateAtStart;

try {
	log(`live-gitlab-smoke: target ${useMock ? 'mock' : 'live'} (${baseUrl}), project ${project}, run ${run}`);
	preexisting = new Map((await projectLabels()).map(label => [label.name, label.is_project_label !== false]));
	preexistingKnown = true;
	rateAtStart = lastRate;
	if (useMock) {
		// What a real project may already hold: a group label and a label that must never be deleted. (The fake is the only target
		// that is prepared; the assertions below read the real state and are the same on both.)
		fake.seedGroupLabel('status:review', '#00ff00', 'from the group');
		fake.seedLabel('type::toto', '#ff0000', 'must survive the cleanup');
		preexisting = new Map((await projectLabels()).map(label => [label.name, label.is_project_label !== false]));
	}
	log(`the project holds ${preexisting.size} label(s) before the run`);

	// ---- the project: registry + config
	const sdk = await import('@wadeck-app/project-sdk');
	const service = await import(pathToFileURL(distFiles.service).href);
	const cli = await import(pathToFileURL(distFiles.cli).href);
	const gitlabOptions = await import(pathToFileURL(distFiles.options).href);
	workItemsModule = await import(pathToFileURL(distFiles.workItems).href);
	const registryDir = sdk.defaultRegistryDir(process.env);
	const projects = new Map();
	const register = async name => {
		const dir = path.join(world, 'work', name);
		fs.mkdirSync(dir, { recursive: true });
		await sdk.addProject(registryDir, { name, path: dir });
		const resolved = service.resolveProject({ cwd: dir, env: process.env });
		projects.set(name, { dir, resolved });
		return { dir, resolved };
	};

	const STATUSES_YAML = `statuses:
    - backlog
    - in-progress
    - review
    - { name: done, terminal: true }
    - { name: cancelled, terminal: true, outcome: negative }
types:
    - bug
    - outage
    - chore
`;
	// The polite pace between two writes of one command is kept on gitlab.com; the fake has no use for it (its clock is its own).
	const WRITE_SPACING_SECONDS = useMock ? 0 : 1;
	const FILLS = {
		degrade: `        fills:
            meta: labels
            delete: tombstone
            linkTypes.duplicateOf: relate-block
            linkTypes.causedBy: relate-block
`,
		hard: `        fills:
            meta: labels
            delete: hard
            linkTypes.duplicateOf: relate-block
            linkTypes.causedBy: relate-block
`,
		none: '',
	};
	/**
	 * The config of the gitlab project. `statusPrefix` is `status:` or `status::` (a scoped-looking label is a plain label on Free).
	 * `fills` is a key of FILLS.
	 */
	const gitlabConfig = ({
		statusPrefix = 'status:',
		typePrefix,
		fills = 'degrade',
		pageSize = 100,
		typeMap,
	} = {}) => `${STATUSES_YAML}strategy:
    type: gitlab
    fidelity: degrade
    options:
        project: ${project}
        baseUrl: ${baseUrl}
        tokenEnv: ${TOKEN_VARIABLE}
        cache: { ttlSeconds: 0 }
        timeoutSeconds: 30
        pageSize: ${pageSize}
        writeSpacingSeconds: ${WRITE_SPACING_SECONDS}
${typePrefix === undefined ? '' : `        typePrefix: '${typePrefix}'\n`}        statusMap:
            backlog: { state: open }
            in-progress: { state: open, label: '${statusPrefix}in-progress' }
            review: { state: open, label: '${statusPrefix}review' }
            done: { state: closed }
            cancelled: { state: closed, label: '${statusPrefix}cancelled' }
        typeMap:
${typeMap ?? '            outage: { issueType: incident }\n'}${FILLS[fills]}`;
	const writeConfig = (name, text) => {
		const file = service.ownConfigFile(projects.get(name).resolved.storage);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	};

	const smoke = await register('smoke');
	writeConfig('smoke', gitlabConfig());
	const projectDir = smoke.dir;
	restoreConfig = () => writeConfig('smoke', gitlabConfig());
	const ctx = (name = 'smoke') => service.openResolvedProject(projects.get(name).resolved);
	const withCtx = async (fn, name) => {
		const c = ctx(name);
		try {
			return await fn(c);
		} finally {
			await c.dispose?.();
		}
	};

	// ---- the CLI entry
	const stderrLines = [];
	const WRITE_COMMANDS = new Set([
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
	]);
	const cliIn = async (cwd, ...args) => {
		await rateGuard();
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = chunk => {
			if (String(chunk).includes(token)) leaked += 1;
			const text = redact(String(chunk));
			stderrLines.push(text);
			// A wait for the rate limit window is shown at once, as the strategy prints it.
			if (/rate limit/i.test(text)) {
				rateNotices += 1;
				original(text);
			}
			return true;
		};
		const started = performance.now();
		const mark = requestLog.length;
		try {
			const result = await cli.runTaskCommand(args, cwd);
			if (String(result.output ?? '').includes(token)) leaked += 1;
			return { ...result, output: redact(result.output ?? '') };
		} finally {
			process.stderr.write = original;
			stepTimings.push({
				name: `task ${args.slice(0, ['labels', 'strategy', 'status', 'type'].includes(args[0]) ? 2 : 1).join(' ')}${args.includes('--dry-run') ? ' --dry-run' : ''}${WRITE_COMMANDS.has(args[0]) ? ' (write)' : ''}`,
				ms: Math.round(performance.now() - started),
				requests: requestLog.length - mark,
			});
		}
	};
	const cliRun = (...args) => cliIn(projectDir, ...args);
	const parse = text => {
		try {
			return JSON.parse(text);
		} catch {
			return undefined;
		}
	};
	const cliJson = async (...args) => {
		const result = await cliRun(...args, '--json');
		return { ...result, json: parse(result.output) };
	};

	// Nothing after this line may use a name that depends on the run or on an issue number.
	const seeded = {};
	const ids = {};

	// ================================================================ labels sync
	await section('labels sync', async () => {
		const before = await projectLabels();
		const beforeNames = new Set(before.map(label => label.name));
		const wantedNames = [
			'status:in-progress',
			'status:review',
			'status:cancelled',
			'type:bug',
			'type:chore',
			'task:deleted',
		];
		const dry = await cliRun('labels', 'sync', '--dry-run');
		const afterDry = await projectLabels();
		check(
			'labels sync --dry-run lists what it would do and creates nothing',
			dry.exitCode === 0 && /Dry run/.test(dry.output) && afterDry.length === before.length,
			dry.output.slice(0, 500)
		);
		const synced = await cliJson('labels', 'sync');
		check('labels sync exits 0', synced.exitCode === 0, synced.output.slice(0, 500));
		const created = synced.json?.created ?? [];
		const existing = synced.json?.existing ?? [];
		eq(
			'labels sync: every label of the mapping is created or already there',
			[...created, ...existing].sort(),
			[...wantedNames].sort()
		);
		eq(
			'labels sync: it creates exactly the labels that did not exist (project or group), and leaves the others alone',
			[...created].sort(),
			wantedNames.filter(name => !beforeNames.has(name)).sort()
		);
		const after = await projectLabels();
		const byName = new Map(after.map(label => [label.name, label]));
		check(
			'labels sync: a created label has a colour and a description',
			created.every(
				name =>
					/^#[0-9a-f]{6}$/i.test(byName.get(name)?.color ?? '') &&
					(byName.get(name)?.description ?? '') !== ''
			),
			JSON.stringify(created.map(name => byName.get(name)))
		);
		check(
			'labels sync: a label that existed before keeps its colour and description',
			before
				.filter(label => wantedNames.includes(label.name))
				.every(
					label =>
						byName.get(label.name)?.color === label.color &&
						byName.get(label.name)?.description === label.description
				),
			JSON.stringify(before.filter(label => wantedNames.includes(label.name)))
		);
		const again = await cliJson('labels', 'sync');
		check(
			'a second labels sync creates nothing',
			again.exitCode === 0 && again.json?.created.length === 0,
			again.output.slice(0, 300)
		);
	});

	// ================================================================ migrate local -> gitlab -> local
	await section('migrate local -> gitlab -> local', async () => {
		await register('mig-local');
		await register('mig-back');
		writeConfig('mig-local', STATUSES_YAML);
		writeConfig('mig-back', STATUSES_YAML);
		// Only the incident is a native type: the native Task is the type of a hierarchy child, never a task type (chore is a label).
		writeConfig('smoke', gitlabConfig({ typeMap: '            outage: { issueType: incident }\n' }));
		const mig = text => title(`mig ${text}`);
		const local = ctx('mig-local');
		const make = async (name, status = 'backlog', parent) =>
			(
				await local.store.create({
					title: mig(name),
					status,
					...(parent === undefined ? {} : { parentId: parent }),
				})
			).id;
		const P = await make('parent');
		const C1 = await make('child one', 'backlog', P);
		const C2 = await make('child two', 'backlog', P);
		const G = await make('grandchild', 'backlog', C1);
		const B = await make('blocker');
		const X = await make('duplicate');
		const O = await make('outage');
		await local.store.updateStatus(C1, 'in-progress');
		await local.store.updateStatus(C2, 'review');
		await local.store.updateStatus(B, 'done');
		await local.store.updateStatus(X, 'cancelled');
		await local.store.setType(P, 'bug');
		await local.store.setType(C1, 'chore');
		await local.store.setType(O, 'outage');
		await local.store.addLabel(P, 'smoke-planning');
		await local.store.setMeta(P, 'owner', 'ann');
		await local.store.setDescription(C2, 'A description\nover two lines');
		await local.store.addLink(C2, 'blockedBy', B);
		await local.store.addLink(X, 'duplicateOf', B);
		await local.store.addLink(G, 'causedBy', B);
		await local.store.addComment(P, 'First note', { author: 'ann' });
		await local.store.addComment(P, 'Second note', { author: 'bob' });
		await local.store.addComment(B, 'Shipped without a fuss');
		await local.dispose?.();
		const seededNames = new Map([
			[P, 'parent'],
			[C1, 'child one'],
			[C2, 'child two'],
			[G, 'grandchild'],
			[B, 'blocker'],
			[X, 'duplicate'],
			[O, 'outage'],
		]);

		const migrate = async (from, to, ...args) => {
			const result = await cliIn(world, 'migrate', '--from', from, '--to', to, ...args, '--json');
			return { ...result, json: parse(result.output) };
		};
		const LOSSES = ['history', 'created-at', 'hierarchy:depth', 'links:blockedBy'];

		// ---- dry run, then blocked
		let mark = requestLog.length;
		const dry = await migrate('mig-local', 'smoke', '--dry-run');
		eq('migrate dry run: exit 0 and status dry-run', [dry.exitCode, dry.json?.status], [0, 'dry-run']);
		eq('migrate dry run: would create the 7 tasks', dry.json?.counts?.created, 7);
		eq(
			'migrate dry run: the losses the traits declare, no others (GitLab keeps no history nor creation instant, two levels, no blockedBy)',
			[...(dry.json?.blocking ?? [])].sort(),
			[...LOSSES].sort()
		);
		eq('migrate dry run: no request that changes anything', writeKindsSince(mark), []);
		mark = requestLog.length;
		const blocked = await migrate('mig-local', 'smoke');
		eq(
			'migrate without --allow-loss: exit 1 and status blocked',
			[blocked.exitCode, blocked.json?.status],
			[1, 'blocked']
		);
		eq('migrate blocked: no request that changes anything', writeKindsSince(mark), []);

		// ---- the real run
		mark = requestLog.length;
		const started = performance.now();
		const real = await migrate('mig-local', 'smoke', '--allow-loss', LOSSES.join(','));
		log(
			`  the run took ${Math.round((performance.now() - started) / 1000)} s, ${requestLog.length - mark} requests (${writesSince(mark).length} writes); the dry run estimated ${JSON.stringify(dry.json?.estimate)}`
		);
		if (real.exitCode !== 0)
			log(
				JSON.stringify(
					{
						verification: real.json?.verification,
						lastError: real.json?.lastError,
						status: real.json?.status,
					},
					null,
					1
				).slice(0, 4000)
			);
		eq('migrate: exit 0 and status completed', [real.exitCode, real.json?.status], [0, 'completed']);
		eq('migrate: created the 7 tasks', real.json?.counts?.created, 7);
		eq('migrate: the read-back found no difference', real.json?.verification?.mismatches, []);

		// ---- what GitLab holds
		const found = (
			await apiAll(`${PROJECT_ROUTE}/issues?state=all&search=${encodeURIComponent(`mig`)}&in=title`)
		).filter(issue => issue.title.startsWith(`${PREFIX} mig `) && issue.title.endsWith(` ${run}`));
		const byName = new Map(
			found.map(issue => [issue.title.replace(`${PREFIX} mig `, '').replace(` ${run}`, ''), issue])
		);
		eq('migrate: seven issues on GitLab', found.length, 7);
		const marker = 'meta:migratedFrom=';
		const labelsWithoutMarker = name =>
			labelsOn(byName.get(name) ?? { labels: [] }).filter(label => !label.startsWith(marker));
		check(
			'migrate: every issue carries the marker of its source in a meta label',
			found.length > 0 && found.every(issue => issue.labels.some(label => label.startsWith(marker))),
			JSON.stringify(found.map(issue => issue.labels))
		);
		eq('migrate: parent: type, label and meta labels', labelsWithoutMarker('parent'), [
			'meta:owner=ann',
			'smoke-planning',
			'type:bug',
		]);
		const parentOf = async name => (await hierarchyOf(byName.get(name))).parentIid;
		const iidOf = name => byName.get(name)?.iid;
		eq(
			'migrate: child one: native Task under the parent',
			[nativeTypeOf(byName.get('child one')), await parentOf('child one')],
			['task', iidOf('parent')]
		);
		eq('migrate: child one: in progress and its type by labels', labelsWithoutMarker('child one'), [
			'status:in-progress',
			'type:chore',
		]);
		eq(
			'migrate: child two: native Task under the parent',
			[nativeTypeOf(byName.get('child two')), await parentOf('child two')],
			['task', iidOf('parent')]
		);
		eq(
			'migrate: child two: in review by its label, description kept',
			[labelsWithoutMarker('child two'), byName.get('child two')?.description],
			[['status:review'], 'A description\nover two lines']
		);
		eq(
			'migrate: the grandchild is attached to no parent (two levels at most)',
			await parentOf('grandchild'),
			undefined
		);
		eq(
			'migrate: blocker: closed without a status label',
			[byName.get('blocker')?.state, labelsWithoutMarker('blocker')],
			['closed', []]
		);
		eq(
			'migrate: cancelled duplicate: closed with the cancelled label',
			[byName.get('duplicate')?.state, labelsWithoutMarker('duplicate')],
			['closed', ['status:cancelled']]
		);
		eq('migrate: outage: the native Incident type', nativeTypeOf(byName.get('outage')), 'incident');
		const linksOf = async name => (await api('GET', `${issueRoute(iidOf(name))}/links`)).body;
		eq(
			'migrate: duplicateOf and causedBy are kept (relate-block: a block in the description and a relates_to link)',
			[
				(byName.get('duplicate')?.description ?? '').includes('"duplicateOf"'),
				(await linksOf('duplicate')).map(link => [link.iid, link.link_type]),
				(byName.get('grandchild')?.description ?? '').includes('"causedBy"'),
				(await linksOf('grandchild')).map(link => [link.iid, link.link_type]),
			],
			[true, [[iidOf('blocker'), 'relates_to']], true, [[iidOf('blocker'), 'relates_to']]]
		);
		eq(
			'migrate: the blockedBy link was lost as declared (no blocking link on GitLab)',
			(await linksOf('child two')).filter(link => link.link_type !== 'relates_to'),
			[]
		);
		const notesOnParent = (await notesOf(iidOf('parent'))).filter(note => !note.system).map(note => note.body);
		check(
			'migrate: the comments are written by the migrating user with the original author on the first line',
			notesOnParent.length === 2 &&
				/^Originally posted \d{4}-\d{2}-\d{2}T[\d:.]+Z by ann \[migrated from [0-9a-f]{8}\/\w{8}#\w+\]/.test(
					notesOnParent[0]
				) &&
				notesOnParent[0].endsWith('First note') &&
				/ by bob /.test(notesOnParent[1]) &&
				notesOnParent[1].endsWith('Second note'),
			JSON.stringify(notesOnParent)
		);
		eq(
			'migrate: blocker has its one comment',
			(await notesOf(iidOf('blocker'))).filter(note => !note.system).length,
			1
		);

		// ---- the same migration again
		mark = requestLog.length;
		const again = await migrate('mig-local', 'smoke', '--allow-loss', LOSSES.join(','));
		eq(
			'migrate again: exit 0, nothing created, everything skipped',
			[again.exitCode, again.json?.counts?.created, again.json?.counts?.skipped],
			[0, 0, 7]
		);
		eq(
			'migrate again: no request that changes anything',
			writeKindsSince(mark).filter(kind => !kind.startsWith('GRAPHQL')),
			[]
		);
		eq(
			'migrate again: still seven issues on GitLab',
			(await apiAll(`${PROJECT_ROUTE}/issues?state=all&search=mig&in=title`)).filter(
				issue => issue.title.startsWith(`${PREFIX} mig `) && issue.title.endsWith(` ${run}`)
			).length,
			7
		);

		// ---- back into a third, local project (the whole GitLab project is read: older issues come too)
		mark = requestLog.length;
		const backRun = await migrate('smoke', 'mig-back', '--allow-loss', 'all');
		if (backRun.exitCode !== 0)
			log(
				JSON.stringify(
					{
						verification: backRun.json?.verification,
						lastError: backRun.json?.lastError,
						status: backRun.json?.status,
					},
					null,
					1
				).slice(0, 4000)
			);
		eq('migrate back: exit 0 and status completed', [backRun.exitCode, backRun.json?.status], [0, 'completed']);
		eq('migrate back: the read-back found no difference', backRun.json?.verification?.mismatches, []);
		const readAll = async name =>
			withCtx(async c => {
				const records = await Promise.all((await c.store.list()).map(summary => c.store.get(summary.id)));
				return new Map(
					records
						.filter(record => record.title.endsWith(` ${run}`) && record.title.includes(' mig '))
						.map(record => [record.title, record])
				);
			}, name);
		const original = await readAll('mig-local');
		const copy = await readAll('mig-back');
		eq('migrate back: the seven tasks are in the copy', copy.size, 7);
		const nameOfIn = (map, id) =>
			[...map.values()]
				.find(record => record.id === id)
				?.title.replace(`${PREFIX} mig `, '')
				.replace(` ${run}`, '');
		const view = (map, record, name) => ({
			status: record.status,
			type: record.type,
			parent: record.parentId === undefined ? undefined : nameOfIn(map, record.parentId),
			description: record.description,
			labels: [...(record.labels ?? [])].sort(),
			meta: Object.fromEntries(Object.entries(record.meta ?? {}).filter(([key]) => key !== 'migratedFrom')),
			duplicateOf: (record.links ?? []).filter(l => l.type === 'duplicateOf').map(l => nameOfIn(map, l.target)),
			causedBy: (record.links ?? []).filter(l => l.type === 'causedBy').map(l => nameOfIn(map, l.target)),
			comments: (record.comments ?? []).map(comment => comment.text.split('\n').pop()),
			name,
		});
		for (const name of seededNames.values()) {
			const t = mig(name);
			const x = original.get(t);
			const y = copy.get(t);
			if (x === undefined || y === undefined) {
				check(`migrate back: ${name}: exists in both projects`, false, `${x === undefined} ${y === undefined}`);
				continue;
			}
			const a = view(original, x, name);
			const b = view(copy, y, name);
			// The documented loss: a third level has no parent on GitLab.
			if (name === 'grandchild') a.parent = undefined;
			eq(`migrate back: ${name}: the same task after the round trip (the declared losses aside)`, b, a);
		}
		eq(
			'migrate back: the blockedBy link is the one loss left (the blocked task has none in the copy)',
			[...copy.values()].flatMap(record => (record.links ?? []).filter(l => l.type === 'blockedBy')),
			[]
		);
		const backAgain = await migrate('smoke', 'mig-back', '--allow-loss', 'all');
		eq(
			'migrate back again: exit 0, nothing created',
			[backAgain.exitCode, backAgain.json?.counts?.created],
			[0, 0]
		);
		writeConfig('smoke', gitlabConfig());
	});

	// ================================================================ reads of issues seeded through the REST API
	const word = `zxqsmoke${run}`;
	const descriptionWord = `zxqdesc${run}`;
	await section('seeding through the REST API', async () => {
		const create = async (text, extra = {}) =>
			(await api('POST', `${PROJECT_ROUTE}/issues`, { title: title(text), ...extra })).body;
		seeded.A = await create('seed parent', {
			description: 'Parent body for the smoke run',
			labels: 'smoke-billing,status:in-progress,type:bug',
		});
		seeded.B = await create('seed shipped');
		await api('PUT', issueRoute(seeded.B.iid), { state_event: 'close' });
		seeded.C = await create('seed cancelled', { labels: 'status:cancelled' });
		await api('PUT', issueRoute(seeded.C.iid), { state_event: 'close' });
		seeded.D = await create('seed outage', { issue_type: 'incident' });
		seeded.E = await create(`seed searchable ${word}`);
		seeded.F = await create('seed described', { description: `the word is only here: ${descriptionWord}` });
		await api('POST', `${issueRoute(seeded.A.iid)}/notes`, { body: 'first note' });
		await api('POST', `${issueRoute(seeded.A.iid)}/notes`, { body: 'second note' });
		await api('PUT', issueRoute(seeded.A.iid), { title: title('seed parent renamed') });
		await api('PUT', issueRoute(seeded.A.iid), { description: 'Parent body for the smoke run, edited' });
		for (const [key, issue] of Object.entries(seeded)) ids[key] = String(issue.iid);
		log(`seeded ${Object.keys(seeded).length} issues through the REST API`);
	});

	await section('reads through the service', async () => {
		await withCtx(async c => {
			const all = await timed('list (all)', () => service.listTasks(c, { showAll: true }));
			const byId = new Map(all.map(task => [task.id, task]));
			for (const [label, key, status] of [
				['A', 'A', 'in-progress'],
				['B', 'B', 'done'],
				['C', 'C', 'cancelled'],
				['D', 'D', 'backlog'],
				['E', 'E', 'backlog'],
				['F', 'F', 'backlog'],
			]) {
				eq(`list: seeded issue ${label} is ${status}`, byId.get(ids[key])?.status, status);
			}
			const shownA = await timed('show A (record: issue, notes, events)', () => c.store.get(ids.A));
			eq('show A: type from the type label', shownA.type, 'bug');
			eq('show A: labels hide the status and the type labels', shownA.labels, ['smoke-billing']);
			eq('show A: description (the edit)', shownA.description, 'Parent body for the smoke run, edited');
			check('show A: title follows the rename', shownA.title.includes('renamed'), shownA.title);
			check(
				'show A: revision is <updated_at>#<one hash per part>',
				/^\d{4}-.*Z#([0-9a-f]{6}\.){5}[0-9a-f]{6}$/.test(shownA.revision),
				shownA.revision
			);
			eq(
				'show A: comments, system notes never listed',
				(shownA.comments ?? []).map(comment => comment.text),
				['first note', 'second note']
			);
			eq('show A: the history ends in the current status', shownA.history.at(-1)?.status, 'in-progress');
			const kinds = (shownA.activity ?? []).map(entry => entry.kind);
			check(
				'show A: the activity has the rename and the description edit (read from the system notes)',
				kinds.includes('title') && kinds.includes('description'),
				JSON.stringify(kinds)
			);
			const notes = await notesOf(ids.A);
			check(
				'the issue holds system notes that the comments leave out',
				notes.some(note => note.system === true) && notes.filter(note => !note.system).length === 2,
				JSON.stringify(notes.map(note => [note.system, note.body.slice(0, 30)]))
			);
			const shownD = await c.store.get(ids.D);
			eq('show D: the native Incident is the type outage', shownD.type, 'outage');
			const roots = await c.store.listPage({ parentId: null, text: run });
			check('listPage parentId null: seeded roots', roots.items.length >= 6, String(roots.items.length));
			eq('children of a root without child', await c.store.getChildren(ids.A), []);
			eq('ancestors of a root', await c.store.getAncestors(ids.A), []);
			const labels = await timed('labels', () => service.listLabels(c));
			check(
				'labels counts smoke-billing once and lists no status or type label',
				labels.some(l => l.label === 'smoke-billing' && l.count === 1) &&
					!labels.some(l => l.label.startsWith('status:')),
				JSON.stringify(labels)
			);
			const activity = await timed('history --all A', () => service.getTaskActivity(c, { id: ids.A }));
			check(
				'activity rows are readable sentences',
				activity.rows.length >= 3 && activity.rows.every(row => row.text !== ''),
				JSON.stringify(activity.rows.map(row => row.text))
			);
		});
		const cliList = await cliJson('list', '--all');
		check(
			'task list --all --json exits 0 and shows the seeded issues',
			cliList.exitCode === 0 && Array.isArray(cliList.json) && cliList.json.some(task => task.id === ids.A),
			cliList.output.slice(0, 200)
		);
		const cliShow = await cliJson('show', ids.F);
		check(
			'task show --json',
			cliShow.exitCode === 0 && cliShow.json?.description === `the word is only here: ${descriptionWord}`,
			cliShow.output.slice(0, 200)
		);
		const cliComments = await cliRun('comments', ids.A);
		check(
			'task comments',
			cliComments.exitCode === 0 && cliComments.output.includes('second note'),
			cliComments.output.slice(0, 200)
		);
		const cliHistory = await cliRun('history', ids.A, '--all');
		check(
			'task history --all',
			cliHistory.exitCode === 0 && /title/i.test(cliHistory.output),
			cliHistory.output.slice(0, 400)
		);
		const cliStatus = await cliRun('status', 'list');
		check('task status list', cliStatus.exitCode === 0 && cliStatus.output.includes('cancelled'), cliStatus.output);
	});

	await section('search', async () => {
		// The server matches the title AND the description (verified live), from one character, with no indexing lag.
		const server = (await apiAll(`${PROJECT_ROUTE}/issues?state=all&search=${encodeURIComponent(run)}`)).filter(i =>
			i.title.includes(run)
		);
		const serverTitle = (
			await api('GET', `${PROJECT_ROUTE}/issues?state=all&search=${encodeURIComponent(word)}`)
		).body.map(i => i.iid);
		const serverDescription = (
			await api('GET', `${PROJECT_ROUTE}/issues?state=all&search=${encodeURIComponent(descriptionWord)}`)
		).body.map(i => i.iid);
		check(
			'the server finds an issue by a word of its title',
			serverTitle.includes(seeded.E.iid),
			JSON.stringify(serverTitle)
		);
		check(
			'the server finds an issue by a word of its description',
			serverDescription.includes(seeded.F.iid),
			JSON.stringify(serverDescription)
		);
		check(
			'the server searches right after the create (no indexing lag)',
			server.length >= 6,
			String(server.length)
		);
		await withCtx(async c => {
			const byTitle = await timed('listPage text (title word)', () => c.store.listPage({ text: word }));
			eq(
				'task search by a word of the title finds it, once',
				byTitle.items.map(task => task.id),
				[ids.E]
			);
			const byDescription = await c.store.listPage({ text: descriptionWord });
			eq(
				'task search counts the title only (the port searches titles): a word of the description alone finds nothing',
				byDescription.items.map(task => task.id),
				[]
			);
			const found = await timed('find', () => service.searchTasks(c, { q: 'seed searchable' }));
			check(
				'find ranks the title match',
				found.some(hit => hit.id === ids.E),
				JSON.stringify(found.map(hit => hit.id))
			);
		});
		const cliFind = await cliRun('find', 'searchable');
		check('task find', cliFind.exitCode === 0 && cliFind.output.includes(ids.E), cliFind.output.slice(0, 200));
	});

	// ================================================================ strategy check
	await section('task strategy check', async () => {
		const target = {
			storage: smoke.resolved.storage,
			project: { id: smoke.resolved.id, name: smoke.resolved.name, path: smoke.resolved.path },
			env: process.env,
		};
		// The check rewrites the title of the first issue (the newest) with the title it has: nothing may change.
		const first = (await api('GET', `${PROJECT_ROUTE}/issues?per_page=1`)).body[0];
		const notesBefore = (await notesOf(first.iid)).length;
		const checked = await timed('strategy check', () => service.checkStrategy(target));
		for (const line of checked.lines) {
			log(
				`  ${line.name.padEnd(13)} ${line.status.padEnd(5)} ${line.text.slice(0, 160)}${line.fix ? `\n  ${' '.repeat(19)}fix: ${line.fix.slice(0, 200)}` : ''}`
			);
		}
		const line = name => checked.lines.find(candidate => candidate.name === name);
		check(
			'strategy check has no error line',
			checked.ok && checked.lines.every(l => l.status !== 'error'),
			checked.lines
				.filter(l => l.status === 'error')
				.map(l => `${l.name}: ${l.text}`)
				.join(' | ')
		);
		check(
			'strategy check: reachable (answered)',
			['ok', 'warn'].includes(line('reachable')?.status) && /answered/.test(line('reachable')?.text ?? ''),
			JSON.stringify(line('reachable'))
		);
		check('strategy check: auth ok', line('auth')?.status === 'ok', JSON.stringify(line('auth')));
		check(
			'strategy check: read enabled',
			line('read')?.status === 'ok' && /^enabled/.test(line('read')?.text ?? ''),
			JSON.stringify(line('read'))
		);
		check(
			'strategy check: write enabled (tested with the no-op PUT)',
			line('write')?.status === 'ok' &&
				/^enabled/.test(line('write')?.text ?? '') &&
				/rewrite of the title/.test(line('write')?.text ?? ''),
			JSON.stringify(line('write'))
		);
		// (updated_at is not compared: whether GitLab moves it for a PUT of the same title right after a note is not settled)
		const afterFirst = await getIssue(first.iid);
		const afterNotes = (await notesOf(first.iid)).length;
		eq(
			'strategy check: the no-op PUT changes nothing (title, description, labels, state, no new note)',
			[afterFirst.title, afterFirst.description, labelsOn(afterFirst), afterFirst.state, afterNotes],
			[first.title, first.description, labelsOn(first), first.state, notesBefore]
		);
		check(
			'strategy check: delete is "not tested" (cannot be probed without deleting)',
			line('delete')?.status === 'ok' && /^not tested/.test(line('delete')?.text ?? ''),
			JSON.stringify(line('delete'))
		);
		check(
			'strategy check: labels-read enabled',
			line('labels-read')?.status === 'ok' && /^enabled/.test(line('labels-read')?.text ?? ''),
			JSON.stringify(line('labels-read'))
		);
		check(
			'strategy check: labels-write is "not tested"',
			line('labels-write')?.status === 'ok' && /^not tested/.test(line('labels-write')?.text ?? ''),
			JSON.stringify(line('labels-write'))
		);
		check(
			'strategy check: hierarchy enabled (work item read through GraphQL)',
			line('hierarchy')?.status === 'ok' && /^enabled/.test(line('hierarchy')?.text ?? ''),
			JSON.stringify(line('hierarchy'))
		);
		for (const name of ['project-info', 'token-info', 'server-info']) {
			check(
				`strategy check: ${name} is "not readable" with this token, and that is ok`,
				line(name)?.status === 'ok' && /not readable/.test(line(name)?.text ?? ''),
				JSON.stringify(line(name))
			);
		}
		check(
			'strategy check: limits reports the quota or its absence',
			['ok', 'warn'].includes(line('limits')?.status) &&
				/requests left|no RateLimit headers/.test(line('limits')?.text ?? ''),
			JSON.stringify(line('limits'))
		);
		check(
			'strategy check: statuses lists the mapping',
			line('statuses')?.status === 'ok' && /5 statuses mapped/.test(line('statuses')?.text ?? ''),
			JSON.stringify(line('statuses'))
		);
		check(
			'strategy check: labels ok (all the labels of the mapping exist after labels sync)',
			line('labels')?.status === 'ok' && /exist/.test(line('labels')?.text ?? ''),
			JSON.stringify(line('labels'))
		);
		check(
			'strategy check: links says blockedBy is refused on the Free tier',
			line('links')?.status === 'ok' && /blockedBy links are refused/.test(line('links')?.text ?? ''),
			JSON.stringify(line('links'))
		);
		check('strategy check: writes line', line('writes')?.status === 'ok', JSON.stringify(line('writes')));
		check(
			'strategy check: verification line is ok and last',
			line('verification')?.status === 'ok' && checked.lines.at(-1)?.name === 'verification',
			JSON.stringify(line('verification'))
		);
		const cliCheck = await cliRun('strategy', 'check');
		check(
			'task strategy check exits 0 with "Result: ok"',
			cliCheck.exitCode === 0 && cliCheck.output.includes('Result: ok'),
			cliCheck.output.slice(-500)
		);
	});

	// ================================================================ writes: create and status
	const gl = {}; // what the sections below share: ids of the tasks of the writes
	const iidNumber = id => Number(id);
	await section('writes: create and status', async () => {
		let mark = requestLog.length;
		const root = await cliJson('new', title('w root'), '--description', 'root body text');
		eq('task new: exit 0, status backlog', [root.exitCode, root.json?.status], [0, 'backlog']);
		gl.root = root.json?.id;
		let g = await getIssue(gl.root);
		eq(
			'new: title, description, no label, open on GitLab',
			[g.title, g.description, labelsOn(g), g.state],
			[title('w root'), 'root body text', [], 'opened']
		);
		eq('new: one POST of the issue and nothing else that changes', writeKindsSince(mark), ['POST /issues']);

		mark = requestLog.length;
		const doneOnCreate = await withCtx(c =>
			timed('create in a terminal status (POST + PUT)', () =>
				c.store.create({ title: title('w done on create'), status: 'done' })
			)
		);
		g = await getIssue(doneOnCreate.id);
		eq(
			'create in a terminal status: closed, no status label, read back as done',
			[g.state, labelsOn(g), doneOnCreate.status],
			['closed', [], 'done']
		);
		eq(
			'create in a terminal status: a POST then a PUT (GitLab ignores the state of a create)',
			writeKindsSince(mark),
			['POST /issues', 'PUT /issues/N']
		);
		const cancelledOnCreate = await withCtx(c =>
			c.store.create({ title: title('w cancelled on create'), status: 'cancelled' })
		);
		g = await getIssue(cancelledOnCreate.id);
		eq(
			'create cancelled: closed with the cancelled label',
			[g.state, labelsOn(g)],
			['closed', ['status:cancelled']]
		);

		// one PUT each, never an intermediate state
		for (const [status, state, labels] of [
			['in-progress', 'opened', ['status:in-progress']],
			['review', 'opened', ['status:review']],
			['done', 'closed', []],
			['cancelled', 'closed', ['status:cancelled']],
			['backlog', 'opened', []],
			['in-progress', 'opened', ['status:in-progress']],
		]) {
			mark = requestLog.length;
			const moved = await cliJson('set-status', gl.root, status);
			g = await getIssue(gl.root);
			eq(
				`set-status ${status}: GitLab holds ${state} and labels ${JSON.stringify(labels)}, in one PUT`,
				[moved.exitCode, g.state, labelsOn(g), writeKindsSince(mark)],
				[0, state, labels, ['PUT /issues/N']]
			);
		}
		const shown = await withCtx(c => c.store.get(gl.root));
		log(`  history of the root: ${JSON.stringify(shown.history?.map(h => h.status))}`);
		eq(
			'history: each status change appears once, in order, with no intermediate state',
			shown.history?.map(entry => entry.status),
			['backlog', 'in-progress', 'review', 'done', 'cancelled', 'backlog', 'in-progress']
		);
		mark = requestLog.length;
		const same = await cliRun('set-status', gl.root, 'in-progress');
		check(
			'the current status is refused (exit 1), nothing written',
			same.exitCode === 1 && /already in status/.test(same.output) && writeKindsSince(mark).length === 0,
			same.output
		);
		const unknown = await cliRun('set-status', gl.root, 'nowhere');
		check('an unknown status is refused (exit 1)', unknown.exitCode === 1, unknown.output);
	});

	await section('writes: title, description, quick actions', async () => {
		let mark = requestLog.length;
		const renamed = await cliJson('set-title', gl.root, title('w root renamed'));
		let g = await getIssue(gl.root);
		eq(
			'set-title renames the issue in one PUT',
			[renamed.exitCode, g.title, writeKindsSince(mark)],
			[0, title('w root renamed'), ['PUT /issues/N']]
		);
		const described = await cliJson('set-description', gl.root, 'line one\r\nline two');
		g = await getIssue(gl.root);
		eq(
			'set-description with CRLF: GitLab holds LF',
			[described.exitCode, g.description],
			[0, 'line one\nline two']
		);
		const back = await withCtx(c => c.store.get(gl.root));
		eq('set-description: read back as written without the CR', back.description, 'line one\nline two');
		// GitLab RUNS a line such as /close: it is refused before any request
		mark = requestLog.length;
		const quick = await cliRun('set-description', gl.root, 'before\n/close');
		const sent = requestLog.slice(mark).map(entry => entry.kind);
		g = await getIssue(gl.root);
		check(
			'a description with a quick action line is refused (exit 1, explicit, nothing sent that changes anything, nothing changed)',
			quick.exitCode === 1 &&
				/quick action/.test(quick.output) &&
				sent.every(kind => kind.startsWith('GET ')) &&
				g.state === 'opened' &&
				g.description === 'line one\nline two',
			`${quick.output} ${JSON.stringify(sent)}`
		);
		log(`  (the refusal sent ${sent.length} request(s): ${JSON.stringify(sent)})`);
		mark = requestLog.length;
		const quickNew = await cliRun('new', title('w never created'), '--description', 'Fine\n/label ~oops');
		check(
			'a new task whose description has a quick action line is refused before any request',
			quickNew.exitCode === 1 && /quick action/.test(quickNew.output) && writeKindsSince(mark).length === 0,
			quickNew.output
		);
		const quickComment = await cliRun('comment', gl.root, 'ok\n/relate #1');
		check(
			'a comment with a quick action line is refused before any request',
			quickComment.exitCode === 1 &&
				/quick action/.test(quickComment.output) &&
				writeKindsSince(mark).length === 0,
			quickComment.output
		);
		// a path in the middle of a line is not a command
		const path_ = await cliJson('set-description', gl.root, 'see /usr/bin/node\nand a/b');
		g = await getIssue(gl.root);
		eq(
			'a path in a description is not a quick action',
			[path_.exitCode, g.description],
			[0, 'see /usr/bin/node\nand a/b']
		);
	});

	await section('writes: type', async () => {
		const typeLabels = g => labelsOn(g).filter(label => label.startsWith('type:'));
		let mark = requestLog.length;
		let moved = await cliJson('set-type', gl.root, 'bug');
		let g = await getIssue(gl.root);
		eq(
			'set-type bug (label): the label type:bug, native type untouched',
			[moved.exitCode, typeLabels(g), nativeTypeOf(g), moved.json?.type],
			[0, ['type:bug'], 'issue', 'bug']
		);
		moved = await cliJson('set-type', gl.root, 'outage');
		g = await getIssue(gl.root);
		eq(
			'set-type outage (native incident): the issue becomes an Incident and the type label is dropped',
			[moved.exitCode, typeLabels(g), nativeTypeOf(g), moved.json?.type],
			[0, [], 'incident', 'outage']
		);
		moved = await cliJson('set-type', gl.root, 'bug');
		g = await getIssue(gl.root);
		eq(
			'set-type bug again: ONE type, the Incident goes back to an Issue',
			[moved.exitCode, typeLabels(g), nativeTypeOf(g)],
			[0, ['type:bug'], 'issue']
		);
		mark = requestLog.length;
		moved = await cliJson('set-type', gl.root, 'chore');
		g = await getIssue(gl.root);
		eq(
			'set-type chore (a label type): the label is added, the Incident goes back to an Issue',
			[moved.exitCode, typeLabels(g), nativeTypeOf(g), moved.json?.type],
			[0, ['type:chore'], 'issue', 'chore']
		);
		check(
			'a task type never converts to a native Task: no GraphQL mutation',
			!writeKindsSince(mark).includes('GRAPHQL write'),
			JSON.stringify(writeKindsSince(mark))
		);
		const untyped = await cliJson('unset-type', gl.root);
		g = await getIssue(gl.root);
		eq(
			'unset-type: no type label and the native type is an Issue again',
			[untyped.exitCode, typeLabels(g), nativeTypeOf(g)],
			[0, [], 'issue']
		);
		// test_case: refused when the configuration is loaded, before any request
		writeConfig('smoke', gitlabConfig({ typeMap: '            bug: { issueType: test_case }\n' }));
		mark = requestLog.length;
		const testCase = await cliRun('list');
		check(
			'typeMap issueType test_case is refused when the config is loaded, naming test_case, before any request',
			testCase.exitCode === 1 && /test_case/.test(testCase.output) && requestLog.length === mark,
			`${testCase.output} ${requestLog.length - mark} request(s)`
		);
		const parsed = gitlabOptions.parseGitLabOptions({
			project,
			tokenEnv: TOKEN_VARIABLE,
			statusMap: { backlog: { state: 'open' }, done: { state: 'closed' } },
			typeMap: { bug: { issueType: 'test_case' } },
		});
		check(
			'the options parser names test_case and the alternatives',
			'problem' in parsed && /test_case/.test(parsed.problem) && /incident or a label/.test(parsed.problem),
			JSON.stringify(parsed)
		);
		writeConfig('smoke', gitlabConfig());
	});

	await section('writes: labels and meta', async () => {
		const names = g => labelsOn(g);
		let mark = requestLog.length;
		const added = await cliJson('add-label', gl.root, `smoke-${run}`);
		let g = await getIssue(gl.root);
		eq(
			'add-label creates a missing label on the fly and adds it',
			[added.exitCode, names(g).includes(`smoke-${run}`)],
			[0, true]
		);
		const removed = await cliJson('remove-label', gl.root, `smoke-${run}`);
		g = await getIssue(gl.root);
		eq('remove-label removes it', [removed.exitCode, names(g).includes(`smoke-${run}`)], [0, false]);
		// labels are case sensitive on GitLab: two labels, each added and removed on its own
		await cliRun('add-label', gl.root, `Case-${run}`);
		await api('PUT', issueRoute(gl.root), { add_labels: `case-${run}` });
		g = await getIssue(gl.root);
		eq(
			'labels are case sensitive: Case-x and case-x are two labels',
			[names(g).includes(`Case-${run}`), names(g).includes(`case-${run}`)],
			[true, true]
		);
		await cliRun('remove-label', gl.root, `Case-${run}`);
		g = await getIssue(gl.root);
		eq(
			'removing Case-x leaves case-x',
			[names(g).includes(`Case-${run}`), names(g).includes(`case-${run}`)],
			[false, true]
		);
		// scoped-looking labels are plain labels on Free: no exclusivity, both are kept (one added by task, one on GitLab)
		await cliRun('add-label', gl.root, `team::red-${run}`);
		await api('PUT', issueRoute(gl.root), { add_labels: `team::blue-${run}` });
		g = await getIssue(gl.root);
		eq(
			'a team::x label is a plain label on Free: two of the same scope are both kept',
			[names(g).includes(`team::red-${run}`), names(g).includes(`team::blue-${run}`)],
			[true, true]
		);
		const plain = await withCtx(c => c.store.get(gl.root));
		check(
			'and task reads them as plain labels',
			[`case-${run}`, `team::red-${run}`, `team::blue-${run}`].every(label => plain.labels.includes(label)),
			JSON.stringify(plain.labels)
		);
		mark = requestLog.length;
		const reserved = await cliRun('add-label', gl.root, 'status:review');
		check(
			'a status label cannot be added as a plain label (exit 1, nothing written)',
			reserved.exitCode === 1 && /reserved/.test(reserved.output) && writeKindsSince(mark).length === 0,
			reserved.output
		);
		const comma = await cliRun('add-label', gl.root, 'a,b');
		check(
			'a label with a comma is refused (exit 1, nothing written)',
			comma.exitCode === 1 && /comma/.test(comma.output) && writeKindsSince(mark).length === 0,
			comma.output
		);
		const tombstone = await cliRun('add-label', gl.root, 'task:deleted');
		check(
			'the tombstone label cannot be added as a plain label',
			tombstone.exitCode === 1 && /reserved/.test(tombstone.output) && writeKindsSince(mark).length === 0,
			tombstone.output
		);

		// meta as labels (fills.meta: labels)
		const m1 = await cliJson('set-meta', gl.root, 'owner', 'ann');
		g = await getIssue(gl.root);
		eq(
			'set-meta (fills.meta: labels): the label meta:owner=ann',
			[m1.exitCode, names(g).includes('meta:owner=ann'), m1.json?.meta?.owner],
			[0, true, 'ann']
		);
		mark = requestLog.length;
		await cliRun('set-meta', gl.root, 'owner', 'bob');
		g = await getIssue(gl.root);
		eq(
			'set-meta again: the old label is replaced in ONE PUT',
			[names(g).filter(label => label.startsWith('meta:')), writeKindsSince(mark)],
			[['meta:owner=bob'], ['PUT /issues/N']]
		);
		const shown = await withCtx(c => c.store.get(gl.root));
		eq(
			'the meta reads back and its label is not a plain label',
			[shown.meta, (shown.labels ?? []).some(label => label.startsWith('meta:'))],
			[{ owner: 'bob' }, false]
		);
		await cliRun('unset-meta', gl.root, 'owner');
		g = await getIssue(gl.root);
		check('unset-meta removes the label', !names(g).some(label => label.startsWith('meta:')));
		const reservedMeta = await cliRun('add-label', gl.root, 'meta:owner=x');
		check(
			'a meta label cannot be added as a plain label',
			reservedMeta.exitCode === 1 && /reserved/.test(reservedMeta.output),
			reservedMeta.output
		);
	});

	await section('writes: comments', async () => {
		const added = await cliJson('comment', gl.root, 'first live note');
		check('comment adds a comment (as the user of the token)', added.exitCode === 0, added.output.slice(0, 300));
		const listed = await cliJson('comments', gl.root);
		const notes = await notesOf(gl.root);
		check(
			'the comments are the non-system notes only (title and description edits left system notes)',
			listed.exitCode === 0 &&
				notes.some(note => note.system === true) &&
				listed.json?.length === notes.filter(note => !note.system).length &&
				listed.json?.length === 1,
			`${listed.output.slice(0, 300)} / ${JSON.stringify(notes.map(note => [note.system, note.body.slice(0, 20)]))}`
		);
		const commentId = listed.json?.[0]?.id;
		await cliRun('comment-edit', gl.root, commentId, 'edited live note');
		check(
			'comment-edit changes the text',
			(await notesOf(gl.root)).some(
				note => String(note.id) === String(commentId) && note.body === 'edited live note'
			)
		);
		await cliRun('comment-rm', gl.root, commentId);
		check('comment-rm removes it', !(await notesOf(gl.root)).some(note => String(note.id) === String(commentId)));
		const authored = await cliRun('comment', gl.root, 'x', '--author', 'ann');
		check(
			'a chosen author is refused (exit 1, --author named)',
			authored.exitCode === 1 && /--author/.test(authored.output),
			authored.output
		);
		const system = (await notesOf(gl.root)).find(note => note.system === true);
		const tryEdit = await cliRun('comment-edit', gl.root, String(system?.id), 'rewrite history');
		check(
			'a system note cannot be edited as a comment (exit 1)',
			system !== undefined && tryEdit.exitCode === 1,
			tryEdit.output
		);
	});

	await section('writes: links', async () => {
		ids.l1 = (await cliJson('new', title('w link one'))).json?.id;
		ids.l2 = (await cliJson('new', title('w link two'))).json?.id;
		let mark = requestLog.length;
		const blocked = await cliRun('link', ids.l1, 'blockedBy', ids.l2);
		check(
			'blockedBy is refused with the paid-tier message (exit 1, nothing written)',
			blocked.exitCode === 1 &&
				blocked.output.includes('requires a paid GitLab tier, which task does not support') &&
				writeKindsSince(mark).length === 0,
			blocked.output
		);
		const links = async n => (await api('GET', `${issueRoute(n)}/links`)).body;
		const first = await cliRun('link', ids.l1, 'duplicateOf', ids.l2);
		let g = await getIssue(ids.l1);
		eq(
			'link duplicateOf (relate-block): the entry in the description block and ONE relates_to link',
			[
				first.exitCode,
				g.description.includes('"duplicateOf"'),
				(await links(ids.l1)).map(l => [String(l.iid), l.link_type]),
			],
			[0, true, [[ids.l2, 'relates_to']]]
		);
		const shown = await withCtx(c => c.store.get(ids.l1));
		eq(
			'the duplicate reads back: the link, and the description without the block',
			[shown.links, shown.description ?? ''],
			[[{ type: 'duplicateOf', target: ids.l2 }], '']
		);
		const inverse = await cliJson('links', ids.l2);
		check(
			'the original lists its duplicate (read from the block of the other issue)',
			inverse.exitCode === 0 && inverse.json?.duplicates?.map(task => task.id).includes(ids.l1),
			inverse.output.slice(0, 300)
		);
		await cliRun('link', ids.l1, 'causedBy', ids.l2);
		eq('link causedBy on the same pair: still ONE relates_to link', (await links(ids.l1)).length, 1);
		const repeat = await cliRun('link', ids.l1, 'causedBy', ids.l2);
		check(
			'the same link twice is refused (exit 1)',
			repeat.exitCode === 1 && /already causedBy/.test(repeat.output),
			repeat.output
		);
		const cycle = await cliRun('link', ids.l2, 'causedBy', ids.l1);
		check(
			'a link cycle is refused with the cycle spelled out',
			cycle.exitCode === 1 && /cycle/.test(cycle.output),
			cycle.output
		);
		await cliRun('unlink', ids.l1, 'duplicateOf', ids.l2);
		eq(
			'unlink duplicateOf: the relates_to link stays because causedBy still needs it',
			(await links(ids.l1)).length,
			1
		);
		await cliRun('unlink', ids.l1, 'causedBy', ids.l2);
		g = await getIssue(ids.l1);
		eq(
			'unlink causedBy: the link and the block are gone',
			[(await links(ids.l1)).length, g.description ?? ''],
			[0, '']
		);
		mark = requestLog.length;
		const selfLink = await cliRun('link', ids.l1, 'causedBy', ids.l1);
		check(
			'a link to itself is refused (exit 1)',
			selfLink.exitCode === 1 && writeKindsSince(mark).length === 0,
			selfLink.output
		);
		check(
			'a warning says duplicateOf is emulated',
			stderrLines.join('').includes('duplicateOf is emulated'),
			stderrLines.join('').slice(-300)
		);
	});

	await section('hierarchy', async () => {
		const create = async text => (await cliJson('new', title(text))).json?.id;
		const hp1 = await create('h parent one');
		const hp2 = await create('h parent two');
		const hx = await create('h issue to convert');
		const hlone = await create('h lone');
		const hinc = await create('h incident');
		await cliRun('set-type', hinc, 'outage');
		gl.hp1 = hp1;
		const parentOf = async n => (await hierarchyOf(await getIssue(n))).parentIid;
		const childrenOf = async n => (await hierarchyOf(await getIssue(n))).childIids;

		// a child created under a parent is a native Task
		let mark = requestLog.length;
		const child = await cliJson('new', title('h child'), '--parent', hp1);
		const hc = child.json?.id;
		eq(
			'new --parent: a native Task under the parent',
			[child.exitCode, nativeTypeOf(await getIssue(hc)), await parentOf(hc)],
			[0, 'task', iidNumber(hp1)]
		);
		eq(
			'new --parent: the issue is created as a Task by the POST, the parent is set with GraphQL',
			writeKindsSince(mark),
			['POST /issues', 'GRAPHQL write']
		);
		// set-parent converts an Issue child to a native Task
		mark = requestLog.length;
		const moved = await cliRun('set-parent', hx, hp1);
		eq(
			'set-parent: an Issue child is converted to a native Task, then attached',
			[moved.exitCode, nativeTypeOf(await getIssue(hx)), await parentOf(hx), writeKindsSince(mark)],
			[0, 'task', iidNumber(hp1), ['GRAPHQL write', 'GRAPHQL write']]
		);
		const again = await cliRun('set-parent', hx, hp1);
		check('set-parent to the parent it already has is a no-op', again.exitCode === 0, again.output);

		// reads
		await withCtx(async c => {
			eq('children of the parent', (await c.store.getChildren(hp1)).map(t => t.id).sort(), [hc, hx].sort());
			eq(
				'ancestors of a child',
				(await c.store.getAncestors(hx)).map(t => t.id),
				[hp1]
			);
			const tree = await c.store.getTree(hp1);
			eq('tree of the parent', tree.children.map(node => node.id).sort(), [hc, hx].sort());
			const full = await c.store.getFullTree(hx);
			eq(
				'full tree of a child is rooted at its parent, the child is selected',
				[full.id, full.children.find(node => node.selected)?.id],
				[hp1, hx]
			);
			const summaries = await c.store.list();
			eq(
				'list: the parent of each child',
				[
					summaries.find(t => t.id === hc)?.parentId,
					summaries.find(t => t.id === hx)?.parentId,
					summaries.find(t => t.id === hp1)?.parentId,
				],
				[hp1, hp1, undefined]
			);
			const page = await c.store.listPage({ parentId: hp1 });
			eq('listPage parentId: the children', page.items.map(t => t.id).sort(), [hc, hx].sort());
			const roots = await c.store.listPage({ parentId: null, text: 'h parent' });
			// Older runs left issues titled alike in the same project: keep this run's (its tag ends every title).
			eq(
				'listPage parentId null: the roots only',
				roots.items
					.filter(t => t.title.endsWith(run))
					.map(t => t.id)
					.sort(),
				[hp1, hp2].sort()
			);
		});
		const cliChildren = await cliRun('children', hp1);
		check(
			'task children',
			cliChildren.exitCode === 0 && cliChildren.output.includes(hc) && cliChildren.output.includes(hx),
			cliChildren.output.slice(0, 300)
		);
		const cliTree = await cliRun('tree', hx);
		check('task tree', cliTree.exitCode === 0 && cliTree.output.includes(hp1), cliTree.output.slice(0, 300));

		// activity of the hierarchy (system notes)
		await withCtx(async c => {
			const recordChild = await c.store.get(hc);
			const recordParent = await c.store.get(hp1);
			check(
				'the activity of a child has its parent (system note "added #N as parent item")',
				(recordChild.activity ?? []).some(entry => entry.kind === 'parent' && entry.newValue === hp1),
				JSON.stringify(recordChild.activity)
			);
			check(
				'the activity of the parent has its children',
				(recordParent.activity ?? []).filter(entry => entry.kind === 'child-added').length === 2,
				JSON.stringify(recordParent.activity)
			);
		});
		check(
			'GitLab wrote the system note of the parent itself',
			(await notesOf(hc)).some(
				note => note.system === true && note.body.includes(`added #${hp1} as parent item`)
			),
			''
		);

		// replace, then remove
		await cliRun('set-parent', hx, hp2);
		eq(
			'set-parent moves the child to another parent',
			[await parentOf(hx), await childrenOf(hp1), await childrenOf(hp2)],
			[iidNumber(hp2), [iidNumber(hc)], [iidNumber(hx)]]
		);
		const detached = await cliRun('remove-parent', hx);
		eq(
			'remove-parent detaches it, the native type stays Task',
			[detached.exitCode, await parentOf(hx), nativeTypeOf(await getIssue(hx))],
			[0, undefined, 'task']
		);
		const noParent = await cliRun('remove-parent', hx);
		check(
			'remove-parent on a root task is refused (exit 1)',
			noParent.exitCode === 1 && /has no parent/.test(noParent.output),
			noParent.output
		);
		// a child keeps its native type when its task type is a label
		const typedChild = await cliRun('set-type', hc, 'bug');
		const gc = await getIssue(hc);
		eq(
			'set-type bug on a child (a label): the child stays a native Task under its parent',
			[typedChild.exitCode, nativeTypeOf(gc), labelsOn(gc).includes('type:bug'), await parentOf(hc)],
			[0, 'task', true, iidNumber(hp1)]
		);

		// the refusals: nothing that changes anything is sent, nothing changes
		const refused = async (name, args, pattern) => {
			const markRefusal = requestLog.length;
			const result = await cliRun(...args);
			check(
				`refused: ${name} (exit 1, ${pattern})`,
				result.exitCode === 1 && pattern.test(result.output) && writeKindsSince(markRefusal).length === 0,
				`${result.output} ${JSON.stringify(writeKindsSince(markRefusal))}`
			);
		};
		await refused(
			'a parent that is already a child (depth)',
			['set-parent', hlone, hc],
			/hierarchy depth|already a child/
		);
		await refused('a child that has children (depth)', ['set-parent', hp1, hp2], /hierarchy depth|child items/);
		await refused('a native Task as the parent', ['set-parent', hlone, hx], /native Task/);
		await refused('an Incident as the child', ['set-parent', hinc, hp1], /Incident/);
		await refused('a cycle', ['set-parent', hp1, hc], /cycle/);
		await refused('an Incident type for a child', ['set-type', hc, 'outage'], /native Task/);
		eq(
			'after the refusals GitLab still holds the same tree',
			[await childrenOf(hp1), await childrenOf(hp2), await parentOf(hlone), nativeTypeOf(await getIssue(hinc))],
			[[iidNumber(hc)], [], undefined, 'incident']
		);

		// created closed under a parent: the parent is set BEFORE the closing
		mark = requestLog.length;
		const closedChild = await withCtx(c =>
			c.store.create({ title: title('h closed child'), status: 'cancelled', parentId: hp2 })
		);
		const gcc = await getIssue(closedChild.id);
		eq(
			'create in a terminal status under a parent: closed, cancelled label, parent set',
			[gcc.state, labelsOn(gcc), await parentOf(closedChild.id)],
			['closed', ['status:cancelled'], iidNumber(hp2)]
		);
		eq(
			'create in a terminal status under a parent: POST, parent, then the closing PUT',
			writeKindsSince(mark).filter(kind => kind !== 'GRAPHQL read'),
			['POST /issues', 'GRAPHQL write', 'PUT /issues/N']
		);
		gl.hc = hc;
		gl.hp2 = hp2;
	});

	await section('history and activity of the writes', async () => {
		const activity = await withCtx(c => service.getTaskActivity(c, { id: gl.root }));
		const kinds = [...new Set(activity.rows.map(row => row.kind))].sort();
		log(`  activity kinds of the root: ${JSON.stringify(kinds)}`);
		log(`  ${activity.rows.length} rows, e.g. ${JSON.stringify(activity.rows.slice(0, 3).map(row => row.text))}`);
		log(
			`  rows of kind other: ${JSON.stringify(activity.rows.filter(row => row.kind === 'other').map(row => row.text))}`
		);
		check(
			'the activity of the root has its status changes, titles, descriptions, types, labels and meta',
			['status', 'title', 'description', 'type'].every(kind => kinds.includes(kind)),
			JSON.stringify(kinds)
		);
		const cliHistory = await cliRun('history', gl.root, '--all');
		check(
			'task history --all shows the writes (title edited, status, type)',
			cliHistory.exitCode === 0 && /title/i.test(cliHistory.output) && /type/i.test(cliHistory.output),
			cliHistory.output.slice(0, 600)
		);
	});

	await section('consistency: expectedRevision against changes made on GitLab', async () => {
		await withCtx(async c => {
			const base = await c.store.get(gl.root);
			await api('POST', `${issueRoute(gl.root)}/notes`, { body: 'a note from someone else' });
			const afterComment = await timed('setTitle with the revision of before a comment', () =>
				c.store.setTitle(gl.root, title('w root renamed twice'), { expectedRevision: base.revision })
			);
			check(
				'a comment made on GitLab is not a conflict for a rename',
				afterComment.title === title('w root renamed twice'),
				afterComment.title
			);
			const base2 = await c.store.get(gl.root);
			await api('PUT', issueRoute(gl.root), { title: title('w renamed on GitLab') });
			let stale;
			try {
				await c.store.addLabel(gl.root, `rev-${run}`, { expectedRevision: base2.revision });
			} catch (error) {
				stale = error;
			}
			check(
				'a rename made on GitLab is not a conflict for a label write (only the parts a write changes are compared)',
				stale === undefined,
				String(stale)
			);
			let conflict;
			try {
				await c.store.setTitle(gl.root, title('w mine'), { expectedRevision: base2.revision });
			} catch (error) {
				conflict = error;
			}
			check(
				'a rename made on GitLab since the read is a StaleRevisionError for a rename',
				conflict?.name === 'StaleRevisionError',
				String(conflict)
			);
			check(
				'and nothing was written',
				(await getIssue(gl.root)).title === title('w renamed on GitLab'),
				(await getIssue(gl.root)).title
			);
			let alien;
			try {
				await c.store.setTitle(gl.root, title('w mine'), {
					expectedRevision: 'not-a-revision-of-this-backend',
				});
			} catch (error) {
				alien = error;
			}
			check(
				'a revision this backend did not issue is stale for any write',
				alien?.name === 'StaleRevisionError',
				String(alien)
			);
			await c.store.removeLabel(gl.root, `rev-${run}`);
		});
	});

	await section('delete: refused without a fill, tombstone, hard', async () => {
		writeConfig('smoke', gitlabConfig({ fills: 'none' }));
		const victim = (await cliJson('new', title('d victim'))).json?.id;
		let mark = requestLog.length;
		const refused = await cliRun('delete', victim);
		check(
			'delete without a fill is refused (exit 1, the fills named, nothing written)',
			refused.exitCode === 1 &&
				/tombstone/.test(refused.output) &&
				/hard/.test(refused.output) &&
				writeKindsSince(mark).length === 0,
			refused.output
		);
		check('and the issue is untouched', (await getIssue(victim)).state === 'opened');

		// tombstone (config with the fill): the parent is detached from its children first
		writeConfig('smoke', gitlabConfig());
		const parent = gl.hp2;
		const closedChild = (await withCtx(c => c.store.getChildren(parent)))[0]?.id;
		check('the parent of the tombstone test has a child', closedChild !== undefined);
		mark = requestLog.length;
		const gone = await cliRun('delete', parent);
		let g = await getIssue(parent);
		eq(
			'delete (tombstone): closed with the label task:deleted, one close',
			[gone.exitCode, g.state, labelsOn(g).includes('task:deleted')],
			[0, 'closed', true]
		);
		const listAfter = (await cliJson('list', '--all')).json ?? [];
		check('the tombstone is hidden from list --all', !listAfter.some(task => task.id === parent));
		eq('its child became a root task', (await hierarchyOf(await getIssue(closedChild))).parentIid, undefined);
		check('a warning says delete is emulated', stderrLines.join('').includes('delete is emulated'));
		const again = await cliRun('delete', parent);
		check(
			'deleting a tombstone again finds nothing to delete',
			/Nothing to delete/.test(again.output),
			again.output
		);

		// hard
		writeConfig('smoke', gitlabConfig({ fills: 'hard' }));
		const doomed = (await cliJson('new', title('d doomed'))).json?.id;
		const hardDelete = await cliRun('delete', doomed);
		const afterHard = await api('GET', issueRoute(doomed), undefined, { allow: [404] });
		eq('delete (hard): the issue is gone (404)', [hardDelete.exitCode, afterHard.status], [0, 404]);
		const shown = await cliRun('show', doomed);
		check('show of the deleted task is a not-found (exit 1)', shown.exitCode === 1, shown.output);
		const next = (await cliJson('new', title('d after'))).json?.id;
		check(
			'the iid of a deleted issue is never reused',
			iidNumber(next) > iidNumber(doomed),
			`${doomed} then ${next}`
		);
		writeConfig('smoke', gitlabConfig());
	});

	await section('status:: and type:: labels (plain labels on Free)', async () => {
		writeConfig('smoke', gitlabConfig({ statusPrefix: 'status::', typePrefix: 'type::' }));
		const wantedNames = [
			'status::in-progress',
			'status::review',
			'status::cancelled',
			'type::bug',
			'type::chore',
			'task:deleted',
		];
		const beforeNames = new Set((await projectLabels()).map(label => label.name));
		const synced = await cliJson('labels', 'sync');
		eq(
			'labels sync with status:: and type:: prefixes creates the missing mapped labels, scoped-looking names included',
			[synced.exitCode, [...(synced.json?.created ?? [])].sort()],
			[0, wantedNames.filter(name => !beforeNames.has(name)).sort()]
		);
		const checked = await cliRun('strategy', 'check');
		check(
			'strategy check with the status:: prefix: ok, the labels line sees them all',
			checked.exitCode === 0 &&
				checked.output.includes('Result: ok') &&
				/the 6 labels the mapping uses exist/.test(checked.output),
			checked.output.slice(-900)
		);
		const created = await cliJson('new', title('b scoped'));
		const b1 = created.json?.id;
		await cliRun('set-type', b1, 'bug');
		const sequence = [];
		for (const status of ['in-progress', 'review', 'done']) {
			const mark = requestLog.length;
			await cliRun('set-status', b1, status);
			const g = await getIssue(b1);
			sequence.push([status, g.state, labelsOn(g), writeKindsSince(mark)]);
		}
		eq(
			'set-status with status:: labels: one PUT each, ONE status label at any time (the wrapper enforces what GitLab Free does not)',
			sequence,
			[
				['in-progress', 'opened', ['status::in-progress', 'type::bug'], ['PUT /issues/N']],
				['review', 'opened', ['status::review', 'type::bug'], ['PUT /issues/N']],
				['done', 'closed', ['type::bug'], ['PUT /issues/N']],
			]
		);
		const shown = await withCtx(c => c.store.get(b1));
		eq(
			'status:: labels read back: status, type, no label shown',
			[shown.status, shown.type, shown.labels ?? []],
			['done', 'bug', []]
		);
		const mark = requestLog.length;
		const reserved = await cliRun('add-label', b1, 'status::review');
		check(
			'a status:: label cannot be added as a plain label',
			reserved.exitCode === 1 && /reserved/.test(reserved.output) && writeKindsSince(mark).length === 0,
			reserved.output
		);
		writeConfig('smoke', gitlabConfig());
	});

	await section('list pagination', async () => {
		const pgWord = `pgz${run}`;
		const pageIds = [];
		for (let index = 1; index <= 5; index++) {
			pageIds.push(
				String(
					(await api('POST', `${PROJECT_ROUTE}/issues`, { title: title(`page ${index} ${pgWord}`) })).body.iid
				)
			);
		}
		writeConfig('smoke', gitlabConfig({ pageSize: 2 }));
		await withCtx(async c => {
			const mark = requestLog.length;
			const all = await timed('listPage text over 3 pages (pageSize 2)', () =>
				c.store.listPage({ text: pgWord })
			);
			eq(
				'5 tasks over pages of 2, in creation order',
				all.items.map(task => task.id),
				pageIds
			);
			eq(
				'and the strategy followed the Link header: 3 list requests',
				requestLog.slice(mark).filter(entry => entry.kind === 'GET /issues').length,
				3
			);
			const pages = [];
			let cursor;
			for (let guard = 0; guard < 10; guard++) {
				const page = await c.store.listPage({
					text: pgWord,
					limit: 2,
					...(cursor === undefined ? {} : { cursor }),
				});
				pages.push(page.items.map(task => task.id));
				cursor = page.nextCursor;
				if (cursor === undefined) break;
			}
			eq('limit 2 with cursors: three pages, the last one without a cursor', pages, [
				pageIds.slice(0, 2),
				pageIds.slice(2, 4),
				pageIds.slice(4),
			]);
		});
		writeConfig('smoke', gitlabConfig());
	});

	await section('the token stays in the environment', async () => {
		eq('the token appears in no output of the strategy (stdout, stderr)', leaked, 0);
		// every file the run wrote: registry, config, logs, journals
		const found = [];
		const walk = dir => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const file = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(file);
				else if (fs.readFileSync(file, 'utf8').includes(token)) found.push(path.relative(world, file));
			}
		};
		walk(world);
		eq('the token is written in no file of the isolated world (config, registry, logs, journals)', found, []);
	});
} catch (error) {
	exitCode = 1;
	log(`\nlive-gitlab-smoke: FAILED with an exception: ${error instanceof Error ? error.stack : error}`);
} finally {
	// ---------------------------------------------------------------- cleanup (always)
	log('\n== cleanup');
	try {
		await rateGuard();
		const open = (
			await apiAll(`${PROJECT_ROUTE}/issues?state=all&search=${encodeURIComponent(run)}&in=title`)
		).filter(issue => issue.title.startsWith(PREFIX) && issue.title.includes(run));
		let closed = 0;
		for (const issue of open) {
			if (issue.state === 'closed' && issue.labels.length === 0) continue;
			try {
				await rateGuard();
				await api('PUT', issueRoute(issue.iid), {
					...(issue.state === 'closed' ? {} : { state_event: 'close' }),
					// A closed issue must not keep a status label: the next run would read it as a state no status maps.
					labels: '',
				});
				closed += 1;
			} catch (error) {
				exitCode = 1;
				log(`  could not close #${issue.iid}: ${error.message}`);
			}
		}
		let deletedLabels = 0;
		if (!preexistingKnown) log('  no label deleted: the labels that existed before the run were never read');
		for (const label of preexistingKnown ? await projectLabels() : []) {
			// NEVER: a label that existed, a group label, the label type::toto.
			if (preexisting.has(label.name) || label.is_project_label === false || label.name === 'type::toto')
				continue;
			try {
				await rateGuard();
				await api('DELETE', `${PROJECT_ROUTE}/labels/${encodeURIComponent(label.name)}`);
				deletedLabels += 1;
			} catch (error) {
				exitCode = 1;
				log(`  could not delete the label ${label.name}: ${error.message}`);
			}
		}
		log(
			`  closed ${closed} issue(s) of this run, deleted ${deletedLabels} label(s) the run created (existing labels untouched)`
		);
		await rateGuard();
		const leftoverOpen = (
			await apiAll(`${PROJECT_ROUTE}/issues?state=opened&search=${encodeURIComponent(run)}&in=title`)
		).filter(issue => issue.title.startsWith(PREFIX) && issue.title.includes(run));
		check(
			'cleanup: no issue of the run is left open',
			leftoverOpen.length === 0,
			leftoverOpen.map(i => `#${i.iid}`).join(', ')
		);
		const labelsNow = await projectLabels();
		const leftover = (preexistingKnown ? labelsNow : []).filter(
			label => !preexisting.has(label.name) && label.is_project_label !== false && label.name !== 'type::toto'
		);
		check('cleanup: no label of the run is left', leftover.length === 0, leftover.map(l => l.name).join(', '));
		check(
			'cleanup: every label that existed before is still there',
			[...preexisting.keys()].every(name => labelsNow.some(label => label.name === name)),
			[...preexisting.keys()].filter(name => !labelsNow.some(label => label.name === name)).join(', ')
		);
	} catch (error) {
		exitCode = 1;
		log(`  could not verify the cleanup: ${error.message}`);
	}
	if (lastRate !== undefined) {
		log(
			`\n== rate limit: ${lastRate.remaining} of ${lastRate.limit} requests left in the window at the end (RateLimit-Remaining; at the start: ${rateAtStart === undefined ? 'unknown' : rateAtStart.remaining})`
		);
	}
	try {
		log('\n== timings of the steps (ms, requests)');
		for (const step of stepTimings)
			log(`  ${String(step.ms).padStart(6)}  ${String(step.requests).padStart(3)}  ${step.name}`);
		const counts = {
			total: requestLog.length,
			direct: requestLog.filter(e => e.direct).length,
			writes: writesSince(0).length,
		};
		log(
			`\n  ${counts.total} requests (${counts.direct} by the script, ${counts.total - counts.direct} by the strategy, ${counts.writes} of them writes), ${guardWaits} wait(s) of the script, ${rateNotices} notice(s) of the strategy, total ${Math.round((performance.now() - startedAt) / 1000)} s`
		);
		if (jsonFile !== undefined) {
			fs.writeFileSync(
				jsonFile,
				redact(
					JSON.stringify(
						{
							target: useMock ? 'mock' : 'live',
							assertions: results,
							timings: stepTimings,
							requests: {
								...counts,
								rateLimitRemaining: lastRate?.remaining,
								rateLimit: lastRate?.limit,
							},
						},
						null,
						2
					)
				)
			);
		}
	} catch (error) {
		exitCode = 1;
		log(`  could not write the summary: ${error instanceof Error ? error.message : error}`);
	} finally {
		// The mock and the temp world go away whatever happened above.
		if (fake !== undefined) await fake.stop();
		fs.rmSync(world, { recursive: true, force: true });
	}
}

const failed = results.filter(r => !r.ok);
log(
	`\nlive-gitlab-smoke: ${results.length - failed.length} of ${results.length} assertions passed${failedSections > 0 ? `, ${failedSections} section(s) did not run to the end` : ''}${failed.length > 0 ? `; FAILED: ${failed.map(f => f.name).join(' | ')}` : ''}`
);
process.exit(failed.length > 0 ? 1 : exitCode);
