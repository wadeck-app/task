// LIVE DISCOVERY of the GitLab REST v4 / GraphQL behaviour the gitlab strategy depends on. NOT part of `npm test` or CI: run it by hand.
//
//   GL_TEST_TOKEN=<token> GL_TEST_PROJECT=group/project node scripts/live-gitlab-probe.mjs [section ...] [--record <file>]
//
// Sections (default: all but `ratelimit`, which burns the quota on purpose): identity crud labels events notes links workitems
// pagination search errors delete misc scenario ratelimit. `--record <file>` writes the sanitized conformance fixture of the
// `scenario` section (see gitlab-conformance-scenario.mjs); GL_PROBE_OUT=<file> writes every sanitized request/response pair.
//
// The token is read from the environment only and is redacted from every output. Every object created here is prefixed
// "[task-api-test]"; the run closes its issues and deletes the labels it created (also on failure). Only the project named by
// GL_TEST_PROJECT is touched, on gitlab.com, with plain `fetch` (no glab CLI). GL_TEST_BASE may only point at a 127.0.0.1 mock.
// Exit codes: 0 done, 1 a section crashed, 2 the environment is not set.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const token = process.env.GL_TEST_TOKEN ?? '';
const projectPath = process.env.GL_TEST_PROJECT ?? '';
if (token === '' || projectPath === '') {
	console.error(
		[
			'live-gitlab-probe: GL_TEST_TOKEN and GL_TEST_PROJECT must both be set; nothing was run.',
			'  GL_TEST_TOKEN    a token with access to the throwaway project (fine-grained: issue, label, note, link permissions)',
			'  GL_TEST_PROJECT  group/project path of a THROWAWAY project on gitlab.com',
		].join('\n')
	);
	process.exit(2);
}
const BASE = process.env.GL_TEST_BASE ?? 'https://gitlab.com/api/v4';
if (!/^https:\/\/gitlab\.com\/api\/v4$|^http:\/\/127\.0\.0\.1:\d+\/api\/v4$/.test(BASE)) {
	console.error(`live-gitlab-probe: GL_TEST_BASE "${BASE}" must be https://gitlab.com/api/v4 or a 127.0.0.1 mock.`);
	process.exit(2);
}
const args = process.argv.slice(2);
const recordIndex = args.indexOf('--record');
const recordFile = recordIndex >= 0 ? args[recordIndex + 1] : undefined;
const requested = args.filter((a, i) => !a.startsWith('--') && (recordIndex < 0 || i !== recordIndex + 1));

const redact = text => String(text).split(token).join('<token>');
const P = `projects/${encodeURIComponent(projectPath)}`;
const PREFIX = '[task-api-test]';
const run = Math.random().toString(36).slice(2, 8);
const title = text => `${PREFIX} ${text} ${run}`;

// ---- the client: throttled by the RateLimit headers (the free plan allows 100 requests per window) ----
const KEY_HEADERS = [
	'etag',
	'last-modified',
	'link',
	'retry-after',
	'ratelimit-limit',
	'ratelimit-name',
	'ratelimit-observed',
	'ratelimit-remaining',
	'ratelimit-reset',
	'ratelimit-resettime',
	'www-authenticate',
	'x-next-page',
	'x-prev-page',
	'x-page',
	'x-per-page',
	'x-total',
	'x-total-pages',
	'content-type',
	'location',
	'allow',
	'cache-control',
	'x-gitlab-meta',
];
let quota = { remaining: 100, reset: 0 };
const pairs = [];
const latencies = new Map();
let requestCount = 0;

async function call(label, method, route, body, opts = {}) {
	if (quota.remaining <= 4 && quota.reset * 1000 > Date.now() && opts.noThrottle !== true) {
		const wait = quota.reset * 1000 - Date.now() + 1500;
		console.log(`  (throttle: waiting ${Math.ceil(wait / 1000)} s for the rate-limit window)`);
		await new Promise(resolve => setTimeout(resolve, wait));
	}
	const url = route.startsWith('http')
		? route
		: route.startsWith('graphql')
			? BASE.replace(/\/v4$/, '/graphql')
			: `${BASE}/${route}`;
	const headers = { 'user-agent': 'task-live-probe' };
	if (opts.token !== null) headers['private-token'] = opts.token ?? token;
	if (body !== undefined && opts.rawBody === undefined) headers['content-type'] = 'application/json';
	Object.assign(headers, opts.headers ?? {});
	const started = performance.now();
	requestCount += 1;
	const response = await fetch(url, {
		method,
		headers,
		body: opts.rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
	});
	const text = await response.text();
	const ms = Math.round(performance.now() - started);
	let json;
	try {
		json = text === '' ? undefined : JSON.parse(text);
	} catch {
		json = undefined;
	}
	const picked = {};
	for (const name of KEY_HEADERS) {
		const value = response.headers.get(name);
		if (value !== null) picked[name] = redact(value);
	}
	const remaining = Number(response.headers.get('ratelimit-remaining'));
	const reset = Number(response.headers.get('ratelimit-reset'));
	if (Number.isFinite(remaining) && Number.isFinite(reset)) quota = { remaining, reset };
	const key = `${method} ${route.replace(/%2F/gi, '/').replace(/\d+/g, 'N').replace(/\?.*/, '')}`;
	latencies.set(key, [...(latencies.get(key) ?? []), ms]);
	const result = { label, method, route, status: response.status, ms, headers: picked, json, text: redact(text) };
	pairs.push({
		label,
		request: {
			method,
			route: redact(route),
			body: body === undefined ? undefined : JSON.parse(redact(JSON.stringify(body))),
		},
		response: { status: response.status, headers: picked, body: json ?? redact(text).slice(0, 400) },
	});
	return result;
}

function short(value, max = 260) {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text === undefined ? '' : text.length > max ? `${text.slice(0, max)}...` : text;
}
function show(r, pick) {
	let detail;
	if (r.json === undefined) detail = short(r.text.replace(/\s+/g, ' '));
	else if (pick && r.status < 300) detail = short(Array.isArray(r.json) ? r.json.map(pick) : pick(r.json), 400);
	else detail = short(r.json, 300);
	const extra = ['etag', 'x-total', 'retry-after', 'link'].filter(
		h => r.headers[h] !== undefined && !(h === 'link' && !pick)
	);
	console.log(
		`  ${r.status} ${String(r.ms).padStart(4)}ms ${r.label}: ${detail}${extra.length ? ` {${extra.map(h => `${h}: ${short(r.headers[h], 90)}`).join('; ')}}` : ''}`
	);
	return r;
}
const step = async (...a) => show(await call(...a));
const stepPick = async (pick, ...a) => show(await call(...a), pick);

