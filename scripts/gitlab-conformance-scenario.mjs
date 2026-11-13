// The scripted scenario that `live-gitlab-probe.mjs scenario --record <file>` runs against the REAL gitlab.com project and stores as the
// conformance fixture (packages/task-service/src/plugins/gitlab/fixtures/live-conformance.json). The unit test replays the SAME
// requests against the local mock (fakeGitLab.testkit.ts) and requires the same status, key headers and (sanitized) body. Needs
// `npm run build` (the sanitizer is the compiled gitlabConformance.testkit.js). Every title is prefixed "[task-api-test]".
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const kitUrl = process.env.GL_CONFORMANCE_KIT
	? pathToFileURL(process.env.GL_CONFORMANCE_KIT).href
	: pathToFileURL(path.join(root, 'packages/task-service/dist/plugins/gitlab/gitlabConformance.testkit.js')).href;

const T = suffix => `[task-api-test] conf {{run}} ${suffix}`;
const P = 'projects/{{P}}';
const I = iid => `${P}/issues/{{${iid}}}`;
const LIST = 'conf-{{run}}-list';

// ---- GraphQL documents (the strategy sends exactly these; see gitlabWorkItems.ts) ----
export const GQL_READ =
	'query($id: WorkItemID!) { workItem(id: $id) { id iid workItemType { name } widgets { ... on WorkItemWidgetHierarchy { type parent { id iid } children(first: 100) { nodes { id iid } } } } } }';
export const GQL_SET_PARENT =
	'mutation($input: WorkItemUpdateInput!) { workItemUpdate(input: $input) { errors workItem { id iid } } }';
export const GQL_CONVERT =
	'mutation($input: WorkItemConvertInput!) { workItemConvert(input: $input) { errors workItem { id iid workItemType { name } } } }';

const gid = v => `gid://gitlab/WorkItem/{{${v}}}`;
const gqlRead = v => ({ query: GQL_READ, variables: { id: gid(v) } });
const gqlParent = (child, parent) => ({
	query: GQL_SET_PARENT,
	variables: { input: { id: gid(child), hierarchyWidget: { parentId: parent === null ? null : gid(parent) } } },
});
const gqlConvert = (v, typeId) => ({
	query: GQL_CONVERT,
	variables: { input: { id: gid(v), workItemTypeId: `gid://gitlab/WorkItems::Type/${typeId}` } },
});

/**
 * The steps. A step may carry `track` (the name of a variable holding an issue iid to close at the end) and `trackLabels` (label names,
 * placeholders and `$repeat` allowed, to delete at the end); both are removed from the fixture.
 */
