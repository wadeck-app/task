// Live probe of GitHub issue fields (Priority, Effort, ...) on a THROWAWAY repository.
// Usage: GH_TEST_TOKEN=<token> GH_TEST_REPO=<owner/name> node scripts/live-github-fields-probe.mjs
// Creates ONE issue titled "[task-api-test] fields probe <stamp>", sets/reads/clears a field value, closes the issue as not_planned.
// The token is read from the environment only and never printed. Not part of npm test or CI.
const token = process.env.GH_TEST_TOKEN;
const repo = process.env.GH_TEST_REPO;
if (!token || !repo) {
	console.error('live-github-fields-probe: set GH_TEST_TOKEN and GH_TEST_REPO (owner/name of a THROWAWAY repository)');
	process.exit(2);
}
const owner = repo.split('/')[0];
const base = 'https://api.github.com';

async function call(method, path, body, extraHeaders = {}) {
	const response = await fetch(`${base}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2026-03-10',
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			...extraHeaders,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	let json;
	try {
		json = text === '' ? undefined : JSON.parse(text);
	} catch {
		json = undefined;
	}
	const hint = response.headers.get('x-accepted-github-permissions');
	return { status: response.status, json, text: text.slice(0, 300), hint };
}

function show(label, result, extra = '') {
	const permissions = result.hint === null ? '' : ` [accepted permissions: ${result.hint}]`;
	console.log(`${label}: HTTP ${result.status}${permissions}${extra === '' ? '' : ` ${extra}`}`);
}

const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
let issueNumber;
try {
	// 1. Field definitions: which endpoints exist
	for (const path of [`/orgs/${owner}/issue-fields`, `/repos/${repo}/issue-fields`, `/users/${owner}/issue-fields`]) {
		const result = await call('GET', path);
		show(`GET ${path}`, result, Array.isArray(result.json) ? `${result.json.length} fields: ${result.json.map(f => f.name).join(', ')}` : result.text.slice(0, 120));
	}

	// 2. A throwaway issue
	const created = await call('POST', `/repos/${repo}/issues`, { title: `[task-api-test] fields probe ${stamp}` });
	show('POST issue', created);
	if (created.status !== 201) throw new Error('could not create the probe issue');
	issueNumber = created.json.number;

	// 3. Values before any write
	const before = await call('GET', `/repos/${repo}/issues/${issueNumber}/issue-field-values`);
	show('GET issue-field-values (empty)', before, JSON.stringify(before.json).slice(0, 200));

	// 4. Set Priority (field id from the first definition endpoint that answered)
	let fields;
	for (const path of [`/orgs/${owner}/issue-fields`, `/repos/${repo}/issue-fields`]) {
		const result = await call('GET', path);
		if (result.status === 200 && Array.isArray(result.json)) {
			fields = result.json;
			break;
		}
	}
	// Without the org permission issue_fields=read the definitions are unreadable: GH_TEST_PRIORITY_FIELD_ID (full_database_id) supplies the id.
const envId = process.env.GH_TEST_PRIORITY_FIELD_ID;
const priority = fields?.find(f => f.name === 'Priority') ?? (envId === undefined ? undefined : { name: 'Priority', full_database_id: Number(envId) });
	if (priority === undefined) {
		console.log('no Priority field definition readable: set/read steps skipped (this is a finding, not a success)');
	} else {
		const fieldId = priority.id ?? priority.full_database_id;
		console.log(`Priority field id type: ${typeof fieldId}`);
		const set = await call('PUT', `/repos/${repo}/issues/${issueNumber}/issue-field-values`, {
			issue_field_values: [{ field_id: Number(priority.full_database_id ?? fieldId), value: 'High' }],
		});
		show('PUT issue-field-values Priority=High', set, set.text.slice(0, 200));

		const read = await call('GET', `/repos/${repo}/issues/${issueNumber}/issue-field-values`);
		show('GET issue-field-values', read, JSON.stringify(read.json).slice(0, 300));

		// 5. Do the issue answers carry the values?
		const single = await call('GET', `/repos/${repo}/issues/${issueNumber}`);
		const singleKeys = Object.keys(single.json ?? {}).filter(k => /field/i.test(k));
		show('GET issue', single, `keys mentioning "field": ${JSON.stringify(singleKeys)}`);
		await new Promise(resolve => setTimeout(resolve, 6000)); // the issue list lags a creation by about 4 s
		const list = await call('GET', `/repos/${repo}/issues?state=all&per_page=100&sort=created&direction=desc`);
		const listed = Array.isArray(list.json) ? list.json.find(i => i.number === issueNumber) : undefined;
		console.log(`probe issue present in the list: ${listed !== undefined}`);
		const listKeys = Object.keys(listed ?? {}).filter(k => /field/i.test(k));
		show('GET issues (list)', list, `keys mentioning "field" on the probe issue: ${JSON.stringify(listKeys)}`);
		if (listKeys.length > 0) console.log(`list value sample: ${JSON.stringify(listed[listKeys[0]]).slice(0, 300)}`);

		// 6. Server-side filter by field: does a query parameter exist?
		for (const query of ['issue_field_values=Priority:High', 'priority=High', 'field.Priority=High']) {
			const filtered = await call('GET', `/repos/${repo}/issues?state=all&per_page=100&${query}`);
			const count = Array.isArray(filtered.json) ? filtered.json.length : 'n/a';
			const total = Array.isArray(list.json) ? list.json.length : 'n/a';
			show(`GET issues?${query}`, filtered, `rows ${count} (unfiltered ${total}): a filter that works returns fewer rows`);
		}
		// Search qualifier
		const search = await call('GET', `/search/issues?q=${encodeURIComponent(`repo:${repo} is:issue field.priority:High`)}`);
		show('search field.priority:High', search, `total_count ${search.json?.total_count ?? 'n/a'} ${search.text.slice(0, 120)}`);

		// 7. Clear
		const clear = await call('DELETE', `/repos/${repo}/issues/${issueNumber}/issue-field-values/${Number(priority.full_database_id ?? fieldId)}`);
		show('DELETE issue-field-values Priority', clear);
	}
} finally {
	if (issueNumber !== undefined) {
		const closed = await call('PATCH', `/repos/${repo}/issues/${issueNumber}`, { state: 'closed', state_reason: 'not_planned' });
		show('cleanup: close probe issue as not_planned', closed);
	}
}