// ---- cleanup bookkeeping ----
const created = { issues: new Set(), labels: new Set(), notes: [] };
async function newIssue(text, extra = {}) {
	const r = await call(`create ${text}`, 'POST', `${P}/issues`, { title: title(text), ...extra });
	if (r.status !== 201) {
		show(r);
		throw new Error(`cannot create "${text}": ${r.status}`);
	}
	created.issues.add(r.json.iid);
	return r.json;
}
async function newLabel(name, extra = {}) {
	const r = await call(`create label ${short(name, 30)}`, 'POST', `${P}/labels`, {
		name,
		color: '#428BCA',
		...extra,
	});
	if (r.status === 201) created.labels.add(name);
	return r;
}
const issueRoute = iid => `${P}/issues/${iid}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const labelsOf = j => (j?.labels ?? []).slice().sort();

const sections = {};

// ---------------------------------------------------------------- identity, permissions, tier
sections.identity = async () => {
	await step('no token', 'GET', 'version', undefined, { token: null });
	await step('bad token', 'GET', 'version', undefined, { token: 'glpat-not-a-real-token' });
	await step('GET /version', 'GET', 'version');
	await step('GET /metadata', 'GET', 'metadata');
	await step('GET /user', 'GET', 'user');
	await step('GET /personal_access_tokens/self', 'GET', 'personal_access_tokens/self');
	const project = await stepPick(
		p => ({
			id: p.id,
			path: p.path_with_namespace,
			visibility: p.visibility,
			issues_access_level: p.issues_access_level,
			issues_enabled: p.issues_enabled,
			archived: p.archived,
			permissions: p.permissions,
			namespace: p.namespace,
			empty_repo: p.empty_repo,
		}),
		'GET project',
		'GET',
		P
	);
	const ns = project.json?.namespace;
	if (ns) {
		await step('GET namespaces/:id', 'GET', `namespaces/${ns.id}`);
		await step('GET namespaces/:path (plan)', 'GET', `namespaces/${encodeURIComponent(ns.full_path)}`);
		await step('GET groups/:id', 'GET', `groups/${ns.id}`);
	}
	await step('GET project members/all (access level)', 'GET', `${P}/members/all`);
	await step('GET project languages (cheap read)', 'GET', `${P}/languages`);
	await step('GET issues_statistics', 'GET', `${P}/issues_statistics`);
	await step('GET projects/:id/issues?per_page=1', 'GET', `${P}/issues?per_page=1`);
	await step('GET labels?per_page=1', 'GET', `${P}/labels?per_page=1`);
	await step('GET project hooks (settings; expect denied)', 'GET', `${P}/hooks`);
	await step('GET graphql viewer', 'POST', 'graphql', { query: '{ currentUser { username } }' });
	await step('GET graphql project', 'POST', 'graphql', {
		query: `{ project(fullPath: "${projectPath}") { id fullPath } }`,
	});
};

// ---------------------------------------------------------------- issue CRUD, limits
sections.crud = async () => {
	const a = await newIssue('crud', { description: 'first', labels: 'zz-crud-a,zz-crud-b' });
	for (const l of ['zz-crud-a', 'zz-crud-b']) created.labels.add(l);
	console.log(`  keys: ${Object.keys(a).join(',')}`);
	console.log(`  iid ${a.iid} id ${a.id} issue_type ${a.issue_type} type ${a.type} web_url ${a.web_url}`);
	await stepPick(i => ({ iid: i.iid, state: i.state, labels: i.labels }), 'GET by iid', 'GET', issueRoute(a.iid));
	await step('GET by global id (project route)', 'GET', `${P}/issues/${a.id}`);
	await step('GET global /issues/:id', 'GET', `issues/${a.id}`);
	await step('GET iid 99999', 'GET', issueRoute(99999));
	await step('GET iid abc', 'GET', issueRoute('abc'));
	await step('GET project 404', 'GET', 'projects/999999999/issues/1');
	await step('GET project path 404', 'GET', `projects/${encodeURIComponent('wadeck-app/does-not-exist')}/issues/1`);

	// create validation
	await step('create without title', 'POST', `${P}/issues`, { description: 'x' });
	await step('create empty title', 'POST', `${P}/issues`, { title: '' });
	await step('create blank title', 'POST', `${P}/issues`, { title: '   ' });
	await step('create empty body', 'POST', `${P}/issues`, undefined);
	await step('create title number', 'POST', `${P}/issues`, { title: 123 });
	await step('create issue_type bogus', 'POST', `${P}/issues`, { title: title('bogus'), issue_type: 'bogus' });
	for (const long of [255, 256, 257, 1000, 5000]) {
		const r = await call(`create title ${long}`, 'POST', `${P}/issues`, {
			title: `${PREFIX} ${'t'.repeat(long - PREFIX.length - 1)}`,
		});
		show(r, i => ({ len: i.title?.length }));
		if (r.status === 201) created.issues.add(r.json.iid);
	}
	for (const type of ['incident', 'test_case', 'task']) {
		const r = await call(`create issue_type ${type}`, 'POST', `${P}/issues`, {
			title: title(`type ${type}`),
			issue_type: type,
		});
		show(r, i => ({ iid: i.iid, issue_type: i.issue_type, type: i.type, web_url: i.web_url }));
		if (r.status === 201) created.issues.add(r.json.iid);
	}
	await step('create with state closed', 'POST', `${P}/issues`, { title: title('state'), state: 'closed' }).then(
		r => {
			if (r.status === 201) created.issues.add(r.json.iid);
			console.log(`    -> state of created: ${r.json?.state}`);
		}
	);
	await step('create with state_event close', 'POST', `${P}/issues`, {
		title: title('state_event'),
		state_event: 'close',
	}).then(r => {
		if (r.status === 201) created.issues.add(r.json.iid);
		console.log(`    -> state of created: ${r.json?.state}`);
	});
	await step('create with labels as array', 'POST', `${P}/issues`, {
		title: title('label array'),
		labels: ['zz-arr-1', 'zz-arr-2'],
	}).then(r => {
		if (r.status === 201) {
			created.issues.add(r.json.iid);
			created.labels.add('zz-arr-1');
			created.labels.add('zz-arr-2');
		}
	});
	await step('create duplicate labels', 'POST', `${P}/issues`, {
		title: title('dup labels'),
		labels: 'zz-dup,zz-dup,ZZ-DUP',
	}).then(r => {
		if (r.status === 201) {
			created.issues.add(r.json.iid);
			created.labels.add('zz-dup');
			console.log(`    -> labels: ${JSON.stringify(r.json.labels)}`);
		}
	});
	// description size
	const big = 'd'.repeat(1_048_576);
	const bigIssue = await call('create description 1048576', 'POST', `${P}/issues`, {
		title: title('big'),
		description: big,
	});
	console.log(
		`  ${bigIssue.status} ${bigIssue.ms}ms ${bigIssue.label}: ${short(bigIssue.json?.message ?? bigIssue.text, 120)}`
	);
	if (bigIssue.status === 201) created.issues.add(bigIssue.json.iid);
	const bigger = await call('create description 1048577', 'POST', `${P}/issues`, {
		title: title('bigger'),
		description: big + 'x',
	});
	console.log(`  ${bigger.status} ${bigger.ms}ms ${bigger.label}: ${short(bigger.json ?? bigger.text, 200)}`);
	if (bigger.status === 201) created.issues.add(bigger.json.iid);

	// update
	await stepPick(i => ({ title: i.title, ua: i.updated_at }), 'PUT title', 'PUT', issueRoute(a.iid), {
		title: title('crud renamed'),
	});
	await step('PUT empty title', 'PUT', issueRoute(a.iid), { title: '' });
	await step('PUT no params', 'PUT', issueRoute(a.iid), {});
	await step('PUT unknown param', 'PUT', issueRoute(a.iid), { bogus: 1 });
	await step('PUT description null', 'PUT', issueRoute(a.iid), { description: null });
	await step('PUT description empty', 'PUT', issueRoute(a.iid), { description: '' });
	await step('PUT description CRLF', 'PUT', issueRoute(a.iid), { description: 'a\r\nb  \r\n' }).then(r =>
		console.log(`    -> ${JSON.stringify(r.json?.description)}`)
	);
	await step('PUT state_event bogus', 'PUT', issueRoute(a.iid), { state_event: 'bogus' });
	const c1 = await stepPick(
		i => ({ state: i.state, closed_at: i.closed_at }),
		'PUT state_event close',
		'PUT',
		issueRoute(a.iid),
		{ state_event: 'close' }
	);
	await stepPick(
		i => ({ state: i.state, ua: i.updated_at, ca: i.closed_at }),
		'PUT state_event close again',
		'PUT',
		issueRoute(a.iid),
		{ state_event: 'close' }
	);
	await stepPick(i => ({ state: i.state, ua: i.updated_at }), 'PUT state_event reopen', 'PUT', issueRoute(a.iid), {
		state_event: 'reopen',
	});
	await stepPick(i => ({ state: i.state }), 'PUT state_event reopen again', 'PUT', issueRoute(a.iid), {
		state_event: 'reopen',
	});
	await step('PUT state (not a param)', 'PUT', issueRoute(a.iid), { state: 'closed' }).then(r =>
		console.log(`    -> state ${r.json?.state}`)
	);
	await step('PUT reopen back', 'PUT', issueRoute(a.iid), { state_event: 'reopen' });
	void c1;
	// labels
	await stepPick(labelsOf, 'PUT labels replace', 'PUT', issueRoute(a.iid), { labels: 'zz-crud-c' });
	await stepPick(labelsOf, 'PUT add_labels', 'PUT', issueRoute(a.iid), { add_labels: 'zz-crud-a,zz-crud-b' });
	await stepPick(labelsOf, 'PUT remove_labels', 'PUT', issueRoute(a.iid), { remove_labels: 'zz-crud-a' });
	await stepPick(labelsOf, 'PUT remove unknown label', 'PUT', issueRoute(a.iid), {
		remove_labels: 'zz-never-existed',
	});
	await stepPick(labelsOf, 'PUT remove label not on issue', 'PUT', issueRoute(a.iid), { remove_labels: 'zz-crud-a' });
	await stepPick(labelsOf, 'PUT add label twice', 'PUT', issueRoute(a.iid), { add_labels: 'zz-crud-b,zz-crud-b' });
	await stepPick(labelsOf, 'PUT labels+add_labels together', 'PUT', issueRoute(a.iid), {
		labels: 'zz-crud-x',
		add_labels: 'zz-crud-y',
	});
	await stepPick(labelsOf, 'PUT labels+remove_labels together', 'PUT', issueRoute(a.iid), {
		labels: 'zz-crud-x,zz-crud-y',
		remove_labels: 'zz-crud-x',
	});
	await stepPick(labelsOf, 'PUT labels empty string', 'PUT', issueRoute(a.iid), { labels: '' });
	await stepPick(labelsOf, 'PUT labels array', 'PUT', issueRoute(a.iid), { labels: ['zz-crud-a', 'zz-crud-b'] });
	await stepPick(labelsOf, 'PUT labels null', 'PUT', issueRoute(a.iid), { labels: null });
	await stepPick(labelsOf, 'PUT label with comma in array', 'PUT', issueRoute(a.iid), { labels: ['zz-crud,comma'] });
	for (const l of ['zz-crud-c', 'zz-crud-x', 'zz-crud-y']) created.labels.add(l);
	// issue_type update
	for (const type of ['incident', 'test_case', 'task', 'issue', 'bogus']) {
		await stepPick(i => ({ issue_type: i.issue_type }), `PUT issue_type ${type}`, 'PUT', issueRoute(a.iid), {
			issue_type: type,
		});
	}
	// 100 labels per issue
	const names = Array.from({ length: 101 }, (_, i) => `zz-n${i}`);
	const many = await call('PUT 101 labels', 'PUT', issueRoute(a.iid), { labels: names.join(',') });
	console.log(
		`  ${many.status} ${many.ms}ms 101 labels: ${short(many.json?.message ?? many.json?.labels?.length ?? many.text, 200)}`
	);
	for (const n of names) created.labels.add(n);
	const hundred = await call('PUT 100 labels', 'PUT', issueRoute(a.iid), { labels: names.slice(0, 100).join(',') });
	console.log(
		`  ${hundred.status} ${hundred.ms}ms 100 labels: ${short(hundred.json?.message ?? hundred.json?.labels?.length ?? hundred.text, 200)}`
	);
	await step('PUT labels clear', 'PUT', issueRoute(a.iid), { labels: '' });

	// concurrency / conditional
	const g1 = await call('GET for etag', 'GET', issueRoute(a.iid));
	const etag = g1.headers.etag;
	console.log(`  etag ${etag} last-modified ${g1.headers['last-modified']}`);
	await step('GET If-None-Match', 'GET', issueRoute(a.iid), undefined, { headers: { 'if-none-match': etag } });
	await step('GET If-None-Match (list)', 'GET', `${P}/issues?per_page=5`).then(async r => {
		if (r.headers.etag)
			await step('GET list If-None-Match', 'GET', `${P}/issues?per_page=5`, undefined, {
				headers: { 'if-none-match': r.headers.etag },
			});
	});
	await step('GET If-Modified-Since', 'GET', issueRoute(a.iid), undefined, {
		headers: { 'if-modified-since': new Date(Date.now() + 60_000).toUTCString() },
	});
	await step(
		'PUT If-Match stale',
		'PUT',
		issueRoute(a.iid),
		{ title: title('ifmatch') },
		{ headers: { 'if-match': '"nope"' } }
	);
	await step(
		'PUT If-Unmodified-Since old',
		'PUT',
		issueRoute(a.iid),
		{ title: title('ifunmod') },
		{ headers: { 'if-unmodified-since': 'Mon, 01 Jan 2001 00:00:00 GMT' } }
	);
	await step('PUT updated_at param old', 'PUT', issueRoute(a.iid), {
		title: title('updated_at'),
		updated_at: '2001-01-01T00:00:00Z',
	}).then(r => console.log(`    -> updated_at now ${r.json?.updated_at}`));
	const lock = await call('GET lock_version?', 'GET', issueRoute(a.iid));
	console.log(`  lock_version in issue: ${'lock_version' in (lock.json ?? {})}`);
	// updated_at bumping
	const base = (await call('GET base', 'GET', issueRoute(a.iid))).json;
	await sleep(1100);
	const afterSame = (await call('PUT same title', 'PUT', issueRoute(a.iid), { title: base.title })).json;
	console.log(
		`  updated_at: base ${base.updated_at} / same-title PUT ${afterSame.updated_at} (bumped: ${base.updated_at !== afterSame.updated_at})`
	);
	await sleep(1100);
	const afterLabel = (await call('PUT add label', 'PUT', issueRoute(a.iid), { add_labels: 'zz-crud-a' })).json;
	console.log(
		`  after add label ${afterLabel.updated_at} (bumped: ${afterSame.updated_at !== afterLabel.updated_at})`
	);
	await sleep(1100);
	await call('note', 'POST', `${issueRoute(a.iid)}/notes`, { body: 'bump' });
	const afterNote = (await call('GET after note', 'GET', issueRoute(a.iid))).json;
	console.log(
		`  after note ${afterNote.updated_at} (bumped: ${afterLabel.updated_at !== afterNote.updated_at}), user_notes_count ${afterNote.user_notes_count}`
	);
	return a;
};

// ---------------------------------------------------------------- labels
sections.labels = async () => {
	const keep = r => ({
		id: r.id,
		name: r.name,
		color: r.color,
		description: r.description,
		is_project_label: r.is_project_label,
		priority: r.priority,
	});
	await stepPick(keep, 'list labels', 'GET', `${P}/labels?per_page=100`);
	await stepPick(keep, 'create label', 'POST', `${P}/labels`, {
		name: 'zz-lab-1',
		color: '#FF0000',
		description: 'probe label',
	}).then(r => r.status === 201 && created.labels.add('zz-lab-1'));
	await step('create label without color', 'POST', `${P}/labels`, { name: 'zz-lab-nocolor' }).then(
		r => r.status === 201 && created.labels.add('zz-lab-nocolor')
	);
	await step('create label bad color', 'POST', `${P}/labels`, { name: 'zz-lab-badcolor', color: 'red!' });
	await step('create label color name', 'POST', `${P}/labels`, { name: 'zz-lab-cssname', color: 'red' }).then(
		r => r.status === 201 && created.labels.add('zz-lab-cssname')
	);
	await step('create label duplicate', 'POST', `${P}/labels`, { name: 'zz-lab-1', color: '#FF0000' });
	await step('create label duplicate case', 'POST', `${P}/labels`, { name: 'ZZ-LAB-1', color: '#FF0000' }).then(
		r => r.status === 201 && created.labels.add('ZZ-LAB-1')
	);
	await step('create label empty name', 'POST', `${P}/labels`, { name: '', color: '#FF0000' });
	await step('create label description 300', 'POST', `${P}/labels`, {
		name: 'zz-lab-desc',
		color: '#FF0000',
		description: 'd'.repeat(300),
	}).then(r => r.status === 201 && created.labels.add('zz-lab-desc'));
	for (const len of [50, 255, 256, 1000]) {
		const name = `zz${'n'.repeat(len - 2)}`;
		const r = await newLabel(name);
		console.log(`  ${r.status} label name length ${len}: ${short(r.json?.message ?? r.json?.name?.length, 160)}`);
	}
	for (const name of [
		'zz,comma',
		' zz-lead',
		'zz-trail ',
		'zz:colon',
		'zz::scoped::deep',
		'meta::k::v',
		'meta:k=v',
		'zz/slash',
		'zz%percent',
		'zz emoji \u{1F600}',
		'zz&amp',
		'zz "quote"',
		'zz\ttab',
		"zz'q",
		'zz~tilde',
		'zzéaccent',
	]) {
		const r = await newLabel(name);
		console.log(`  ${r.status} label ${JSON.stringify(name)}: ${short(r.json?.message ?? r.json?.name, 160)}`);
	}
	await step('get label by name', 'GET', `${P}/labels/${encodeURIComponent('zz-lab-1')}`);
	await step('get label with ::', 'GET', `${P}/labels/${encodeURIComponent('zz::scoped::deep')}`);
	await step('update label', 'PUT', `${P}/labels/${encodeURIComponent('zz-lab-1')}`, {
		new_name: 'zz-lab-1b',
		description: 'renamed',
	}).then(r => {
		if (r.status === 200) {
			created.labels.delete('zz-lab-1');
			created.labels.add('zz-lab-1b');
		}
	});
	await step('delete label by name', 'DELETE', `${P}/labels/${encodeURIComponent('zz-lab-1b')}`).then(() =>
		created.labels.delete('zz-lab-1b')
	);
	await step('delete label again', 'DELETE', `${P}/labels/${encodeURIComponent('zz-lab-1b')}`);
	await step('delete label with ::', 'DELETE', `${P}/labels/${encodeURIComponent('zz::scoped::deep')}`).then(() =>
		created.labels.delete('zz::scoped::deep')
	);

	// scoped labels on Free
	await newLabel('zzs::a');
	await newLabel('zzs::b');
	const s = await newIssue('scoped', { labels: 'zzs::a' });
	await stepPick(labelsOf, 'scoped: add_labels second of scope', 'PUT', issueRoute(s.iid), { add_labels: 'zzs::b' });
	await stepPick(labelsOf, 'scoped: labels both of scope', 'PUT', issueRoute(s.iid), { labels: 'zzs::a,zzs::b' });
	await stepPick(labelsOf, 'scoped: labels one after other', 'PUT', issueRoute(s.iid), { labels: 'zzs::a' });
	await stepPick(i => i, 'scoped label list entry', 'GET', `${P}/labels/${encodeURIComponent('zzs::a')}`);
	await stepPick(labelsOf, 'plain: labels status:a,status:b', 'PUT', issueRoute(s.iid), { labels: 'zzp:a,zzp:b' });
	created.labels.add('zzp:a');
	created.labels.add('zzp:b');
	await step(
		'issues filter labels=zzp:a',
		'GET',
		`${P}/issues?labels=${encodeURIComponent('zzp:a')}&per_page=5`
	).then(r => console.log(`    -> ${r.json?.length} issues`));
	await step(
		'issues filter labels=zzs::a (scoped)',
		'GET',
		`${P}/issues?labels=${encodeURIComponent('zzs::a')}&per_page=5`
	);
	await step('issues filter labels=None', 'GET', `${P}/issues?labels=None&per_page=2`).then(r =>
		console.log(`    -> ${r.json?.length} issues`)
	);
	await step('issues filter not[labels]', 'GET', `${P}/issues?not[labels]=zzp:a&per_page=2`);
};

// ---------------------------------------------------------------- label & state events and timing
sections.events = async () => {
	await newLabel('zze-st:todo');
	await newLabel('zze-st:doing');
	const i = await newIssue('events', { labels: 'zze-st:todo' });
	await sleep(1500);
	const t0 = Date.now();
	const put = await call('ONE PUT: labels swap + close + title', 'PUT', issueRoute(i.iid), {
		labels: 'zze-st:doing',
		state_event: 'close',
		title: title('events renamed'),
	});
	show(put, x => ({ ua: x.updated_at, state: x.state, labels: x.labels }));
	console.log(`  wall time of the PUT: started ${new Date(t0).toISOString()}`);
	await sleep(1000);
	const le = await call('resource_label_events', 'GET', `${issueRoute(i.iid)}/resource_label_events`);
	show(le, e => ({ id: e.id, at: e.created_at, action: e.action, label: e.label?.name, keys: undefined }));
	console.log(`  label event keys: ${Object.keys(le.json?.[0] ?? {}).join(',')}`);
	const se = await call('resource_state_events', 'GET', `${issueRoute(i.iid)}/resource_state_events`);
	show(se, e => ({ id: e.id, at: e.created_at, state: e.state }));
	console.log(`  state event keys: ${Object.keys(se.json?.[0] ?? {}).join(',')}`);
	await step('resource_label_events per_page=1', 'GET', `${issueRoute(i.iid)}/resource_label_events?per_page=1`);
	await step('reopen', 'PUT', issueRoute(i.iid), { state_event: 'reopen' });
	await step('resource_state_events after reopen', 'GET', `${issueRoute(i.iid)}/resource_state_events`).then(r =>
		console.log(`    -> ${JSON.stringify((r.json ?? []).map(e => e.state))}`)
	);
	// label deleted: what does its event look like
	await call('delete label zze-st:todo', 'DELETE', `${P}/labels/${encodeURIComponent('zze-st:todo')}`).then(() =>
		created.labels.delete('zze-st:todo')
	);
	await step('label events after label delete', 'GET', `${issueRoute(i.iid)}/resource_label_events`).then(r =>
		console.log(`    -> ${JSON.stringify((r.json ?? []).map(e => [e.action, e.label?.name ?? null]))}`)
	);
	// events for labels given at creation, and 2 PUTs inside the same second
	const j = await newIssue('events2', { labels: 'zze-st:doing' });
	await call('PUT a', 'PUT', issueRoute(j.iid), { add_labels: 'zze-x1' });
	await call('PUT b', 'PUT', issueRoute(j.iid), { add_labels: 'zze-x2' });
	created.labels.add('zze-x1');
	created.labels.add('zze-x2');
	await sleep(800);
	await step('events of two quick PUTs', 'GET', `${issueRoute(j.iid)}/resource_label_events`).then(r =>
		console.log(`    -> ${JSON.stringify((r.json ?? []).map(e => [e.created_at, e.action, e.label?.name]))}`)
	);
	// same-second PUT with state change and labels: do timestamps differ
};

// ---------------------------------------------------------------- notes and system notes
sections.notes = async () => {
	await newLabel('zzn-l1');
	const i = await newIssue('notes', { description: 'v1' });
	const n = await call('create note', 'POST', `${issueRoute(i.iid)}/notes`, { body: 'hello **note**' });
	show(n, x => ({ id: x.id, system: x.system, keys: Object.keys(x).join(',') }));
	await step('create note empty body', 'POST', `${issueRoute(i.iid)}/notes`, { body: '' });
	await step('create note without body', 'POST', `${issueRoute(i.iid)}/notes`, {});
	await step('create note 1000001 chars', 'POST', `${issueRoute(i.iid)}/notes`, { body: 'n'.repeat(1_000_001) });
	await step('create note CRLF', 'POST', `${issueRoute(i.iid)}/notes`, { body: 'a\r\nb  \r\n' }).then(r =>
		console.log(`    -> ${JSON.stringify(r.json?.body)}`)
	);
	await step('edit note', 'PUT', `${issueRoute(i.iid)}/notes/${n.json.id}`, { body: 'edited' });
	await step('edit note 404', 'PUT', `${issueRoute(i.iid)}/notes/99999999`, { body: 'edited' });
	// system notes
	await call('PUT title', 'PUT', issueRoute(i.iid), { title: title('notes renamed') });
	await call('PUT description', 'PUT', issueRoute(i.iid), { description: 'v2' });
	await call('PUT labels', 'PUT', issueRoute(i.iid), { labels: 'zzn-l1' });
	await call('PUT remove label', 'PUT', issueRoute(i.iid), { remove_labels: 'zzn-l1' });
	await call('PUT close', 'PUT', issueRoute(i.iid), { state_event: 'close' });
	await call('PUT reopen', 'PUT', issueRoute(i.iid), { state_event: 'reopen' });
	await call('PUT issue_type', 'PUT', issueRoute(i.iid), { issue_type: 'incident' });
	await call('PUT due_date', 'PUT', issueRoute(i.iid), { due_date: '2030-01-02' });
	await call('PUT confidential', 'PUT', issueRoute(i.iid), { confidential: true });
	await call('PUT confidential off', 'PUT', issueRoute(i.iid), { confidential: false });
	const other = await newIssue('notes other');
	await call('link relates_to', 'POST', `${issueRoute(i.iid)}/links`, {
		target_project_id: encodeURIComponent(projectPath),
		target_issue_iid: other.iid,
	});
	const all = await call(
		'list notes all asc',
		'GET',
		`${issueRoute(i.iid)}/notes?sort=asc&order_by=created_at&per_page=100`
	);
	console.log('  notes (asc):');
	for (const x of all.json ?? [])
		console.log(`    #${x.id} system=${x.system} at=${x.created_at} ${JSON.stringify(x.body)}`);
	console.log(`  note keys: ${Object.keys(all.json?.[0] ?? {}).join(',')}`);
	await stepPick(
		x => `${x.id}:${x.system}`,
		'activity_filter only_comments',
		'GET',
		`${issueRoute(i.iid)}/notes?activity_filter=only_comments`
	);
	await stepPick(
		x => `${x.id}:${x.system}`,
		'activity_filter only_activity',
		'GET',
		`${issueRoute(i.iid)}/notes?activity_filter=only_activity`
	);
	const sys = (all.json ?? []).find(x => x.system);
	if (sys) {
		await step('edit system note', 'PUT', `${issueRoute(i.iid)}/notes/${sys.id}`, { body: 'x' });
		await step('delete system note', 'DELETE', `${issueRoute(i.iid)}/notes/${sys.id}`);
	}
	await step('delete user note', 'DELETE', `${issueRoute(i.iid)}/notes/${n.json.id}`);
	await step('delete user note again', 'DELETE', `${issueRoute(i.iid)}/notes/${n.json.id}`);
	// quick actions
	const q = await newIssue('quick', { description: 'text\n/label ~zzq-from-desc\n/close' });
	console.log(
		`  quick action in create description: state ${q.state}, labels ${JSON.stringify(q.labels)}, description ${JSON.stringify(q.description)}`
	);
	created.labels.add('zzq-from-desc');
	const qn = await call('note with /close', 'POST', `${issueRoute(i.iid)}/notes`, { body: '/close' });
	show(qn, x => x);
	console.log(`    -> issue state now ${(await call('GET', 'GET', issueRoute(i.iid))).json?.state}`);
	await call('reopen', 'PUT', issueRoute(i.iid), { state_event: 'reopen' });
	const qn2 = await call('note with text + /label', 'POST', `${issueRoute(i.iid)}/notes`, {
		body: 'visible\n/label ~zzq-note',
	});
	show(qn2, x => ({ body: x.body }));
	created.labels.add('zzq-note');
	const qd = await call('PUT description with /label', 'PUT', issueRoute(i.iid), {
		description: 'd\n/label ~zzq-put',
	});
	show(qd, x => ({ d: x.description, labels: x.labels }));
	created.labels.add('zzq-put');
	await step('note escaped quick action', 'POST', `${issueRoute(i.iid)}/notes`, { body: '\\/close' }).then(r =>
		console.log(`    -> ${JSON.stringify(r.json?.body)}`)
	);
	await step('note with backticks quick action', 'POST', `${issueRoute(i.iid)}/notes`, { body: '`/close`' }).then(r =>
		console.log(`    -> ${JSON.stringify(r.json?.body)}`)
	);
	await step('note code fence quick action', 'POST', `${issueRoute(i.iid)}/notes`, { body: '```\n/close\n```' }).then(
		r => console.log(`    -> ${JSON.stringify(r.json?.body)}`)
	);
	console.log(`    -> state now ${(await call('GET', 'GET', issueRoute(i.iid))).json?.state}`);
	// description edit history
	await step('GET description versions', 'GET', `${issueRoute(i.iid)}/description_versions`);
	await step('GET issue notes of 404 issue', 'GET', `${issueRoute(99999)}/notes`);
};