export function steps() {
	const s = [];
	const add = (name, method, p, body, extra = {}) =>
		s.push({
			name,
			request: { method, path: p, ...(body === undefined ? {} : { body }), ...(extra.request ?? {}) },
			...extra.step,
		});
	const save = (vars, headers) => ({
		step: { ...(vars ? { save: vars } : {}), ...(headers ? { saveHeaders: headers } : {}) },
	});
	const created = (vars, track) => ({ step: { save: vars, ...(track ? { track } : {}) } });
	// A step that creates an issue (`track`) and/or labels (`trackLabels`) to clean up.
	const made = (vars, track, labels) => ({
		step: { save: vars, ...(track ? { track } : {}), ...(labels ? { trackLabels: labels } : {}) },
	});
	const labelsMade = labels => ({ step: { trackLabels: labels } });

	// ---- credentials and unknown things
	add('bad token', 'GET', `${P}/issues?per_page=1`, undefined, { request: { auth: 'bad' } });
	add('no token on a private project', 'GET', `${P}/issues?per_page=1`, undefined, { request: { auth: 'none' } });
	add('unknown project', 'GET', 'projects/{{P}}-nope/issues');
	add('unknown route', 'GET', `${P}/nothing-here`);
	add('PATCH is not a method of the issues route', 'PATCH', `${P}/issues`, {});
	add('invalid json', 'POST', `${P}/issues`, undefined, {
		request: { rawBody: '{nope', headers: { 'content-type': 'application/json' } },
	});
	add('unsupported content type', 'POST', `${P}/issues`, undefined, {
		request: { rawBody: 'title=x', headers: { 'content-type': 'text/plain' } },
	});

	// ---- create
	add(
		'create A',
		'POST',
		`${P}/issues`,
		{ title: T('A'), description: 'first\r\nline  ', labels: 'conf-{{run}}-x,conf-{{run}}-y' },
		{
			step: { save: { a: 'iid', aid: 'id' }, saveHeaders: { etag: 'etag' }, track: 'a' },
		}
	);
	add('get A', 'GET', I('a'), undefined, {});
	add('get A again with its etag', 'GET', I('a'), undefined, {
		request: { headers: { 'if-none-match': '{{etag}}' } },
	});
	add('get an unknown iid', 'GET', `${P}/issues/99999`);
	add('get a non numeric iid', 'GET', `${P}/issues/abc`);
	add('create without title', 'POST', `${P}/issues`, { description: 'x' });
	add('create with an empty title', 'POST', `${P}/issues`, { title: '' });
	add('create with a blank title', 'POST', `${P}/issues`, { title: '   ' });
	add('create with a title of 256 characters', 'POST', `${P}/issues`, {
		title: `[task-api-test] ${'t'.repeat(240)}`,
	});
	add('create with an unknown issue_type', 'POST', `${P}/issues`, { title: T('bogus'), issue_type: 'bogus' });
	add(
		'create B (incident)',
		'POST',
		`${P}/issues`,
		{ title: T('B incident'), issue_type: 'incident' },
		created({ b: 'iid', bid: 'id' }, 'b')
	);
	add(
		'create C (task)',
		'POST',
		`${P}/issues`,
		{ title: T('C task'), issue_type: 'task' },
		created({ c: 'iid', cid: 'id' }, 'c')
	);
	add(
		'create D (test_case)',
		'POST',
		`${P}/issues`,
		{ title: T('D test case'), issue_type: 'test_case' },
		created({ d: 'iid', did: 'id' }, 'd')
	);
	add(
		'create E (task)',
		'POST',
		`${P}/issues`,
		{ title: T('E task'), issue_type: 'task' },
		created({ e: 'iid', eid: 'id' }, 'e')
	);
	add(
		'create F (issue, state ignored)',
		'POST',
		`${P}/issues`,
		{ title: T('F'), state: 'closed', state_event: 'close' },
		created({ f: 'iid', fid: 'id' }, 'f')
	);
	add(
		'create with labels as an array',
		'POST',
		`${P}/issues`,
		{ title: T('G arrays'), labels: ['conf-{{run}}-arr1', 'conf-{{run}}-arr2'] },
		created({ g: 'iid' }, 'g')
	);
	add(
		'create with duplicate labels',
		'POST',
		`${P}/issues`,
		{ title: T('H dup'), labels: 'conf-{{run}}-dup,conf-{{run}}-dup,CONF-{{run}}-DUP' },
		created({ h: 'iid' }, 'h')
	);

	// ---- update
	add('PUT title', 'PUT', I('a'), { title: T('A renamed') });
	add('PUT an empty title', 'PUT', I('a'), { title: '' });
	add('PUT no parameter', 'PUT', I('a'), {});
	add('PUT an unknown parameter', 'PUT', I('a'), { bogus: 1 });
	add('PUT a state (not a parameter)', 'PUT', I('a'), { state: 'closed' });
	add('PUT description null', 'PUT', I('a'), { description: null });
	add('PUT description with CRLF', 'PUT', I('a'), { description: 'a\r\nb  \r\n' });
	add('PUT state_event bogus', 'PUT', I('a'), { state_event: 'bogus' });
	add('PUT close', 'PUT', I('a'), { state_event: 'close' });
	add('PUT close again', 'PUT', I('a'), { state_event: 'close' });
	add('PUT reopen', 'PUT', I('a'), { state_event: 'reopen' });
	add('PUT reopen again', 'PUT', I('a'), { state_event: 'reopen' });
	add('PUT labels replace', 'PUT', I('a'), { labels: 'conf-{{run}}-c' });
	add('PUT add_labels', 'PUT', I('a'), { add_labels: 'conf-{{run}}-a,conf-{{run}}-b' });
	add('PUT remove_labels', 'PUT', I('a'), { remove_labels: 'conf-{{run}}-a' });
	add('PUT remove an unknown label', 'PUT', I('a'), { remove_labels: 'conf-{{run}}-never' });
	add('PUT labels with add_labels', 'PUT', I('a'), { labels: 'conf-{{run}}-x', add_labels: 'conf-{{run}}-y' });
	add('PUT labels with remove_labels', 'PUT', I('a'), {
		labels: 'conf-{{run}}-x,conf-{{run}}-y',
		remove_labels: 'conf-{{run}}-x',
	});
	add('PUT labels array', 'PUT', I('a'), { labels: ['conf-{{run}}-p', 'conf-{{run}}-q'] });
	add('PUT labels empty', 'PUT', I('a'), { labels: '' });
	add('PUT one swap: labels + close + title', 'PUT', I('a'), {
		labels: 'conf-{{run}}-doing',
		state_event: 'close',
		title: T('A swap'),
	});
	add('PUT issue_type incident', 'PUT', I('a'), { issue_type: 'incident' });
	add('PUT issue_type test_case (ignored)', 'PUT', I('a'), { issue_type: 'test_case' });
	add('PUT issue_type task (refused)', 'PUT', I('a'), { issue_type: 'task' });
	add('PUT issue_type issue', 'PUT', I('a'), { issue_type: 'issue' });
	add('PUT issue_type bogus', 'PUT', I('a'), { issue_type: 'bogus' });
	add('PUT an unknown issue', 'PUT', `${P}/issues/99999`, { title: 'x' });

	// ---- events
	add('label events of A', 'GET', `${I('a')}/resource_label_events`);
	add('state events of A', 'GET', `${I('a')}/resource_state_events`);
	add('events of an unknown issue', 'GET', `${P}/issues/99999/resource_label_events`);

	// ---- notes and system notes
	add('note', 'POST', `${I('f')}/notes`, { body: 'hello **note**' }, { step: { save: { n1: 'id' } } });
	add('note with an empty body', 'POST', `${I('f')}/notes`, { body: '' });
	add('note without body', 'POST', `${I('f')}/notes`, {});
	add('note with CRLF', 'POST', `${I('f')}/notes`, { body: 'a\r\nb  \r\n' }, { step: { save: { n2: 'id' } } });
	add('edit note', 'PUT', `${I('f')}/notes/{{n1}}`, { body: 'edited' });
	add('edit an unknown note', 'PUT', `${I('f')}/notes/99999999`, { body: 'x' });
	add('note on an unknown issue', 'POST', `${P}/issues/99999/notes`, { body: 'x' });
	add('PUT title of F (system note)', 'PUT', I('f'), { title: T('F renamed') });
	add('PUT description of F (system note)', 'PUT', I('f'), { description: 'v2' });
	add('PUT labels of F (no system note)', 'PUT', I('f'), { labels: 'conf-{{run}}-n1' });
	add('PUT close of F (no system note)', 'PUT', I('f'), { state_event: 'close' });
	add('PUT reopen of F', 'PUT', I('f'), { state_event: 'reopen' });
	add('PUT issue_type of F (system note)', 'PUT', I('f'), { issue_type: 'incident' });
	add('PUT due_date of F (system note)', 'PUT', I('f'), { due_date: '2030-01-02' });
	add('PUT confidential of F (system note)', 'PUT', I('f'), { confidential: true });
	add('PUT not confidential of F', 'PUT', I('f'), { confidential: false });
	add('notes of F, oldest first', 'GET', `${I('f')}/notes?sort=asc&order_by=created_at&per_page=100`, undefined, {
		step: { save: { sysnote: '0.id' } },
	});
	add('notes of F, only comments', 'GET', `${I('f')}/notes?sort=asc&activity_filter=only_comments`);
	add('notes of F, only activity', 'GET', `${I('f')}/notes?sort=asc&activity_filter=only_activity`);
	add('notes of an unknown issue', 'GET', `${P}/issues/99999/notes`);
	add('delete a note', 'DELETE', `${I('f')}/notes/{{n2}}`);
	add('delete a deleted note', 'DELETE', `${I('f')}/notes/{{n2}}`);
	add('note with a quick action only', 'POST', `${I('g')}/notes`, { body: '/close' });
	add('G after its quick action', 'GET', I('g'));
	add('reopen G', 'PUT', I('g'), { state_event: 'reopen' });
	add('note with text and a quick action', 'POST', `${I('g')}/notes`, {
		body: 'visible\n/label ~conf-{{run}}-nolabel',
	});
	add('note with an escaped quick action', 'POST', `${I('g')}/notes`, { body: '\\/close' });
	add('note with a quick action in a code fence', 'POST', `${I('g')}/notes`, { body: '```\n/close\n```' });
	add('G after the escaped ones', 'GET', I('g'));

	// ---- links
	add(
		'link A to B',
		'POST',
		`${I('a')}/links`,
		{ target_project_id: '{{projectPath}}', target_issue_iid: '{{b:n}}' },
		{ step: { save: { link1: 'id' } } }
	);
	add('links of A', 'GET', `${I('a')}/links`);
	add('links of B', 'GET', `${I('b')}/links`);
	add('same link again', 'POST', `${I('a')}/links`, {
		target_project_id: '{{projectPath}}',
		target_issue_iid: '{{b:n}}',
	});
	add('reverse link', 'POST', `${I('b')}/links`, {
		target_project_id: '{{projectPath}}',
		target_issue_iid: '{{a:n}}',
	});
	add('blocks link (paid)', 'POST', `${I('a')}/links`, {
		target_project_id: '{{projectPath}}',
		target_issue_iid: '{{d:n}}',
		link_type: 'blocks',
	});
	add('is_blocked_by link (paid)', 'POST', `${I('d')}/links`, {
		target_project_id: '{{projectPath}}',
		target_issue_iid: '{{a:n}}',
		link_type: 'is_blocked_by',
	});
	add('unknown link_type', 'POST', `${I('a')}/links`, {
		target_project_id: '{{projectPath}}',
		target_issue_iid: '{{d:n}}',
		link_type: 'bogus',
	});
	add('link to itself', 'POST', `${I('a')}/links`, {
		target_project_id: '{{projectPath}}',
		target_issue_iid: '{{a:n}}',
	});
	add('link without target', 'POST', `${I('a')}/links`, { target_project_id: '{{projectPath}}' });
	add('link to an unknown issue', 'POST', `${I('a')}/links`, {
		target_project_id: '{{projectPath}}',
		target_issue_iid: 99999,
	});
	add('link to an unknown project', 'POST', `${I('a')}/links`, {
		target_project_id: '999999999',
		target_issue_iid: 1,
	});
	add('link from an unknown issue', 'POST', `${P}/issues/99999/links`, {
		target_project_id: '{{projectPath}}',
		target_issue_iid: '{{a:n}}',
	});
	add('notes of B after the link', 'GET', `${I('b')}/notes?sort=asc`);
	add('delete the link', 'DELETE', `${I('a')}/links/{{link1}}`);
	add('delete the link again', 'DELETE', `${I('a')}/links/{{link1}}`);
	add('notes of B after the unlink', 'GET', `${I('b')}/notes?sort=asc`);

	// ---- project labels
	add(
		'create label',
		'POST',
		`${P}/labels`,
		{ name: 'conf-{{run}}-lab', color: '#FF0000', description: 'probe label' },
		{ step: { track: undefined } }
	);
	add('create the same label', 'POST', `${P}/labels`, { name: 'conf-{{run}}-lab', color: '#FF0000' });
	add('create a label without color', 'POST', `${P}/labels`, { name: 'conf-{{run}}-nocolor' });
	add('create a label with a bad color', 'POST', `${P}/labels`, { name: 'conf-{{run}}-bad', color: 'red!' });
	add('create a label with a color name', 'POST', `${P}/labels`, { name: 'conf-{{run}}-css', color: 'red' });
	add('create a label with an empty name', 'POST', `${P}/labels`, { name: '', color: '#FF0000' });
	add('create a label with a comma', 'POST', `${P}/labels`, { name: 'conf,{{run}}', color: '#FF0000' });
	add('create a label of 256 characters', 'POST', `${P}/labels`, {
		name: `conf-${'n'.repeat(251)}`,
		color: '#FF0000',
	});
	add('create a scoped looking label', 'POST', `${P}/labels`, {
		name: 'conf-{{run}}::scoped::deep',
		color: '#FF0000',
	});
	// `::` names are plain labels on Free: two of one scope stay together (no exclusivity). LIVE 2026-11-09 and by the owner in the UI.
	add(
		'create an issue with a scoped looking label',
		'POST',
		`${P}/issues`,
		{ title: T('S scoped'), labels: 'conf-{{run}}::scope::a' },
		created({ sc: 'iid' }, 'sc')
	);
	add('add a second label of the same scope', 'PUT', I('sc'), { add_labels: 'conf-{{run}}::scope::b' });
	add('replace with two labels of the same scope', 'PUT', I('sc'), {
		labels: 'conf-{{run}}::scope::a,conf-{{run}}::scope::b',
	});
	add('swap in one PUT between scoped looking labels', 'PUT', I('sc'), { labels: 'conf-{{run}}::scope::b' });
	add('list by a scoped looking label', 'GET', `${P}/issues?labels=conf-{{run}}%3A%3Ascope%3A%3Ab`);
	add('get a label', 'GET', `${P}/labels/conf-{{run}}-lab`);
	add('get a scoped looking label', 'GET', `${P}/labels/conf-{{run}}%3A%3Ascoped%3A%3Adeep`);
	add('rename a label', 'PUT', `${P}/labels/conf-{{run}}-lab`, {
		new_name: 'conf-{{run}}-lab2',
		description: 'renamed',
	});
	add('search labels', 'GET', `${P}/labels?search=conf-{{run}}-&per_page=100`);
	add('delete a label', 'DELETE', `${P}/labels/conf-{{run}}-lab2`);
	add('delete a deleted label', 'DELETE', `${P}/labels/conf-{{run}}-lab2`);

	// ---- lists (isolated by a label of this run)
	for (const n of ['1', '2', '3']) {
		add(
			`create list issue ${n}`,
			'POST',
			`${P}/issues`,
			{ title: T(`L${n}`), description: `list ${n}`, labels: LIST },
			created({ [`l${n}`]: 'iid' }, `l${n}`)
		);
	}
	add('list page 1 of 2', 'GET', `${P}/issues?labels=${LIST}&per_page=2`);
	add('list page 2', 'GET', `${P}/issues?labels=${LIST}&per_page=2&page=2`);
	add('list page beyond', 'GET', `${P}/issues?labels=${LIST}&per_page=2&page=9`);
	add('list by iids', 'GET', `${P}/issues?iids[]={{l1}}&iids[]={{l2}}`);
	add('list ascending by updated_at', 'GET', `${P}/issues?labels=${LIST}&order_by=updated_at&sort=asc`);
	add('list closed (none yet)', 'GET', `${P}/issues?labels=${LIST}&state=closed`);
	add('close L3', 'PUT', I('l3'), { state_event: 'close' });
	add('list opened', 'GET', `${P}/issues?labels=${LIST}&state=opened`);
	add('list closed', 'GET', `${P}/issues?labels=${LIST}&state=closed`);
	add('list search title', 'GET', `${P}/issues?labels=${LIST}&search=L2`);
	add('list search description', 'GET', `${P}/issues?labels=${LIST}&search=list%203`);
	add('list not labels', 'GET', `${P}/issues?labels=${LIST}&not[labels]=conf-{{run}}-nope`);
	add('list issue_type', 'GET', `${P}/issues?issue_type=task&labels=conf-{{run}}-nothing`);
	add('list per_page 0', 'GET', `${P}/issues?per_page=0`);
	add('list bad state', 'GET', `${P}/issues?state=bogus`);
	add('list bad order_by', 'GET', `${P}/issues?order_by=bogus`);
	add('list an etag', 'GET', `${P}/issues?labels=${LIST}&per_page=2`, undefined, {
		step: { saveHeaders: { listetag: 'etag' } },
	});
	add('list with that etag', 'GET', `${P}/issues?labels=${LIST}&per_page=2`, undefined, {
		request: { headers: { 'if-none-match': '{{listetag}}' } },
	});
	add('statistics', 'GET', `${P}/issues_statistics?labels=${LIST}`);

	// ---- hierarchy (GraphQL work items)
	add('read A hierarchy', 'POST', 'graphql', gqlRead('aid'));
	add('task C under issue A', 'POST', 'graphql', gqlParent('cid', 'aid'));
	add('read the parent A', 'POST', 'graphql', gqlRead('aid'));
	add('read the child C', 'POST', 'graphql', gqlRead('cid'));
	add('notes of C after the parent', 'GET', `${I('c')}/notes?sort=asc`);
	add('task E under task C', 'POST', 'graphql', gqlParent('eid', 'cid'));
	add('issue A under issue F', 'POST', 'graphql', gqlParent('aid', 'fid'));
	add('task C under itself', 'POST', 'graphql', gqlParent('cid', 'cid'));
	add('task C under incident B', 'POST', 'graphql', gqlParent('cid', 'bid'));
	add('task C under issue F', 'POST', 'graphql', gqlParent('cid', 'fid'));
	add('task C without parent', 'POST', 'graphql', gqlParent('cid', null));
	add('task C without parent again', 'POST', 'graphql', gqlParent('cid', null));
	add('unknown work item', 'POST', 'graphql', {
		query: GQL_SET_PARENT,
		variables: { input: { id: 'gid://gitlab/WorkItem/1', hierarchyWidget: { parentId: null } } },
	});
	add('convert D (test case) to task', 'POST', 'graphql', gqlConvert('did', 5));
	add('convert E to issue', 'POST', 'graphql', gqlConvert('eid', 1));
	add('convert E to test case', 'POST', 'graphql', gqlConvert('eid', 3));
	add('graphql syntax error', 'POST', 'graphql', { query: '{ nope }' });

	// ---- delete
	add('delete H', 'DELETE', I('h'));
	add('get the deleted issue', 'GET', I('h'));
	add('delete the deleted issue', 'DELETE', I('h'));
	add('notes of the deleted issue', 'GET', `${I('h')}/notes`);
	add('list by iids with the deleted one', 'GET', `${P}/issues?iids[]={{h}}&state=all`);

	// The groups below settle, one behaviour at a time, every line of fakeGitLabLedger.testkit.ts that the steps above do not.
	addLedgerSteps({ add, created, made, labelsMade });
	addTailSteps({ add, created, made });
	addTailSteps2({ add, created });
	return s;
}

