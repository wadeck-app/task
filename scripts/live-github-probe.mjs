// Records the CONFORMANCE FIXTURE of the GitHub fake (fakeGitHub.testkit.ts) against the REAL GitHub API. NOT part of `npm test` or CI:
// run it by hand.
//
//   npm run build
//   GH_TEST_TOKEN=<fine-grained token: Issues read/write + Metadata read on the repo> \
//   GH_TEST_REPO=<owner/name of a THROWAWAY repository> \
//   node scripts/live-github-probe.mjs scenario [--record <file>]
//
//   node scripts/live-github-probe.mjs scenario --mock [--record <file>]   (dry check against the local fake: no token, no network)
//
// `scenario` runs scripts/github-conformance-scenario.mjs: about 300 requests, writes spaced by 1.5 s, a few sleeps for the indexes
// that lag (about 10 minutes). `--record <file>` writes the sanitized fixture
// (packages/task-service/src/plugins/github/fixtures/live-conformance.json). GH_SCENARIO_FROM="<step name>" records only the tail of
// the scenario from that step (the variables of the earlier steps are then missing: only for steps that need none).
//
// Every object created here is an issue titled "[task-api-test] ..." or a label named "conf-<run>-...". Cleanup ALWAYS runs: every
// issue of the run is closed as not_planned (a hard-deleted one is gone) and every label named conf-<run>* is deleted (labels that
// existed before the run are left alone). The token is read from the environment only and is redacted from every output.
// Exit codes: 0 done, 1 the scenario or the cleanup failed, 2 the environment is not set.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const mock = args.includes('--mock');
const recordIndex = args.indexOf('--record');
const recordFile = recordIndex >= 0 ? args[recordIndex + 1] : undefined;
const sections = args.filter((a, i) => !a.startsWith('--') && (recordIndex < 0 || i !== recordIndex + 1));
if (sections.length !== 1 || sections[0] !== 'scenario' || (recordIndex >= 0 && recordFile === undefined)) {
	console.error('usage: node scripts/live-github-probe.mjs scenario [--mock] [--record <file>]');
	process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..');
let token = process.env.GH_TEST_TOKEN ?? '';
const repo = process.env.GH_TEST_REPO ?? (mock ? 'wadeck-app/temp-test-api-for-issues' : '');
if (!mock && (token === '' || repo === '')) {
	console.error(
		[
			'live-github-probe: GH_TEST_TOKEN and GH_TEST_REPO must both be set; nothing was run.',
			'  GH_TEST_TOKEN  a fine-grained token with Issues read/write and Metadata read on the repository',
			'  GH_TEST_REPO   owner/name of a THROWAWAY repository (for example wadeck-app/temp-test-api-for-issues)',
		].join('\n')
	);
	process.exit(2);
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
	console.error(`live-github-probe: GH_TEST_REPO "${repo}" is not of the form owner/name.`);
	process.exit(2);
}

let fake;
let API = 'https://api.github.com';
if (mock) {
	const fakeFile = path.join(root, 'packages/task-service/dist/plugins/github/fakeGitHub.testkit.js');
	if (!fs.existsSync(fakeFile)) {
		console.error(`live-github-probe: ${fakeFile} does not exist. Run: npm run build`);
		process.exit(2);
	}
	const { FakeGitHub } = await import(pathToFileURL(fakeFile).href);
	fake = await FakeGitHub.start({
		repo,
		tokenExpiration: '2026-11-15 14:04:02 UTC',
		issueTypes: ['Task', 'Bug', 'Feature'],
	});
	token = fake.token;
	API = fake.baseUrl;
}

const redact = text => String(text).split(token).join('<token>');
const run = Math.random().toString(36).slice(2, 8);
const WRITE_SPACING_MS = mock ? 0 : 1500;
let lastWriteAt = 0;
let requestCount = 0;
let remaining = Infinity;

/** One request. Reads are not throttled; a write starts at least WRITE_SPACING_MS after the previous one. */
async function call(label, method, route, body, opts = {}) {
	const isWrite = method !== 'GET';
	if (isWrite) {
		const wait = lastWriteAt + WRITE_SPACING_MS - Date.now();
		if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
		lastWriteAt = Date.now();
	}
	if (remaining <= 40)
		throw new Error(
			`live-github-probe: only ${remaining} requests are left in the hourly quota; stopped before ${label}.`
		);
	const url = route.startsWith('http') ? route : `${API}/${route}`;
	const headers = {
		'user-agent': 'task-live-probe',
		accept: 'application/vnd.github+json',
		'x-github-api-version': '2022-11-28',
	};
	if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? token}`;
	if (body !== undefined && opts.rawBody === undefined) headers['content-type'] = 'application/json';
	Object.assign(headers, opts.headers ?? {});
	const payload = opts.rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
	for (let attempt = 0; ; attempt += 1) {
		const started = performance.now();
		requestCount += 1;
		const response = await fetch(url, { method, headers, body: payload });
		const text = await response.text();
		const ms = Math.round(performance.now() - started);
		const left = Number(response.headers.get('x-ratelimit-remaining'));
		if (Number.isFinite(left) && response.headers.get('x-ratelimit-resource') === 'core') remaining = left;
		const retryAfter = Number(response.headers.get('retry-after'));
		// A secondary limit refuses the request, so sending it again is safe; once only.
		if ((response.status === 403 || response.status === 429) && Number.isFinite(retryAfter) && attempt === 0) {
			console.log(`  (secondary limit on ${label}: waiting ${retryAfter} s, then trying once more)`);
			await new Promise(resolve => setTimeout(resolve, (retryAfter + 1) * 1000));
			continue;
		}
		let json;
		try {
			json = text === '' ? undefined : JSON.parse(text);
		} catch {
			json = undefined;
		}
		const picked = {};
		for (const [name, value] of response.headers.entries()) picked[name] = redact(value);
		return { label, method, route, status: response.status, ms, headers: picked, json, text: redact(text) };
	}
}

const track = { issues: new Set(), labels: new Set() };
let exitCode = 0;
let preexisting = new Set();

async function allPages(route) {
	const items = [];
	for (let page = 1; page < 40; page += 1) {
		const r = await call(
			'cleanup list',
			'GET',
			`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`
		);
		if (r.status !== 200 || !Array.isArray(r.json))
			throw new Error(`cannot list ${route}: ${r.status} ${r.text.slice(0, 200)}`);
		items.push(...r.json);
		if (r.json.length < 100) break;
	}
	return items;
}

async function cleanup() {
	console.log('\n== cleanup');
	let closed = 0;
	for (const number of track.issues) {
		const r = await call('cleanup close', 'PATCH', `repos/${repo}/issues/${number}`, {
			state: 'closed',
			state_reason: 'not_planned',
		});
		// 410: the issue was deleted by the scenario (GraphQL deleteIssue).
		if (r.status === 200) closed += 1;
		else if (r.status !== 410) {
			console.log(`  CLEANUP: closing #${number} answered ${r.status}`);
			exitCode = 1;
		}
	}
	console.log(`  issues closed: ${closed} of ${track.issues.size}`);
	let deleted = 0;
	const labels = await allPages(`repos/${repo}/labels`);
	for (const label of labels) {
		const name = label.name;
		if (!name.toLowerCase().startsWith(`conf-${run}`) || preexisting.has(name.toLowerCase())) continue;
		const r = await call('cleanup label', 'DELETE', `repos/${repo}/labels/${encodeURIComponent(name)}`);
		if (r.status === 204) deleted += 1;
		else {
			console.log(`  CLEANUP: deleting label "${name}" answered ${r.status}`);
			exitCode = 1;
		}
	}
	console.log(`  labels deleted: ${deleted}`);
}