// ---------------------------------------------------------------- links
sections.links = async () => {
	const a = await newIssue('link A');
	const b = await newIssue('link B');
	const c = await newIssue('link C');
	const self = a.project_id;
	const body = (target, type) => ({
		target_project_id: self,
		target_issue_iid: target,
		...(type ? { link_type: type } : {}),
	});
	const keep = l => ({
		iid: l.iid,
		link_type: l.link_type,
		issue_link_id: l.issue_link_id,
		link_created_at: l.link_created_at,
		keys: undefined,
	});
	const r1 = await call('POST relates_to default', 'POST', `${issueRoute(a.iid)}/links`, body(b.iid));
	show(r1);
	console.log(`  link keys: ${Object.keys(r1.json ?? {}).join(',')}`);
	await stepPick(keep, 'GET links of A', 'GET', `${issueRoute(a.iid)}/links`);
	await stepPick(keep, 'GET links of B', 'GET', `${issueRoute(b.iid)}/links`);
	await step('POST duplicate relates_to (same dir)', 'POST', `${issueRoute(a.iid)}/links`, body(b.iid));
	await step('POST duplicate relates_to (reverse)', 'POST', `${issueRoute(b.iid)}/links`, body(a.iid));
	await step('POST blocks', 'POST', `${issueRoute(a.iid)}/links`, body(c.iid, 'blocks'));
	await step('POST is_blocked_by', 'POST', `${issueRoute(c.iid)}/links`, body(b.iid, 'is_blocked_by'));
	await step('POST link_type bogus', 'POST', `${issueRoute(a.iid)}/links`, body(c.iid, 'bogus'));
	await step('POST link to self', 'POST', `${issueRoute(a.iid)}/links`, body(a.iid));
	await step('POST link missing target', 'POST', `${issueRoute(a.iid)}/links`, { target_project_id: self });
	await step('POST link to unknown issue', 'POST', `${issueRoute(a.iid)}/links`, body(99999));
	await step('POST link to unknown project', 'POST', `${issueRoute(a.iid)}/links`, {
		target_project_id: '999999999',
		target_issue_iid: 1,
	});
	await step('POST link target by path', 'POST', `${issueRoute(a.iid)}/links`, {
		target_project_id: projectPath,
		target_issue_iid: c.iid,
	});
	await step('POST link from unknown issue', 'POST', `${issueRoute(99999)}/links`, body(a.iid));
	await stepPick(keep, 'GET links of A after', 'GET', `${issueRoute(a.iid)}/links`);
	await stepPick(keep, 'GET links of C after', 'GET', `${issueRoute(c.iid)}/links`);
	const links = (await call('GET links A', 'GET', `${issueRoute(a.iid)}/links`)).json ?? [];
	for (const l of links)
		await step(`DELETE link ${l.issue_link_id}`, 'DELETE', `${issueRoute(a.iid)}/links/${l.issue_link_id}`);
	await step('DELETE link 404', 'DELETE', `${issueRoute(a.iid)}/links/99999999`);
	await stepPick(keep, 'GET links of A empty', 'GET', `${issueRoute(a.iid)}/links`);
	// closed target; links count in issue
	await call('close B', 'PUT', issueRoute(b.iid), { state_event: 'close' });
	await step('POST link to closed issue', 'POST', `${issueRoute(a.iid)}/links`, body(b.iid));
	const g = await call('GET A', 'GET', issueRoute(a.iid));
	console.log(
		`  issue fields: blocking_issues_count ${g.json?.blocking_issues_count}, has_tasks ${g.json?.has_tasks}, _links ${JSON.stringify(g.json?._links)}`
	);
	// quick actions /relate
	await call('note /relate', 'POST', `${issueRoute(a.iid)}/notes`, { body: `/relate #${c.iid}` });
	await step('links after /relate', 'GET', `${issueRoute(a.iid)}/links`);
	await call('note /blocks', 'POST', `${issueRoute(a.iid)}/notes`, { body: `/blocks #${c.iid}` });
	await step('links after /blocks', 'GET', `${issueRoute(a.iid)}/links`);
	await call('note /duplicate', 'POST', `${issueRoute(c.iid)}/notes`, { body: `/duplicate #${a.iid}` });
	await step('C after /duplicate', 'GET', issueRoute(c.iid)).then(r =>
		console.log(
			`    -> state ${r.json?.state} closed_as_duplicate_of ${JSON.stringify(r.json?._links?.closed_as_duplicate_of)}`
		)
	);
	await step('GET issue links (project-wide 404?)', 'GET', `${P}/issues/${a.iid}/related_merge_requests`);
};