export async function runScenario({ call, projectPath, run, apiBase, track }) {
	const kit = await import(kitUrl);
	const ctx = { run, apiBase };
	const vars = kit.scenarioVariables(projectPath, run);
	const out = [];
	const base = new Date().toISOString().slice(0, 10);
	// GL_SCENARIO_FROM=<step name> records only the tail of the scenario starting at that step (a few steps added later).
	const all = steps();
	const from = process.env.GL_SCENARIO_FROM;
	const start = from === undefined || from === '' ? 0 : all.findIndex(candidate => candidate.name === from);
	if (start < 0) throw new Error(`GL_SCENARIO_FROM: no scenario step is named "${from}"`);
	for (const step of all.slice(start)) {
		const request = JSON.parse(JSON.stringify(step.request));
		const path = kit.substitute(request.path, vars);
		const body = request.body === undefined ? undefined : kit.substitute(request.body, vars);
		const headers = request.headers === undefined ? undefined : kit.substitute(request.headers, vars);
		const opts = { headers };
		if (request.auth === 'none') opts.token = null;
		else if (request.auth === 'bad') opts.token = 'glpat-xxxxxxxxxxxxxxxxxxxx';
		else if (request.auth === 'bearer') {
			// The probe client only knows the PRIVATE-TOKEN header: the Bearer step reads the token from the same variable it does.
			const secret = process.env.GL_TEST_TOKEN ?? '';
			if (secret === '')
				throw new Error(
					`scenario step "${step.name}" needs the token in GL_TEST_TOKEN to build its Authorization: Bearer header`
				);
			opts.token = null;
			opts.headers = { ...(headers ?? {}), authorization: `Bearer ${secret}` };
		}
		if (request.rawBody !== undefined) opts.rawBody = kit.substitute(request.rawBody, vars);
		const r = await call(`scenario: ${step.name}`, request.method, path, body, opts);
		const raw = { status: r.status, headers: r.headers, text: r.text, json: r.json };
		const expect = kit.normalizeAnswer(raw, ctx);
		const problems = [];
		for (const [name, dotted] of Object.entries(step.save ?? {})) {
			const found = kit.pick(r.json, dotted);
			if (found === undefined || found === null) problems.push(`save ${name}: nothing at ${dotted}`);
			else vars[name] = String(found);
		}
		for (const [name, header] of Object.entries(step.saveHeaders ?? {})) {
			if (r.headers[header] === undefined) problems.push(`save ${name}: no ${header} header`);
			else vars[name] = r.headers[header];
		}
		if (step.track !== undefined && vars[step.track] !== undefined) track.issues.add(Number(vars[step.track]));
		const issueIid = /^issues\/(\d+)$/.exec(path.replace(/^projects\/[^/]+\//, ''))?.[1];
		void issueIid;
		console.log(
			`  ${String(r.status).padStart(3)} ${String(r.ms).padStart(4)}ms ${step.name}${problems.length ? ` !! ${problems.join('; ')}` : ''}`
		);
		for (const name of step.trackLabels ?? []) track.labels.add(kit.substitute(name, vars));
		const { track: _track, trackLabels: _trackLabels, ...kept } = step;
		void _track;
		void _trackLabels;
		out.push({ ...kept, expect });
	}
	// Labels created implicitly by the issues of the scenario.
	for (const name of [
		'x',
		'y',
		'c',
		'a',
		'b',
		'p',
		'q',
		'doing',
		'arr1',
		'arr2',
		'dup',
		'list',
		'n1',
		'bad',
		'css',
		'nolabel',
		'nocolor',
	]) {
		track.labels.add(`conf-${run}-${name}`);
	}
	track.labels.add(`CONF-${run}-DUP`);
	track.labels.add(`conf-${run}::scoped::deep`);
	track.labels.add(`conf-${run}::scope::a`);
	track.labels.add(`conf-${run}::scope::b`);
	track.labels.add(`conf-${run}-lab`);
	track.labels.add(`conf-${run}-lab2`);
	return {
		format: 1,
		recordedAt: base,
		source: 'gitlab.com Free tier (fine-grained token), wadeck-app/test-task-gl',
		steps: out,
	};
}

// ================================================================================================================================
// The ledger groups. Every step below is named in the `evidence` of a line of fakeGitLabLedger.testkit.ts (the conformance test
// fails when a line names a step that is not here, or that the recorded fixture does not hold yet). Groups are independent of one
// another except through the variables they save; a group that needs another one says so. Titles carry the [task-api-test] prefix
// (T); big texts are `$repeat` objects so the fixture stays small.
// ================================================================================================================================
const RAW = (unit, count, prefix) => ({ $repeat: prefix === undefined ? [unit, count] : [unit, count, prefix] });
const PREFIX = '[task-api-test] ';
// A two-byte character, written as an escape so this file stays ASCII.
const E_ACUTE = String.fromCharCode(0xe9);
const M_LABELS = Array.from({ length: 100 }, (_, i) => `conf-{{run}}-m${i}`);

function addLedgerSteps({ add, created, made, labelsMade }) {
	const ISSUES = `${P}/issues`;
	const note = (name, issue, body) => add(name, 'POST', `${I(issue)}/notes`, { body });
	const get = (name, p, request) => add(name, 'GET', p, undefined, request === undefined ? {} : { request });
	const gqlQuery = (name, query, variables, request) =>
		add(
			name,
			'POST',
			'graphql',
			{ query, ...(variables === undefined ? {} : { variables }) },
			request === undefined ? {} : { request }
		);

	// ---- group 1: identity, instance endpoints and what a fine-grained token may not read (findings: Token type, Anonymous)
	get('GET user (denied)', 'user');
	get('GET version (denied)', 'version');
	get('GET metadata (denied)', 'metadata');
	get('GET personal_access_tokens/self (denied)', 'personal_access_tokens/self');
	get('GET the project (denied)', P);
	get('GET the namespace (denied)', 'namespaces/{{group}}');
	get('GET members (denied)', `${P}/members`);
	get('GET languages (denied)', `${P}/languages`);
	get('GET hooks (denied)', `${P}/hooks`);
	get('GET search (denied)', 'search?scope=issues&search=x');
	get('GET an issue by its global id (denied)', 'issues/{{aid}}');
	get('GET the instance issue list', 'issues?per_page=1');
	get('GET version without a token', 'version', { auth: 'none' });
	get('GET user without a token', 'user', { auth: 'none' });
	get('GET user with a bad token', 'user', { auth: 'bad' });
	get('GET an unknown route without a token', 'nothing-here', { auth: 'none' });
	get('bearer token', `${ISSUES}?per_page=1`, { auth: 'bearer' });
	get('GET an unknown project (denied route)', 'projects/{{P}}-nope');
	get('get an issue by its global id on the project route', I('aid'));
	get('get A with If-None-Match star', I('a'), { headers: { 'if-none-match': '*' } });
	get('get A with a stale etag', I('a'), { headers: { 'if-none-match': '{{etag}}' } });
	get('get A with If-Modified-Since', I('a'), { headers: { 'if-modified-since': 'Wed, 01 Jan 2031 00:00:00 GMT' } });
	add(
		'PUT with a stale If-Match',
		'PUT',
		I('a'),
		{ title: T('A swap') },
		{ request: { headers: { 'if-match': 'W/"0"' } } }
	);
	add(
		'PUT with If-Unmodified-Since in the past',
		'PUT',
		I('a'),
		{ title: T('A swap') },
		{ request: { headers: { 'if-unmodified-since': 'Wed, 01 Jan 2020 00:00:00 GMT' } } }
	);
	get('list with the project path in upper case', 'projects/{{PU}}/issues?per_page=1');
	get('list in an unknown project by its numeric id', 'projects/999999999/issues');
	add('create in an unknown project', 'POST', 'projects/{{P}}-nope/issues', { title: T('nope') });
	get('labels of an unknown project', 'projects/{{P}}-nope/labels');
	add('graphql without a token', 'POST', 'graphql', { query: '{ __typename }' }, { request: { auth: 'none' } });
	add('graphql with a bad token', 'POST', 'graphql', { query: '{ __typename }' }, { request: { auth: 'bad' } });
	add('POST on the issue route', 'POST', I('a'), {});
	add('DELETE on the issues route', 'DELETE', ISSUES);
	add('PUT on the issues route', 'PUT', ISSUES, {});
	add('POST on the events route', 'POST', `${I('a')}/resource_label_events`, {});
	add('create with no body at all', 'POST', ISSUES);
	add('PUT without a body', 'PUT', I('a'));

	// ---- group 2: size limits (findings: Create, Update, Notes). Big texts are `$repeat`.
	add(
		'create with a title of 255 characters',
		'POST',
		ISSUES,
		{ title: RAW('t', 239, PREFIX) },
		created({ t255: 'iid' }, 't255')
	);
	add(
		'create with a title of 255 two-byte characters',
		'POST',
		ISSUES,
		{ title: RAW(E_ACUTE, 239, PREFIX) },
		created({ tb: 'iid' }, 'tb')
	);
	add('PUT a title of 255 characters', 'PUT', I('t255'), { title: RAW('u', 239, PREFIX) });
	add('PUT a title of 256 characters', 'PUT', I('t255'), { title: RAW('u', 240, PREFIX) });
	add(
		'create with 100 labels',
		'POST',
		ISSUES,
		{ title: T('M 100 labels'), labels: M_LABELS.join(',') },
		made({ m: 'iid' }, 'm', M_LABELS)
	);
	add('create with 101 labels', 'POST', ISSUES, {
		title: T('M 101 labels'),
		labels: [...M_LABELS, 'conf-{{run}}-m100'].join(','),
	});
	add('PUT 101 labels', 'PUT', I('m'), { labels: [...M_LABELS, 'conf-{{run}}-m100'].join(',') });
	add('PUT add_labels beyond 100', 'PUT', I('m'), { add_labels: 'conf-{{run}}-m100' });
	add('PUT 100 labels plus a duplicate', 'PUT', I('m'), { labels: [...M_LABELS, M_LABELS[0]].join(',') });
	add(
		'create with a description of 1048576 characters',
		'POST',
		ISSUES,
		{ title: T('D max'), description: RAW('d', 1048576) },
		created({ dmax: 'iid' }, 'dmax')
	);
	add('create with a description of 1048577 characters', 'POST', ISSUES, {
		title: T('D over'),
		description: RAW('d', 1048577),
	});
	add(
		'create with a description of 600000 two-byte characters',
		'POST',
		ISSUES,
		{ title: T('D bytes'), description: RAW(E_ACUTE, 600000) },
		created({ dbyte: 'iid' }, 'dbyte')
	);
	add('PUT a description of 1048576 characters', 'PUT', I('t255'), { description: RAW('d', 1048576) });
	add('PUT a description of 1048577 characters', 'PUT', I('t255'), { description: RAW('d', 1048577) });
	add(
		'note of 1000001 characters',
		'POST',
		`${I('dmax')}/notes`,
		{ body: RAW('n', 1000001) },
		{ step: { save: { nbig: 'id' } } }
	);
	add('edit a note to 1000001 characters', 'PUT', `${I('dmax')}/notes/{{nbig}}`, { body: RAW('m', 1000001) });

	// ---- group 3: list parameters on the 3 issues of the LIST label (findings: Pagination)
	get('list per_page 101 (clamped)', `${ISSUES}?labels=${LIST}&per_page=101`);
	get('list page 0', `${ISSUES}?labels=${LIST}&per_page=2&page=0`);
	get('list page -1', `${ISSUES}?labels=${LIST}&per_page=2&page=-1`);
	get('list per_page -1', `${ISSUES}?labels=${LIST}&per_page=-1`);
	get('list per_page not a number', `${ISSUES}?labels=${LIST}&per_page=abc`);
	get('list page not a number', `${ISSUES}?labels=${LIST}&page=abc`);
	get('list sort bogus', `${ISSUES}?labels=${LIST}&sort=bogus`);
	get('list ascending by created_at', `${ISSUES}?labels=${LIST}&order_by=created_at&sort=asc`);
	get(
		'list keyset pagination',
		`${ISSUES}?labels=${LIST}&pagination=keyset&per_page=2&order_by=created_at&sort=desc`
	);
	get('list with label details', `${ISSUES}?labels=${LIST}&per_page=1&with_labels_details=true`);
	get('list state all', `${ISSUES}?labels=${LIST}&state=all`);
	get('list created_after in the future', `${ISSUES}?labels=${LIST}&created_after=2999-01-01T00:00:00Z`);
	get('list created_before in the future', `${ISSUES}?labels=${LIST}&created_before=2999-01-01T00:00:00Z`);
	get('list updated_after in the future', `${ISSUES}?labels=${LIST}&updated_after=2999-01-01T00:00:00Z`);
	get('list updated_before in the future', `${ISSUES}?labels=${LIST}&updated_before=2999-01-01T00:00:00Z`);
	get('list created_after not a date', `${ISSUES}?labels=${LIST}&created_after=nope`);
	get('list with an empty search', `${ISSUES}?labels=${LIST}&search=`);
	get('list with an empty labels', `${ISSUES}?iids[]={{l1}}&labels=`);
	get('list incident by iid', `${ISSUES}?iids[]={{b}}&issue_type=incident`);
	get('list task by the iid of an incident', `${ISSUES}?iids[]={{b}}&issue_type=task`);
	get('list an unknown iid', `${ISSUES}?iids[]=99999`);
	get('list a non numeric iid', `${ISSUES}?iids[]=abc`);
	get('list with an unknown filter', `${ISSUES}?labels=${LIST}&bogus=1`);

	// ---- group 4: labels, search, not[labels], statistics on three issues made for it (Z0 no label, Z1 one, Z2 two)
	add(
		'create Z0 (no label)',
		'POST',
		ISSUES,
		{ title: T('zed{{run}} none'), description: 'desc{{run}} body only' },
		created({ z0: 'iid' }, 'z0')
	);
	add(
		'create Z1 (one label)',
		'POST',
		ISSUES,
		{ title: T('zed{{run}} one'), labels: 'conf-{{run}}-z1' },
		made({ z1: 'iid' }, 'z1', ['conf-{{run}}-z1'])
	);
	add(
		'create Z2 (two labels)',
		'POST',
		ISSUES,
		{ title: T('zed{{run}} two'), labels: 'conf-{{run}}-z1,conf-{{run}}-z2' },
		made({ z2: 'iid' }, 'z2', ['conf-{{run}}-z2'])
	);
	const Z = `${ISSUES}?search=zed{{run}}`;
	get('list Z with no label', `${Z}&labels=None`);
	get('list Z with any label', `${Z}&labels=Any`);
	get('list Z by one label', `${Z}&labels=conf-{{run}}-z1`);
	get('list Z by two labels (all of them)', `${Z}&labels=conf-{{run}}-z1,conf-{{run}}-z2`);
	get('list Z not one label', `${Z}&not[labels]=conf-{{run}}-z1`);
	get('list Z not the other label', `${Z}&not[labels]=conf-{{run}}-z2`);
	get('list Z not two labels', `${Z}&not[labels]=conf-{{run}}-z1,conf-{{run}}-z2`);
	get('list Z by a label and not another', `${Z}&labels=conf-{{run}}-z1&not[labels]=conf-{{run}}-z2`);
	get('list search in the description only', `${ISSUES}?search=desc{{run}}`);
	get('list search of a description with in=title', `${ISSUES}?search=desc{{run}}&in=title`);
	get('list search of a description with in=description', `${ISSUES}?search=desc{{run}}&in=description`);
	get('list search of a title with in=description', `${Z}&in=description`);
	get('list search of a title with in=title', `${Z}&in=title`);
	get('list search with in=title,description', `${ISSUES}?search=desc{{run}}&in=title,description`);
	get('list search with an unknown in value', `${Z}&in=bogus`);
	get('list search in upper case', `${ISSUES}?search=ZED{{run}}`);
	get('list search inside a word', `${ISSUES}?search=ed{{run}}`);
	get('list search of one character', `${ISSUES}?search=z&labels=conf-{{run}}-z1`);
	get('list search of two words in order', `${ISSUES}?search=zed{{run}}%20one`);
	get('list search of two words reversed', `${ISSUES}?search=one%20zed{{run}}`);
	get('statistics of Z', `${P}/issues_statistics?search=zed{{run}}`);
	get('statistics of Z with a state', `${P}/issues_statistics?search=zed{{run}}&state=opened`);
	get('statistics of Z with labels=None', `${P}/issues_statistics?search=zed{{run}}&labels=None`);

	// ---- group 5: what bumps updated_at, read through the ORDER of two issues (instants are normalized, the order is not)
	const ORD = `${ISSUES}?iids[]={{u1}}&iids[]={{u2}}&order_by=updated_at&sort=desc`;
	const bump = why => add(`bump U2 (${why})`, 'PUT', I('u2'), { title: T(`U2 bump ${why}`) });
	add('create U1', 'POST', ISSUES, { title: T('U1') }, created({ u1: 'iid' }, 'u1'));
	add('create U2', 'POST', ISSUES, { title: T('U2') }, created({ u2: 'iid' }, 'u2'));
	get('updated order at the start', ORD);
	add('note on U1', 'POST', `${I('u1')}/notes`, { body: 'a note' }, { step: { save: { un: 'id' } } });
	get('updated order after a note', ORD);
	add('PUT the same title on U1', 'PUT', I('u1'), { title: T('U1') });
	get('updated order after the same title', ORD);
	add('PUT a new title on U1', 'PUT', I('u1'), { title: T('U1 renamed') });
	get('updated order after a new title', ORD);
	bump('description');
	add('PUT a description on U1', 'PUT', I('u1'), { description: 'first description' });
	get('updated order after a description', ORD);
	bump('same description');
	add('PUT the same description on U1', 'PUT', I('u1'), { description: 'first description' });
	get('updated order after the same description', ORD);
	bump('labels');
	add('PUT labels on U1', 'PUT', I('u1'), { labels: 'conf-{{run}}-uo' }, labelsMade(['conf-{{run}}-uo']));
	get('updated order after labels', ORD);
	bump('same labels');
	add('PUT the same labels on U1', 'PUT', I('u1'), { labels: 'conf-{{run}}-uo' });
	get('updated order after the same labels', ORD);
	bump('note edit');
	add('edit the note of U1', 'PUT', `${I('u1')}/notes/{{un}}`, { body: 'an edited note' });
	get('updated order after a note edit', ORD);
	bump('close');
	add('PUT close of U1', 'PUT', I('u1'), { state_event: 'close' });
	get('updated order after a close', ORD);
	bump('repeated close');
	add('PUT close of U1 again', 'PUT', I('u1'), { state_event: 'close' });
	get('updated order after a repeated close', ORD);
	bump('updated_at');
	add('PUT updated_at in the future on U1', 'PUT', I('u1'), { updated_at: '2999-01-01T00:00:00.000Z' });
	get('updated order after updated_at in the future', ORD);
	add('PUT a title on U2 after that', 'PUT', I('u2'), { title: T('U2 after the future stamp') });
	get('updated order after a later change of U2', ORD);
	// A number is accepted as a title (seen in the discovery); U2 gets its prefixed title back right after.
	add('PUT a numeric title', 'PUT', I('u2'), { title: 2031 });
	add('PUT a title after the numeric one', 'PUT', I('u2'), { title: T('U2 restored') });

	// ---- group 6: events and notes corners (findings: Events, Notes). Needs F, B, A, L1 and the notes n1 / sysnote of the first groups.
	add(
		'create EV with a label',
		'POST',
		ISSUES,
		{ title: T('EV'), labels: 'conf-{{run}}-ev' },
		made({ ev: 'iid' }, 'ev', ['conf-{{run}}-ev'])
	);
	get('label events of EV', `${I('ev')}/resource_label_events`);
	add('delete the label of EV', 'DELETE', `${P}/labels/conf-{{run}}-ev`);
	get('label events of EV after the label was deleted', `${I('ev')}/resource_label_events`);
	get('EV after its label was deleted', I('ev'));
	get('label events of an issue without labels', `${I('b')}/resource_label_events`);
	get('state events of an issue never closed', `${I('l1')}/resource_state_events`);
	get('state events of F', `${I('f')}/resource_state_events`);
	get('label events of A, one per page', `${I('a')}/resource_label_events?per_page=1&page=2`);
	get('state events of an unknown issue', `${P}/issues/99999/resource_state_events`);
	get('events of a non numeric issue', `${P}/issues/abc/resource_label_events`);
	get('notes of F, two per page', `${I('f')}/notes?sort=asc&per_page=2&page=2`);
	get('notes with a bad activity_filter', `${I('f')}/notes?activity_filter=bogus`);
	get('notes with a bad order_by', `${I('f')}/notes?order_by=bogus`);
	get('notes with a bad sort', `${I('f')}/notes?sort=bogus`);
	get('notes ordered by updated_at', `${I('f')}/notes?order_by=updated_at&sort=asc`);
	get('get a note', `${I('f')}/notes/{{n1}}`);
	get('get an unknown note', `${I('f')}/notes/99999999`);
	add('delete an unknown note', 'DELETE', `${I('f')}/notes/99999999`);
	add('edit a note without body', 'PUT', `${I('f')}/notes/{{n1}}`, {});
	add('edit a note with an empty body', 'PUT', `${I('f')}/notes/{{n1}}`, { body: '' });
	// (the variable `sysnote` of the first group holds the OLDEST note, which is the comment: the system note is read here)
	add(
		'the oldest system note of F',
		'GET',
		`${I('f')}/notes?activity_filter=only_activity&sort=asc&per_page=1`,
		undefined,
		{ step: { save: { sysid: '0.id' } } }
	);
	add('edit a system note', 'PUT', `${I('f')}/notes/{{sysid}}`, { body: 'x' });
	add('delete a system note', 'DELETE', `${I('f')}/notes/{{sysid}}`);
	note('note with a whitespace body', 'f', '   ');
	get('notes of F, default order', `${I('f')}/notes?per_page=100`);
	add('PUT the deleted issue', 'PUT', I('h'), { title: T('H again') });

	// ---- group 7: quick actions in notes and descriptions (findings: Quick actions). Q, Q2, Q3 are made for it.
	add(
		'create Q',
		'POST',
		ISSUES,
		{ title: T('Q'), labels: 'conf-{{run}}-qa' },
		made({ q: 'iid', qid: 'id', pid: 'project_id' }, 'q', ['conf-{{run}}-qa'])
	);
	add('create Q2', 'POST', ISSUES, { title: T('Q2') }, created({ q2: 'iid' }, 'q2'));
	add('create Q3', 'POST', ISSUES, { title: T('Q3') }, created({ q3: 'iid' }, 'q3'));
	add(
		'create the label qb',
		'POST',
		`${P}/labels`,
		{ name: 'conf-{{run}}-qb', color: '#00AA00' },
		labelsMade(['conf-{{run}}-qb'])
	);
	add(
		'create the label qc',
		'POST',
		`${P}/labels`,
		{ name: 'conf-{{run}}-qc', color: '#AA00AA' },
		labelsMade(['conf-{{run}}-qc'])
	);
	add(
		'create the label with spaces',
		'POST',
		`${P}/labels`,
		{ name: 'conf-{{run}} two words', color: '#AA0000' },
		labelsMade(['conf-{{run}} two words'])
	);
	note('note with a quick action in backticks', 'q3', '`/close`');
	get('Q3 after the backtick note', I('q3'));
	note('quick action /reopen on an open issue', 'q', '/reopen');
	note('quick action /close', 'q', '/close');
	get('Q after /close', I('q'));
	note('quick action /close on a closed issue', 'q', '/close');
	note('quick action /reopen', 'q', '/reopen');
	note('quick action /label with an existing label', 'q', '/label ~conf-{{run}}-qb');
	get('Q after /label', I('q'));
	note('quick action /label with a label already held', 'q', '/label ~conf-{{run}}-qb');
	note('quick action /label with a label that has spaces', 'q', '/label ~"conf-{{run}} two words"');
	note('quick action /label with two labels', 'q', '/label ~conf-{{run}}-qb ~conf-{{run}}-qc');
	note('quick action /unlabel with a label', 'q', '/unlabel ~conf-{{run}}-qb');
	note('quick action /unlabel with a label not held', 'q', '/unlabel ~conf-{{run}}-qb');
	note('quick action /unlabel without argument', 'q', '/unlabel');
	get('Q after /unlabel', I('q'));
	get('label events of Q', `${I('q')}/resource_label_events?per_page=100`);
	note('quick action /relate', 'q', '/relate #{{q2}}');
	get('notes of Q2 after /relate', `${I('q2')}/notes?sort=asc`);
	get('links of Q after /relate', `${I('q')}/links`);
	note('quick action /relate again', 'q', '/relate #{{q2}}');
	note('quick action /relate to an unknown issue', 'q', '/relate #99999');
	note('quick action /relate without argument', 'q', '/relate');
	note('quick action /duplicate', 'q', '/duplicate #{{q3}}');
	get('Q after /duplicate', I('q'));
	get('notes of Q after /duplicate', `${I('q')}/notes?sort=asc&per_page=100`);
	get('notes of Q3 after /duplicate', `${I('q3')}/notes?sort=asc`);
	get('links of Q after /duplicate', `${I('q')}/links`);
	note('quick action /duplicate on itself', 'q2', '/duplicate #{{q2}}');
	note('note with text and two quick actions', 'q2', 'visible\n/label ~conf-{{run}}-qb\n/close');
	get('Q2 after the two quick actions', I('q2'));
	add(
		'note with an unknown quick action',
		'POST',
		`${I('q2')}/notes`,
		{ body: '/bogus' },
		{ step: { save: { qn: 'id' } } }
	);
	add('edit a note into a quick action', 'PUT', `${I('q2')}/notes/{{qn}}`, { body: '/reopen' });
	get('Q2 after the note edit', I('q2'));
	note('note with an uppercase quick action', 'q2', '/CLOSE');
	add(
		'create with a quick action in the description',
		'POST',
		ISSUES,
		{ title: T('QD'), description: 'kept\n/label ~conf-{{run}}-qb\n/close' },
		created({ qd: 'iid' }, 'qd')
	);
	get('notes of QD', `${I('qd')}/notes?sort=asc`);
	add('PUT a description with a quick action', 'PUT', I('q3'), { description: 'visible\n/close' });
	get('Q3 after the description quick action', I('q3'));

	// ---- group 8: due date, lock, confidentiality and parameters of the paid tiers (findings: Other fields on Free, Update)
	add(
		'create with a due date',
		'POST',
		ISSUES,
		{ title: T('DD'), due_date: '2031-05-06' },
		created({ dd: 'iid' }, 'dd')
	);
	get('notes of DD after the creation', `${I('dd')}/notes?sort=asc`);
	add('PUT due_date null', 'PUT', I('dd'), { due_date: null });
	add('PUT due_date again', 'PUT', I('dd'), { due_date: '2031-07-08' });
	add('PUT the same due_date', 'PUT', I('dd'), { due_date: '2031-07-08' });
	add('PUT due_date empty string', 'PUT', I('dd'), { due_date: '' });
	add('PUT due_date with an invalid date', 'PUT', I('dd'), { due_date: '2031-13-45' });
	add('PUT due_date not a date', 'PUT', I('dd'), { due_date: 'tomorrow' });
	get('notes of DD after the due date changes', `${I('dd')}/notes?sort=asc`);
	add('PUT discussion_locked', 'PUT', I('dd'), { discussion_locked: true });
	add('PUT discussion_locked false', 'PUT', I('dd'), { discussion_locked: false });
	add('PUT confidential with a bad value', 'PUT', I('dd'), { confidential: 'maybe' });
	get('notes of DD after the lock', `${I('dd')}/notes?sort=asc`);
	add('create confidential', 'POST', ISSUES, { title: T('CF'), confidential: true }, created({ cf: 'iid' }, 'cf'));
	get('notes of the confidential issue', `${I('cf')}/notes?sort=asc`);
	add('create with a bad confidential', 'POST', ISSUES, { title: T('CFbad'), confidential: 'maybe' });
	add('create with a bad due_date', 'POST', ISSUES, { title: T('DDbad'), due_date: 'nope' });
	add('PUT weight (paid)', 'PUT', I('dd'), { weight: 3 });
	add('PUT health_status (paid)', 'PUT', I('dd'), { health_status: 'on_track' });
	add('PUT iteration_id (paid)', 'PUT', I('dd'), { iteration_id: 1 });
	add('PUT epic_id', 'PUT', I('dd'), { epic_id: 5 });
	add('PUT epic_iid', 'PUT', I('dd'), { epic_iid: 5 });
	add('create with weight (paid)', 'POST', ISSUES, { title: T('W'), weight: 3 }, created({ wt: 'iid' }, 'wt'));
	add('POST move without a target', 'POST', `${I('dd')}/move`, {});
	add('POST move to an unknown project', 'POST', `${I('dd')}/move`, { to_project_id: 999999999 });

	// ---- group 9: creating issues in other ways (findings: Create). Forms, query strings, labels given in odd shapes.
	add('create with a form encoded body', 'POST', ISSUES, undefined, {
		request: {
			rawBody: 'title=%5Btask-api-test%5D+conf+{{run}}+form&labels=conf-{{run}}-form1%2Cconf-{{run}}-form2',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
		},
		step: { save: { fm: 'iid' }, track: 'fm', trackLabels: ['conf-{{run}}-form1', 'conf-{{run}}-form2'] },
	});
	add(
		'create with the title in the query string',
		'POST',
		`${ISSUES}?title=%5Btask-api-test%5D+conf+{{run}}+query`,
		undefined,
		{ step: { save: { qs: 'iid' }, track: 'qs' } }
	);
	add(
		'create with an explicit issue_type issue',
		'POST',
		ISSUES,
		{ title: T('explicit issue'), issue_type: 'issue' },
		created({ ei: 'iid' }, 'ei')
	);
	add(
		'create with a null issue_type',
		'POST',
		ISSUES,
		{ title: T('null type'), issue_type: null },
		created({ nt: 'iid' }, 'nt')
	);
	add(
		'create with an unknown field',
		'POST',
		ISSUES,
		{ title: T('unknown field'), bogus: 1 },
		created({ uf: 'iid' }, 'uf')
	);
	add(
		'create with a checklist',
		'POST',
		ISSUES,
		{ title: T('checklist'), description: '- [ ] one\n- [x] two\n* [X] three\n1. [ ] four' },
		created({ cl: 'iid' }, 'cl')
	);
	add(
		'create with a null description',
		'POST',
		ISSUES,
		{ title: T('null description'), description: null },
		created({ nd: 'iid' }, 'nd')
	);
	add(
		'create with an empty labels string',
		'POST',
		ISSUES,
		{ title: T('empty labels'), labels: '' },
		created({ el: 'iid' }, 'el')
	);
	add(
		'create with spaces around the labels',
		'POST',
		ISSUES,
		{ title: T('spaced labels'), labels: ' conf-{{run}}-sp1 , conf-{{run}}-sp2 ' },
		made({ sl: 'iid' }, 'sl', ['conf-{{run}}-sp1', 'conf-{{run}}-sp2'])
	);
	add(
		'create with a comma inside an array element',
		'POST',
		ISSUES,
		{ title: T('comma element'), labels: ['conf-{{run}}-cm1,conf-{{run}}-cm2'] },
		made({ ce: 'iid' }, 'ce', ['conf-{{run}}-cm1', 'conf-{{run}}-cm2'])
	);
	add('PUT labels null', 'PUT', I('ce'), { labels: null });
	add('PUT add_labels empty', 'PUT', I('ce'), { add_labels: '' });
	add('PUT remove_labels of several labels', 'PUT', I('sl'), { remove_labels: 'conf-{{run}}-sp1,conf-{{run}}-sp2' });
	add('PUT labels with a comma inside an array element', 'PUT', I('sl'), {
		labels: ['conf-{{run}}-cm1,conf-{{run}}-cm2'],
	});

	// ---- group 10: project labels (findings: Labels)
	const HEX = [
		'#000000',
		'#FFFFFF',
		'#FFFF00',
		'#336699',
		'#7F7F7F',
		'#808080',
		'#999999',
		'#AAAAAA',
		'#BBBBBB',
		'#00FF00',
		'#00FFFF',
		'#FF00FF',
		'#FFA500',
	];
	for (const hex of HEX) {
		const name = `conf-{{run}}-cx-${hex.slice(1)}`;
		add(`create a label with the color ${hex}`, 'POST', `${P}/labels`, { name, color: hex }, labelsMade([name]));
	}
	const CSS = [
		'blue',
		'green',
		'black',
		'white',
		'yellow',
		'orange',
		'purple',
		'gray',
		'grey',
		'pink',
		'brown',
		'cyan',
		'aqua',
		'magenta',
		'fuchsia',
		'lime',
		'navy',
		'teal',
		'maroon',
		'olive',
		'silver',
	];
	for (const color of CSS) {
		const name = `conf-{{run}}-cn-${color}`;
		add(`create a label with the color name ${color}`, 'POST', `${P}/labels`, { name, color }, labelsMade([name]));
	}
	const COLOR_FORMS = [
		['three digits #F00', '#F00', 'c3'],
		['lower case #ff0000', '#ff0000', 'cl'],
		['no hash FF0000', 'FF0000', 'cnh'],
		['upper case name RED', 'RED', 'cur'],
		['an invalid hex #GGGGGG', '#GGGGGG', 'cgg'],
		['a short wrong length #FF00', '#FF00', 'cs'],
	];
	for (const [what, color, tag] of COLOR_FORMS) {
		const name = `conf-{{run}}-cf-${tag}`;
		add(`create a label with the color ${what}`, 'POST', `${P}/labels`, { name, color }, labelsMade([name]));
	}
	const ODD = [
		['edge spaces', '  conf-{{run}}-sp  '],
		['a slash', 'conf-{{run}}-a/b'],
		['a percent', 'conf-{{run}}-50%'],
		['an ampersand', 'conf-{{run}}-a&b'],
		['double quotes', 'conf-{{run}}-"q"'],
		['a single quote', "conf-{{run}}-'q'"],
		['a tab', 'conf-{{run}}-t\tb'],
		['an emoji', 'conf-{{run}}-\u{1F600}'],
		['accents', `conf-{{run}}-caf${E_ACUTE}`],
		['a colon', 'conf-{{run}}-a:b'],
		['a plus', 'conf-{{run}}-a+b'],
	];
	for (const [what, name] of ODD)
		add(
			`create a label with ${what}`,
			'POST',
			`${P}/labels`,
			{ name, color: '#123456' },
			labelsMade([name.trim()])
		);
	add(
		'create a label of 255 characters',
		'POST',
		`${P}/labels`,
		{ name: RAW('n', 250, 'conf-'), color: '#123456' },
		labelsMade([RAW('n', 250, 'conf-')])
	);
	add(
		'create a label with a description of 300 characters',
		'POST',
		`${P}/labels`,
		{ name: 'conf-{{run}}-d300', color: '#123456', description: RAW('d', 300) },
		labelsMade(['conf-{{run}}-d300'])
	);
	add(
		'create a label with a description of 1000 characters',
		'POST',
		`${P}/labels`,
		{ name: 'conf-{{run}}-d1000', color: '#123456', description: RAW('d', 1000) },
		labelsMade(['conf-{{run}}-d1000'])
	);
	add(
		'create a label with a null description',
		'POST',
		`${P}/labels`,
		{ name: 'conf-{{run}}-dnull', color: '#123456', description: null },
		labelsMade(['conf-{{run}}-dnull'])
	);
	add(
		'create a label to read by id',
		'POST',
		`${P}/labels`,
		{ name: 'conf-{{run}}-byid', color: '#123456' },
		{ step: { save: { lid: 'id' }, trackLabels: ['conf-{{run}}-byid', 'conf-{{run}}-byid2'] } }
	);
	add(
		'create a label to collide with',
		'POST',
		`${P}/labels`,
		{ name: 'conf-{{run}}-coll', color: '#123456' },
		labelsMade(['conf-{{run}}-coll'])
	);
	get('get a label by id', `${P}/labels/{{lid}}`);
	get('get an unknown label by id', `${P}/labels/99999999`);
	get('get an unknown label', `${P}/labels/conf-{{run}}-nope`);
	add('PUT a label by id', 'PUT', `${P}/labels/{{lid}}`, { description: 'by id' });
	add('PUT a label without parameter', 'PUT', `${P}/labels/{{lid}}`, {});
	add('PUT a label color only', 'PUT', `${P}/labels/{{lid}}`, { color: '#654321' });
	add('PUT a label with a bad color', 'PUT', `${P}/labels/{{lid}}`, { color: 'zzz' });
	add('PUT a label description null', 'PUT', `${P}/labels/{{lid}}`, { description: null });
	add('PUT an unknown label', 'PUT', `${P}/labels/conf-{{run}}-nope`, { description: 'x' });
	add('rename a label to an existing name', 'PUT', `${P}/labels/{{lid}}`, { new_name: 'conf-{{run}}-coll' });
	add('rename a label to its own name', 'PUT', `${P}/labels/{{lid}}`, { new_name: 'conf-{{run}}-byid' });
	add('rename a label to an empty name', 'PUT', `${P}/labels/{{lid}}`, { new_name: '' });
	add('rename a label to a name with a comma', 'PUT', `${P}/labels/{{lid}}`, { new_name: 'a,b' });
	add('rename a label to 256 characters', 'PUT', `${P}/labels/{{lid}}`, { new_name: RAW('n', 251, 'conf-') });
	add('rename a label with edge spaces', 'PUT', `${P}/labels/{{lid}}`, { new_name: ' conf-{{run}}-byid2 ' });
	add('delete a label by id', 'DELETE', `${P}/labels/{{lid}}`);
	add('delete a label by id again', 'DELETE', `${P}/labels/{{lid}}`);
	add('delete an unknown label', 'DELETE', `${P}/labels/conf-{{run}}-nope`);
	get('list labels with counts', `${P}/labels?search=conf-{{run}}-q&with_counts=true`);
	get('list labels without ancestor groups', `${P}/labels?search=conf-{{run}}-q&include_ancestor_groups=false`);
	get('list labels, second page of ten', `${P}/labels?search=conf-{{run}}-cn-&per_page=10&page=2`);
	get('list labels, search in upper case', `${P}/labels?search=CONF-{{run}}-CN-BLUE`);
	get('list labels with a bad per_page', `${P}/labels?per_page=0`);

	// ---- group 11: links (findings: Links). Needs the Q issue (pid), L1..L3, U2, H (deleted).
	get('list with the numeric project id', 'projects/{{pid}}/issues?per_page=1');
	add(
		'link with the numeric project id',
		'POST',
		`${I('l1')}/links`,
		{ target_project_id: '{{pid:n}}', target_issue_iid: '{{l2:n}}' },
		{ step: { save: { lk2: 'id' } } }
	);
	add('link with an encoded project path', 'POST', `${I('l1')}/links`, {
		target_project_id: '{{P}}',
		target_issue_iid: '{{l3:n}}',
	});
	add('link to a closed issue', 'POST', `${I('l1')}/links`, {
		target_project_id: '{{projectPath}}',
		target_issue_iid: '{{l3:n}}',
	});
	add('link with an explicit relates_to', 'POST', `${I('l2')}/links`, {
		target_project_id: '{{projectPath}}',
		target_issue_iid: '{{l3:n}}',
		link_type: 'relates_to',
	});
	add('link with a non numeric target iid', 'POST', `${I('l2')}/links`, {
		target_project_id: '{{projectPath}}',
		target_issue_iid: 'abc',
	});
	add('link to a deleted issue', 'POST', `${I('l2')}/links`, {
		target_project_id: '{{projectPath}}',
		target_issue_iid: '{{h:n}}',
	});
	get('links of an issue without links', `${I('u2')}/links`);
	get('links of an unknown issue', `${P}/issues/99999/links`);
	add('delete an unknown link', 'DELETE', `${I('l1')}/links/99999999`);
	add('delete a link through an issue that is not part of it', 'DELETE', `${I('u2')}/links/{{lk2}}`);
	add('delete the link from the other end', 'DELETE', `${I('l2')}/links/{{lk2}}`);
	get('notes of L2 after the unlink', `${I('l2')}/notes?sort=asc`);

	// ---- group 12: GraphQL work items (findings: Hierarchy, Type conversion). Needs A (issue), B (incident), C (task), F.
	const WIDGET_TYPES =
		'query($id: WorkItemID!) { workItem(id: $id) { id iid workItemType { name } widgets { type } } }';
	const SCALARS =
		'query($id: WorkItemID!) { workItem(id: $id) { id iid title state confidential webUrl createdAt updatedAt closedAt workItemType { id name } } }';
	gqlQuery('widget types of an Issue', WIDGET_TYPES, { id: gid('aid') });
	gqlQuery('widget types of an Incident', WIDGET_TYPES, { id: gid('bid') });
	gqlQuery('widget types of a Task', WIDGET_TYPES, { id: gid('cid') });
	add('read B hierarchy', 'POST', 'graphql', gqlRead('bid'));
	gqlQuery('scalar fields of a work item', SCALARS, { id: gid('fid') });
	gqlQuery(
		'batched reads with aliases',
		'query($a: WorkItemID!, $b: WorkItemID!) { first: workItem(id: $a) { iid } second: workItem(id: $b) { iid } }',
		{ a: gid('aid'), b: gid('bid') }
	);
	gqlQuery(
		'fragments and directives',
		'query($id: WorkItemID!, $with: Boolean!) { workItem(id: $id) { ...Basics @include(if: $with) other: title @skip(if: $with) } } fragment Basics on WorkItem { iid title }',
		{ id: gid('aid'), with: true }
	);
	gqlQuery('read an unknown work item', GQL_READ, { id: 'gid://gitlab/WorkItem/1' });
	gqlQuery('read a malformed global id', GQL_READ, { id: 'x' });
	gqlQuery(
		'project and namespace without permission',
		'{ project(fullPath: "{{projectPath}}") { id } namespace(fullPath: "{{group}}") { id } }'
	);
	gqlQuery('graphql selecting __typename', '{ __typename }');
	add('graphql without a query', 'POST', 'graphql', {});
	add('graphql with an empty query', 'POST', 'graphql', { query: '' });
	add('graphql with two operations and no name', 'POST', 'graphql', {
		query: 'query One { __typename } query Two { __typename }',
	});
	add('graphql with an unknown operation name', 'POST', 'graphql', {
		query: 'query One { __typename }',
		operationName: 'Nope',
	});
	gqlQuery('graphql selection on a scalar', '{ workItem(id: "gid://gitlab/WorkItem/1") { iid { x } } }');
	gqlQuery('graphql missing selection', '{ workItem(id: "gid://gitlab/WorkItem/1") }');
	gqlQuery('graphql missing argument', '{ workItem { iid } }');
	gqlQuery('graphql unknown argument', '{ workItem(id: "gid://gitlab/WorkItem/1", bogus: 1) { iid } }');
	gqlQuery('graphql unknown field with a suggestion', '{ workItem(id: "gid://gitlab/WorkItem/1") { titl } }');
	gqlQuery('graphql unknown field without a suggestion', '{ workItem(id: "gid://gitlab/WorkItem/1") { zzzzzzzz } }');
	gqlQuery('graphql undefined fragment', '{ workItem(id: "gid://gitlab/WorkItem/1") { ...Missing } }');
	gqlQuery('graphql unknown fragment type', '{ workItem(id: "gid://gitlab/WorkItem/1") { ... on Nope { iid } } }');
	gqlQuery('graphql unterminated string', '{ workItem(id: "gid://gitlab/WorkItem/1) { iid } }');
	add('graphql variable missing', 'POST', 'graphql', { query: GQL_READ });
	gqlQuery('graphql variable null', GQL_READ, { id: null });
	gqlQuery('graphql variable of the wrong type', GQL_READ, { id: 5 });

	// Hierarchy rules beyond the first ones: replace, remove, the notes they write, deletion of a parent. HT task, HI and HJ issues.
	add(
		'create hierarchy task',
		'POST',
		ISSUES,
		{ title: T('HT'), issue_type: 'task' },
		created({ ht: 'iid', htid: 'id' }, 'ht')
	);
	add('create hierarchy issue 1', 'POST', ISSUES, { title: T('HI') }, created({ hi: 'iid', hiid: 'id' }, 'hi'));
	add('create hierarchy issue 2', 'POST', ISSUES, { title: T('HJ') }, created({ hj: 'iid', hjid: 'id' }, 'hj'));
	add('HT under HI', 'POST', 'graphql', gqlParent('htid', 'hiid'));
	add('HT under HJ (replace the parent)', 'POST', 'graphql', gqlParent('htid', 'hjid'));
	get('notes of HI after the replace', `${I('hi')}/notes?sort=asc`);
	get('notes of HJ after the replace', `${I('hj')}/notes?sort=asc`);
	get('notes of HT after the replace', `${I('ht')}/notes?sort=asc`);
	add('read HJ children', 'POST', 'graphql', gqlRead('hjid'));
	add('HT without parent', 'POST', 'graphql', gqlParent('htid', null));
	get('notes of HJ after the removal', `${I('hj')}/notes?sort=asc`);
	get('notes of HT after the removal', `${I('ht')}/notes?sort=asc`);
	add('HT under HI again', 'POST', 'graphql', gqlParent('htid', 'hiid'));
	add('convert HI (with a child) to task', 'POST', 'graphql', gqlConvert('hiid', 5));
	add('convert HT (a child) to issue', 'POST', 'graphql', gqlConvert('htid', 1));
	add('convert HT to its own type', 'POST', 'graphql', gqlConvert('htid', 5));
	add('task C under an unknown parent', 'POST', 'graphql', {
		query: GQL_SET_PARENT,
		variables: { input: { id: gid('cid'), hierarchyWidget: { parentId: 'gid://gitlab/WorkItem/1' } } },
	});
	add('workItemUpdate with a malformed id', 'POST', 'graphql', {
		query: GQL_SET_PARENT,
		variables: { input: { id: 'x', hierarchyWidget: { parentId: null } } },
	});
	add('workItemUpdate with a malformed parent id', 'POST', 'graphql', {
		query: GQL_SET_PARENT,
		variables: { input: { id: gid('cid'), hierarchyWidget: { parentId: 'x' } } },
	});
	add('workItemUpdate without hierarchyWidget', 'POST', 'graphql', {
		query: GQL_SET_PARENT,
		variables: { input: { id: gid('cid') } },
	});
	add('workItemUpdate with an unknown input field', 'POST', 'graphql', {
		query: GQL_SET_PARENT,
		variables: { input: { id: gid('cid'), bogus: 1 } },
	});
	add('workItemUpdate without an id', 'POST', 'graphql', { query: GQL_SET_PARENT, variables: { input: {} } });
	// Conversions on CX (a task) and the effect on updated_at, read through the order of CX and CY.
	add('create CX', 'POST', ISSUES, { title: T('CX'), issue_type: 'task' }, created({ cx: 'iid', cxid: 'id' }, 'cx'));
	add('create CY', 'POST', ISSUES, { title: T('CY') }, created({ cy: 'iid' }, 'cy'));
	add('convert CX to issue', 'POST', 'graphql', gqlConvert('cxid', 1));
	get('notes of CX after the convert', `${I('cx')}/notes?sort=asc`);
	get('updated order after the convert', `${ISSUES}?iids[]={{cx}}&iids[]={{cy}}&order_by=updated_at&sort=desc`);
	add('convert CX to incident', 'POST', 'graphql', gqlConvert('cxid', 2));
	add('convert CX to task', 'POST', 'graphql', gqlConvert('cxid', 5));
	for (const typeId of [4, 6, 7, 8, 99])
		add(`convert CX to the work item type ${typeId}`, 'POST', 'graphql', gqlConvert('cxid', typeId));
	add('convert with a malformed type id', 'POST', 'graphql', {
		query: GQL_CONVERT,
		variables: { input: { id: gid('cxid'), workItemTypeId: 'x' } },
	});
	add('convert without a type id', 'POST', 'graphql', {
		query: GQL_CONVERT,
		variables: { input: { id: gid('cxid') } },
	});
	get('CX after the conversions', I('cx'));

	// ---- group 13: deletion (findings: Delete). DC is the newest issue when it goes; DP and DK are a parent and its child.
	add('create DC', 'POST', ISSUES, { title: T('DC') }, created({ dc: 'iid' }));
	add('link DC to U2', 'POST', `${I('dc')}/links`, {
		target_project_id: '{{projectPath}}',
		target_issue_iid: '{{u2:n}}',
	});
	add('close DC', 'PUT', I('dc'), { state_event: 'close' });
	add('delete a closed issue with a link', 'DELETE', I('dc'));
	get('links of U2 after the deletion', `${I('u2')}/links`);
	get('notes of U2 after the deletion', `${I('u2')}/notes?sort=asc`);
	add('create after the deletion', 'POST', ISSUES, { title: T('DN') }, created({ dn: 'iid' }, 'dn'));
	get('list the deleted newest iid', `${ISSUES}?iids[]={{dc}}&state=all`);
	add('create DP', 'POST', ISSUES, { title: T('DP') }, created({ dp: 'iid', dpid: 'id' }));
	add('create DK', 'POST', ISSUES, { title: T('DK'), issue_type: 'task' }, created({ dk: 'iid', dkid: 'id' }, 'dk'));
	add('DK under DP', 'POST', 'graphql', gqlParent('dkid', 'dpid'));
	add('delete a parent', 'DELETE', I('dp'));
	add('read DK after its parent was deleted', 'POST', 'graphql', gqlRead('dkid'));
	get('notes of DK after its parent was deleted', `${I('dk')}/notes?sort=asc`);
}

// ================================================================================================================================
// The TAIL: steps appended after the first recording (phase 2) to settle what that recording left open. They need nothing from the
// steps above (each makes its own issues), so the tail can be run and recorded alone and merged into the fixture.
//   - tail 1: a native task shows in the unfiltered list of the project;
//   - tail 2: does a PUT of the SAME title move updated_at on an issue nobody wrote a note on (the first recording saw it move right
//     after a note, which could be the note's own delayed effect);
//   - tail 3: the instants of the events of one answer (the harness keeps the relation between them: same / later / earlier), for one
//     PUT that swaps a label and closes, then one that swaps back.
// ================================================================================================================================
function addTailSteps({ add, created, made }) {
	const ISSUES = `${P}/issues`;
	const get = (name, p) => add(name, 'GET', p);

	// ---- tail 1
	add(
		'create tail task',
		'POST',
		ISSUES,
		{ title: T('tail task'), issue_type: 'task' },
		created({ tt: 'iid' }, 'tt')
	);
	add('create tail issue', 'POST', ISSUES, { title: T('tail issue') }, created({ ti: 'iid' }, 'ti'));
	get('list a task and an issue together', `${ISSUES}?iids[]={{tt}}&iids[]={{ti}}&state=opened`);

	// ---- tail 2
	const ORD = `${ISSUES}?iids[]={{v1}}&iids[]={{v2}}&order_by=updated_at&sort=desc`;
	add('create V1', 'POST', ISSUES, { title: T('V1') }, created({ v1: 'iid' }, 'v1'));
	add('create V2', 'POST', ISSUES, { title: T('V2') }, created({ v2: 'iid' }, 'v2'));
	get('updated order at the start of the fresh pair', ORD);
	add('PUT the same title on V1 (fresh)', 'PUT', I('v1'), { title: T('V1') });
	get('updated order after the same title on a fresh issue', ORD);

	// ---- tail 3
	add(
		'create S with a label',
		'POST',
		ISSUES,
		{ title: T('S swap'), labels: 'conf-{{run}}-s1' },
		made({ s: 'iid' }, 's', ['conf-{{run}}-s1', 'conf-{{run}}-s2'])
	);
	add('PUT swap S labels and close', 'PUT', I('s'), { labels: 'conf-{{run}}-s2', state_event: 'close' });
	add('PUT swap S labels back', 'PUT', I('s'), { labels: 'conf-{{run}}-s1' });
	get('label events of S', `${I('s')}/resource_label_events`);
	get('state events of S', `${I('s')}/resource_state_events`);
}

// ================================================================================================================================
// TAIL 2: the first PUT of an issue moves updated_at even with nothing changed (tail 1 saw it), and the LATER no-op PUTs do not
// (same title, description null on null, labels "" on none, reopen on an open issue). Read through the order of two issues, the
// older one being W (start the recording at the step "create W").
// ================================================================================================================================
function addTailSteps2({ add, created }) {
	const ISSUES = `${P}/issues`;
	const ORD = `${ISSUES}?iids[]={{w}}&iids[]={{wx}}&order_by=updated_at&sort=desc`;
	const order = name => add(name, 'GET', ORD);
	add('create W', 'POST', ISSUES, { title: T('W') }, created({ w: 'iid' }, 'w'));
	add('create WX', 'POST', ISSUES, { title: T('WX') }, created({ wx: 'iid' }, 'wx'));
	order('updated order of W and WX at the start');
	add('PUT the same title on W (first)', 'PUT', I('w'), { title: T('W') });
	order('updated order after the first PUT of W');
	add('bump WX', 'PUT', I('wx'), { title: T('WX bumped') });
	order('updated order after bumping WX');
	add('PUT the same title on W (second)', 'PUT', I('w'), { title: T('W') });
	order('updated order after the second PUT of W');
	add('PUT description null on W', 'PUT', I('w'), { description: null });
	order('updated order after description null on W');
	add('PUT labels empty on W', 'PUT', I('w'), { labels: '' });
	order('updated order after labels empty on W');
	add('PUT reopen on W (open)', 'PUT', I('w'), { state_event: 'reopen' });
	order('updated order after reopen on an open W');
	add('PUT the same title on W (third)', 'PUT', I('w'), { title: T('W') });
	order('updated order after the third PUT of W');
}