try {
	console.log(`live-github-probe: ${mock ? 'LOCAL FAKE' : API}, repository ${repo}, run ${run}`);
	const rate = await call('preflight', 'GET', 'rate_limit');
	if (rate.status !== 200) {
		console.error(
			`live-github-probe: GET /rate_limit answered ${rate.status}: ${rate.text.slice(0, 200)}. Nothing was run.`
		);
		process.exit(rate.status === 401 ? 3 : 1);
	}
	console.log(
		`  core quota: ${rate.json.resources.core.remaining} of ${rate.json.resources.core.limit}; search: ${rate.json.resources.search.remaining}`
	);
	const expires = rate.headers['github-authentication-token-expiration'];
	if (expires !== undefined) console.log(`  token expires: ${expires}`);
	const info = await call('preflight repo', 'GET', `repos/${repo}`);
	if (info.status !== 200) {
		console.error(
			`live-github-probe: GET /repos/${repo} answered ${info.status}: ${info.text.slice(0, 200)}. Nothing was run.`
		);
		process.exit(1);
	}
	console.log(
		`  repository: private=${info.json.private} has_issues=${info.json.has_issues} permissions=${JSON.stringify(info.json.permissions)}`
	);
	preexisting = new Set((await allPages(`repos/${repo}/labels`)).map(label => label.name.toLowerCase()));
	console.log(`  labels that exist before the run: ${preexisting.size}`);

	console.log('\n== scenario');
	const scenario = await import(pathToFileURL(path.join(root, 'scripts/github-conformance-scenario.mjs')).href);
	const recorded = await scenario.runScenario({
		call,
		repo,
		run,
		apiBase: API,
		track,
		source: 'api.github.com (fine-grained token), organization repository wadeck-app/temp-test-api-for-issues',
	});
	const counts = new Map();
	for (const step of recorded.steps) counts.set(step.expect.status, (counts.get(step.expect.status) ?? 0) + 1);
	console.log(
		`\n  ${recorded.steps.length} steps, statuses: ${[...counts]
			.sort((a, b) => a[0] - b[0])
			.map(([s, n]) => `${s}x${n}`)
			.join(' ')}`
	);
	if (recordFile !== undefined) {
		fs.mkdirSync(path.dirname(path.resolve(recordFile)), { recursive: true });
		fs.writeFileSync(recordFile, `${JSON.stringify(recorded, null, '\t')}\n`);
		console.log(`  wrote ${recorded.steps.length} steps to ${recordFile}`);
	}
} catch (error) {
	console.log(`\n  SCENARIO CRASHED: ${redact(error?.stack ?? error)}`);
	exitCode = 1;
} finally {
	try {
		await cleanup();
	} catch (error) {
		console.log(`  CLEANUP CRASHED: ${redact(error?.stack ?? error)}`);
		exitCode = 1;
	}
	console.log(`\n  requests sent: ${requestCount}; core quota left: ${remaining}`);
	if (fake !== undefined) await fake.stop();
}
process.exit(exitCode);