// ---------------------------------------------------------------- work items / hierarchy
sections.workitems = async () => {
	const a = await newIssue('wi parent');
	const b = await newIssue('wi child');
	await step('REST /work_items', 'GET', `${P}/work_items`);
	await step('REST /work_items/:iid', 'GET', `${P}/work_items/${a.iid}`);
	await step('REST epics-like parent param', 'PUT', issueRoute(b.iid), { parent_id: a.id });
	await step('REST epic_id param (paid)', 'PUT', issueRoute(b.iid), { epic_id: 1 });
	await step('REST weight param (paid)', 'PUT', issueRoute(b.iid), { weight: 3 });
	await step('REST health_status (paid)', 'PUT', issueRoute(b.iid), { health_status: 'on_track' });
	const gql = async (label, query, variables) => {
		const r = await call(label, 'POST', 'graphql', { query, variables });
		console.log(`  ${r.status} ${r.ms}ms ${label}: ${short(r.json ?? r.text, 700)}`);
		return r.json;
	};
	const types = await gql(
		'workItemTypes',
		`query($p: ID!) { project(fullPath: $p) { id workItemTypes { nodes { id name } } } }`,
		{ p: projectPath }
	);
	const nodes = types?.data?.project?.workItemTypes?.nodes ?? [];
	console.log(`  types: ${nodes.map(n => n.name).join(', ')}`);
	const gid = i => `gid://gitlab/WorkItem/${i.id}`;
	await gql(
		'read workitem by iid + hierarchy',
		`query($p: ID!, $iid: String!) { project(fullPath: $p) { workItems(iid: $iid) { nodes { id iid title state workItemType { name } widgets { type ... on WorkItemWidgetHierarchy { parent { id iid } hasChildren children { nodes { id iid } } } } } } } }`,
		{ p: projectPath, iid: String(a.iid) }
	);
	const taskType = nodes.find(n => n.name === 'Task');
	const issueType = nodes.find(n => n.name === 'Issue');
	// create a Task child
	let task;
	if (taskType) {
		const r = await gql(
			'workItemCreate Task under issue',
			`mutation($in: WorkItemCreateInput!) { workItemCreate(input: $in) { errors workItem { id iid title workItemType { name } webUrl widgets { type ... on WorkItemWidgetHierarchy { parent { id iid } } } } } }`,
			{
				in: {
					namespacePath: projectPath,
					title: title('wi task'),
					workItemTypeId: taskType.id,
					hierarchyWidget: { parentId: gid(a) },
				},
			}
		);
		task = r?.data?.workItemCreate?.workItem;
		if (task) created.issues.add(Number(task.iid));
	}
	// issue as child of an issue
	await gql(
		'workItemUpdate: issue child of issue',
		`mutation($in: WorkItemUpdateInput!) { workItemUpdate(input: $in) { errors workItem { id iid widgets { type ... on WorkItemWidgetHierarchy { parent { id iid } } } } } }`,
		{ in: { id: gid(b), hierarchyWidget: { parentId: gid(a) } } }
	);
	await gql(
		'workItemUpdate: children of issue',
		`mutation($in: WorkItemUpdateInput!) { workItemUpdate(input: $in) { errors workItem { id iid } } }`,
		{ in: { id: gid(a), hierarchyWidget: { childrenIds: [gid(b)] } } }
	);
	// the REST view of the task and of the parent
	if (task) {
		await stepPick(
			i => ({ iid: i.iid, issue_type: i.issue_type, type: i.type, web_url: i.web_url }),
			'REST GET the task by iid',
			'GET',
			issueRoute(task.iid)
		);
		await stepPick(
			i => ({ iid: i.iid, issue_type: i.issue_type }),
			'REST issues list issue_type=task',
			'GET',
			`${P}/issues?issue_type=task&per_page=5`
		);
		await stepPick(
			i => ({ iid: i.iid, has_tasks: i.has_tasks, task_status: i.task_status }),
			'REST parent has_tasks',
			'GET',
			issueRoute(a.iid)
		);
		await stepPick(
			x => `${x.system}:${x.body}`,
			'notes of the parent',
			'GET',
			`${issueRoute(a.iid)}/notes?sort=asc`
		);
		// task parent set to issue b (task under task) and the issue list default
		await gql(
			'read parent/children of parent',
			`query($p: ID!, $iid: String!) { project(fullPath: $p) { workItems(iid: $iid) { nodes { id iid widgets { type ... on WorkItemWidgetHierarchy { parent { iid } children { nodes { iid workItemType { name } } } } } } } } }`,
			{ p: projectPath, iid: String(a.iid) }
		);
		await gql(
			'remove parent',
			`mutation($in: WorkItemUpdateInput!) { workItemUpdate(input: $in) { errors workItem { id iid widgets { type ... on WorkItemWidgetHierarchy { parent { iid } } } } } }`,
			{
				in: {
					id: `gid://gitlab/WorkItem/${(await call('id', 'GET', issueRoute(task.iid))).json.id}`,
					hierarchyWidget: { parentId: null },
				},
			}
		);
	}
	await gql(
		'bulk read hierarchy of project',
		`query($p: ID!) { project(fullPath: $p) { workItems(first: 5) { nodes { iid widgets { type ... on WorkItemWidgetHierarchy { parent { iid } } } } } } }`,
		{ p: projectPath }
	);
	void issueType;
};

// ---------------------------------------------------------------- pagination and search
sections.pagination = async () => {
	const seen = [];
	for (let i = 0; i < 3; i++) seen.push(await newIssue(`page ${i}`));
	const first = await call('page 1 per_page=2', 'GET', `${P}/issues?per_page=2&state=all`);
	show(first, x => x.iid);
	console.log(`  link: ${first.headers.link}`);
	const next = /<([^>]+)>;\s*rel="next"/.exec(first.headers.link ?? '')?.[1];
	if (next) await stepPick(x => x.iid, 'follow rel=next', 'GET', next);
	await step('page 2 explicit', 'GET', `${P}/issues?per_page=2&page=2&state=all`);
	await step('per_page=101', 'GET', `${P}/issues?per_page=101`).then(r => console.log(`    -> ${r.json?.length}`));
	await step('per_page=0', 'GET', `${P}/issues?per_page=0`).then(r => console.log(`    -> ${r.json?.length}`));
	await step('page=0', 'GET', `${P}/issues?page=0&per_page=1`);
	await step('page beyond', 'GET', `${P}/issues?page=9999&per_page=100`);
	await step('keyset', 'GET', `${P}/issues?pagination=keyset&per_page=2&order_by=created_at&sort=asc`);
	await step('keyset default order', 'GET', `${P}/issues?pagination=keyset&per_page=2`);
	await step('order_by updated_at asc', 'GET', `${P}/issues?order_by=updated_at&sort=asc&per_page=2`);
	await step('order_by bogus', 'GET', `${P}/issues?order_by=bogus`);
	await step('state bogus', 'GET', `${P}/issues?state=bogus`);
	await step('state=opened', 'GET', `${P}/issues?state=opened&per_page=1`);
	await step('state=closed', 'GET', `${P}/issues?state=closed&per_page=1`);
	await step('iids[]', 'GET', `${P}/issues?iids[]=${seen[0].iid}&iids[]=${seen[1].iid}`).then(r =>
		console.log(`    -> ${r.json?.length}`)
	);
	await step('updated_after future', 'GET', `${P}/issues?updated_after=2099-01-01T00:00:00Z`);
	await step('issue_type=incident', 'GET', `${P}/issues?issue_type=incident&per_page=1`);
	await step('x-total on big', 'GET', `${P}/issues?per_page=1&state=all`);
	await step('with_labels_details', 'GET', `${P}/issues?per_page=1&with_labels_details=true`);
};

sections.search = async () => {
	const word = `zqx${run}uniq`;
	const t0 = Date.now();
	const i = await newIssue(`search ${word}`, { description: `body ${word}desc` });
	const lag = [];
	for (let k = 0; k < 10; k++) {
		const r = await call('search poll', 'GET', `${P}/issues?search=${word}&per_page=5&state=all`);
		lag.push([Date.now() - t0, (r.json ?? []).length]);
		if ((r.json ?? []).length > 0) break;
		await sleep(2000);
	}
	console.log(`  search lag (ms since create, hits): ${JSON.stringify(lag)}`);
	const listNow = await call(
		'list opened right after create',
		'GET',
		`${P}/issues?state=opened&per_page=100&order_by=created_at&sort=desc`
	);
	console.log(`  list contains the new issue: ${(listNow.json ?? []).some(x => x.iid === i.iid)}`);
	await step('search in=title', 'GET', `${P}/issues?search=${word}&in=title`);
	await step('search in=description', 'GET', `${P}/issues?search=${word}desc&in=description`);
	await step('search partial word', 'GET', `${P}/issues?search=${word.slice(0, 8)}`).then(r =>
		console.log(`    -> ${r.json?.length} hits`)
	);
	await step('search in description only text', 'GET', `${P}/issues?search=${word}desc`).then(r =>
		console.log(`    -> ${r.json?.length} hits`)
	);
	await step('search case', 'GET', `${P}/issues?search=${word.toUpperCase()}`).then(r =>
		console.log(`    -> ${r.json?.length} hits`)
	);
	await step('search 1 char', 'GET', `${P}/issues?search=z`).then(r => console.log(`    -> ${r.json?.length} hits`));
	await step('search 2 chars', 'GET', `${P}/issues?search=zq`).then(r =>
		console.log(`    -> ${r.json?.length} hits`)
	);
	await step('search special', 'GET', `${P}/issues?search=${encodeURIComponent('[task-api-test]')}&per_page=2`).then(
		r => console.log(`    -> ${r.json?.length} hits`)
	);
	await step('global search scope=issues (project)', 'GET', `${P}/search?scope=issues&search=${word}`);
	// list lag: create then list right away with a new label filter
	const l = await newIssue('lag');
	const t1 = Date.now();
	const hits = [];
	for (let k = 0; k < 4; k++) {
		const r = await call('list iids[]', 'GET', `${P}/issues?iids[]=${l.iid}`);
		hits.push([Date.now() - t1, (r.json ?? []).length]);
		if ((r.json ?? []).length) break;
		await sleep(1000);
	}
	console.log(`  iids[] lag: ${JSON.stringify(hits)}`);
};

// ---------------------------------------------------------------- error shapes
sections.errors = async () => {
	await step('401 no token', 'GET', `${P}/issues?per_page=1`, undefined, { token: null });
	await step('401 bad token', 'GET', `${P}/issues?per_page=1`, undefined, { token: 'glpat-xxxxxxxxxxxxxxxxxxxx' });
	await step('Bearer header', 'GET', `${P}/issues?per_page=1`, undefined, {
		token: null,
		headers: { authorization: `Bearer ${token}` },
	}).then(r => console.log(`    -> ${r.status}`));
	await step('404 unknown route', 'GET', `${P}/nothing-here`);
	await step('404 project path', 'GET', `projects/${encodeURIComponent('wadeck-app/nope')}/issues`);
	await step('404 project id', 'GET', 'projects/1/issues');
	await step('405 method', 'PATCH', `${P}/issues`, {});
	await step('400 invalid json', 'POST', `${P}/issues`, undefined, {
		rawBody: '{nope',
		headers: { 'content-type': 'application/json' },
	});
	await step('415 wrong content type', 'POST', `${P}/issues`, undefined, {
		rawBody: 'title=x',
		headers: { 'content-type': 'text/plain' },
	});
	await step('form-encoded body', 'POST', `${P}/issues`, undefined, {
		rawBody: `title=${encodeURIComponent(title('form'))}`,
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
	}).then(r => {
		if (r.status === 201) created.issues.add(r.json.iid);
	});
	await step('query-string create', 'POST', `${P}/issues?title=${encodeURIComponent(title('query'))}`).then(r => {
		if (r.status === 201) created.issues.add(r.json.iid);
	});
	await step('GET issue iid 0', 'GET', issueRoute(0));
	await step('GET issue iid -1', 'GET', issueRoute(-1));
	await step('PUT issue 404', 'PUT', issueRoute(99999), { title: 'x' });
	await step('DELETE issue 404', 'DELETE', issueRoute(99999));
	await step('POST note 404', 'POST', `${issueRoute(99999)}/notes`, { body: 'x' });
	await step('graphql bad query', 'POST', 'graphql', { query: '{ nope }' });
	await step('graphql no token', 'POST', 'graphql', { query: '{ currentUser { id } }' }, { token: null });
	// permission failures of this token (what a too-weak token returns): endpoints it is denied
	for (const [l, r] of [
		['GET /user', 'user'],
		['GET /version', 'version'],
		['GET /metadata', 'metadata'],
		['GET /personal_access_tokens/self', 'personal_access_tokens/self'],
		['GET project', P],
		['GET members', `${P}/members/all`],
		['GET hooks', `${P}/hooks`],
		['GET repository tree', `${P}/repository/tree`],
	]) {
		await step(`denied? ${l}`, 'GET', r);
	}
};

// ---------------------------------------------------------------- delete, move, misc
sections.delete = async () => {
	const a = await newIssue('delete me');
	await call('note', 'POST', `${issueRoute(a.iid)}/notes`, { body: 'x' });
	await step('DELETE issue', 'DELETE', issueRoute(a.iid));
	await step('GET after delete', 'GET', issueRoute(a.iid));
	await step('PUT after delete', 'PUT', issueRoute(a.iid), { title: 'x' });
	await step('notes after delete', 'GET', `${issueRoute(a.iid)}/notes`);
	await step('list after delete (iids[])', 'GET', `${P}/issues?iids[]=${a.iid}&state=all`);
	created.issues.delete(a.iid);
	const b = await newIssue('after delete (iid reuse?)');
	console.log(`  next iid after delete: deleted ${a.iid}, new ${b.iid}`);
	const c = await newIssue('to close then delete');
	await call('close', 'PUT', issueRoute(c.iid), { state_event: 'close' });
	await step('DELETE closed issue', 'DELETE', issueRoute(c.iid));
	created.issues.delete(c.iid);
	await step('move issue (no target project)', 'POST', `${issueRoute(b.iid)}/move`, {});
	await step('move to unknown project', 'POST', `${issueRoute(b.iid)}/move`, { to_project_id: 999999999 });
};

sections.misc = async () => {
	const a = await newIssue('misc');
	await stepPick(i => ({ confidential: i.confidential }), 'confidential', 'PUT', issueRoute(a.iid), {
		confidential: true,
	});
	await stepPick(i => ({ due: i.due_date }), 'due_date', 'PUT', issueRoute(a.iid), { due_date: '2030-05-06' });
	await stepPick(i => ({ weight: i.weight, keys: 'weight' in i }), 'weight (paid)', 'PUT', issueRoute(a.iid), {
		weight: 4,
	});
	await step('time estimate', 'POST', `${issueRoute(a.iid)}/time_estimate?duration=3h`);
	await step('spent time', 'POST', `${issueRoute(a.iid)}/add_spent_time?duration=1h`);
	await step('iteration_id (paid)', 'PUT', issueRoute(a.iid), { iteration_id: 1 });
	await step('milestone_id', 'PUT', issueRoute(a.iid), { milestone_id: 0 });
	await step('assignee_ids', 'PUT', issueRoute(a.iid), { assignee_ids: [] });
	await step('discussion_locked', 'PUT', issueRoute(a.iid), { discussion_locked: true });
	await step('note on locked discussion', 'POST', `${issueRoute(a.iid)}/notes`, { body: 'x' });
	await step('unlock', 'PUT', issueRoute(a.iid), { discussion_locked: false });
	await step('issue reference/subscribe', 'POST', `${issueRoute(a.iid)}/subscribe`);
	await step('project statistics (issues_statistics)', 'GET', `${P}/issues_statistics`);
	await step('award_emoji', 'POST', `${issueRoute(a.iid)}/award_emoji`, { name: 'thumbsup' });
	await step('CRLF title', 'PUT', issueRoute(a.iid), { title: 'line1\nline2' }).then(r =>
		console.log(`    -> ${JSON.stringify(r.json?.title ?? r.json)}`)
	);
	await step('unicode title', 'PUT', issueRoute(a.iid), { title: `${PREFIX} café \u{1F600} 中` }).then(r =>
		console.log(`    -> ${JSON.stringify(r.json?.title)}`)
	);
	await step('html title', 'PUT', issueRoute(a.iid), { title: `${PREFIX} <b>x</b> &amp; "q"` }).then(r =>
		console.log(`    -> ${JSON.stringify(r.json?.title)}`)
	);
	await step('leading/trailing space title', 'PUT', issueRoute(a.iid), { title: `  ${PREFIX} spaced  ` }).then(r =>
		console.log(`    -> ${JSON.stringify(r.json?.title)}`)
	);
};

sections.scenario = async () => {
	const { runScenario } = await import(
		pathToFileURL(path.join(import.meta.dirname, 'gitlab-conformance-scenario.mjs')).href
	);
	const recorded = await runScenario({ call, projectPath, run, apiBase: BASE, track: created });
	if (recordFile) {
		fs.writeFileSync(recordFile, `${JSON.stringify(recorded, null, '\t')}\n`);
		console.log(`  wrote ${recorded.steps.length} steps to ${recordFile}`);
	}
};

// Burns the quota on purpose to see the 429 (about 100 cheap GETs). Run it alone and last.
sections.ratelimit = async () => {
	let count = 0;
	for (; count < 400; count++) {
		const r = await call('rl', 'GET', `${P}/labels?per_page=1`, undefined, { noThrottle: true });
		if (count % 20 === 0 || r.status !== 200)
			console.log(
				`  #${count} ${r.status} remaining ${r.headers['ratelimit-remaining']} observed ${r.headers['ratelimit-observed']} reset ${r.headers['ratelimit-reset']}`
			);
		if (r.status === 429) {
			console.log(
				`  429 after ${count} requests: headers ${JSON.stringify(r.headers)} body ${short(r.text, 300)}`
			);
			const wait = Number(r.headers['retry-after'] ?? 60);
			console.log(`  waiting Retry-After ${wait}s then retrying`);
			await sleep((wait + 1) * 1000);
			const again = await call('rl after wait', 'GET', `${P}/labels?per_page=1`, undefined, { noThrottle: true });
			console.log(`  after wait: ${again.status} remaining ${again.headers['ratelimit-remaining']}`);
			return;
		}
	}
	console.log(`  no 429 in ${count} requests`);
};

// ---------------------------------------------------------------- cleanup and main
async function cleanup() {
	console.log('\n== cleanup');
	let closed = 0;
	for (const iid of created.issues) {
		const r = await call('cleanup close', 'PUT', issueRoute(iid), { state_event: 'close' });
		if (r.status === 200 || r.status === 404) closed += 1;
		else console.log(`  cannot close #${iid}: ${r.status} ${short(r.text, 120)}`);
	}
	let deleted = 0;
	for (const name of created.labels) {
		const r = await call('cleanup label', 'DELETE', `${P}/labels/${encodeURIComponent(name)}`);
		if (r.status === 204 || r.status === 404) deleted += 1;
		else console.log(`  cannot delete label ${JSON.stringify(name)}: ${r.status} ${short(r.text, 120)}`);
	}
	console.log(`  closed ${closed}/${created.issues.size} issues, deleted ${deleted}/${created.labels.size} labels`);
}

const defaults = [
	'identity',
	'crud',
	'labels',
	'events',
	'notes',
	'links',
	'workitems',
	'pagination',
	'search',
	'errors',
	'delete',
	'misc',
];
const toRun = requested.length ? requested : defaults;
let failed = false;
for (const name of toRun) {
	if (!sections[name]) {
		console.error(`unknown section ${name}; known: ${Object.keys(sections).join(' ')}`);
		process.exit(2);
	}
	console.log(`\n== ${name}`);
	try {
		await sections[name]();
	} catch (error) {
		failed = true;
		console.log(`  SECTION CRASHED: ${redact(error?.stack ?? error)}`);
	}
}
try {
	await cleanup();
} catch (error) {
	failed = true;
	console.log(`  CLEANUP CRASHED: ${redact(error?.stack ?? error)}`);
}
console.log('\n== latency (median ms, count)');
for (const [key, values] of [...latencies].sort()) {
	const sorted = [...values].sort((x, y) => x - y);
	if (values.length >= 3) console.log(`  ${key}: ${sorted[Math.floor(sorted.length / 2)]} (${values.length})`);
}
console.log(`requests: ${requestCount}`);
if (process.env.GL_PROBE_OUT) fs.writeFileSync(process.env.GL_PROBE_OUT, `${JSON.stringify(pairs, null, '\t')}\n`);
process.exit(failed ? 1 : 0);
