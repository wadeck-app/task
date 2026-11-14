// The scripted scenario that `live-github-probe.mjs scenario --record <file>` runs against the REAL api.github.com repository and stores
// as the conformance fixture (packages/task-service/src/plugins/github/fixtures/live-conformance.json). The unit test replays the SAME
// requests against the local fake (fakeGitHub.testkit.ts) and requires the same status, key headers and (sanitized) body. Needs
// `npm run build` (the sanitizer is the compiled githubConformance.testkit.js). Every title is prefixed "[task-api-test]".
//
// Pace: the recorder spaces writes by at least 1.5 s (GitHub asks integrators to go slowly, and the instants it compares have a
// resolution of one second). A step with `wait` sleeps first (the issue list lags a creation by about 4 s, the search index by about
// 7 s, the dependency counts by 1 to 2 s). The group names below are the `area` of the ledger (fakeGitHubLedger.testkit.ts): every
// step named in its `evidence` must exist here, and the fixture must hold it.
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const kitUrl = process.env.GH_CONFORMANCE_KIT
	? pathToFileURL(process.env.GH_CONFORMANCE_KIT).href
	: pathToFileURL(path.join(root, 'packages/task-service/dist/plugins/github/githubConformance.testkit.js')).href;

const T = suffix => `[task-api-test] conf {{run}} ${suffix}`;
const L = suffix => `conf-{{run}}-${suffix}`;
const R = 'repos/{{repo}}';
const I = v => `${R}/issues/{{${v}}}`;
const RAW = (unit, count, prefix) => ({ $repeat: prefix === undefined ? [unit, count] : [unit, count, prefix] });
const PREFIX = '[task-api-test] ';
// A search query for a URL: the placeholders ({{repo}}) must survive, so only spaces and quotes are encoded.
const Q = text => text.replace(/ /g, '%20').replace(/"/g, '%22');
const DELETE_ISSUE = 'mutation($id: ID!) { deleteIssue(input: {issueId: $id}) { clientMutationId } }';

/**
 * The steps. A step may carry `track` (the name of a variable holding an issue number to close at the end); it is removed from the
 * fixture. Options of `add`: save, saveHeaders, saveLinks, wait, ignoreKeys, subset (kept in the fixture), track, auth, headers,
 * rawBody (the request).
 */
export function steps() {
	const s = [];
	const add = (name, method, p, body, o = {}) => {
		const request = { method, path: p };
		if (body !== undefined) request.body = body;
		if (o.auth !== undefined) request.auth = o.auth;
		if (o.headers !== undefined) request.headers = o.headers;
		if (o.rawBody !== undefined) request.rawBody = o.rawBody;
		const step = { name, request };
		for (const key of ['save', 'saveHeaders', 'saveLinks', 'wait', 'ignoreKeys', 'subset', 'track'])
			if (o[key] !== undefined) step[key] = o[key];
		s.push(step);
	};
	const get = (name, p, o) => add(name, 'GET', p, undefined, o);
	// A step that creates an issue to close at the end; saves its number, id and node id under `v`, `v`id, `v`node.
	const mk = (name, v, body) =>
		add(name, 'POST', `${R}/issues`, body, {
			save: { [v]: 'number', [`${v}id`]: 'id', [`${v}node`]: 'node_id' },
			track: v,
		});

	// ================================ group: credentials
	get('bad token', `${R}/issues?labels=${L('none')}`, { auth: 'bad' });
	get('no token', `${R}/issues?labels=${L('none')}`, { auth: 'none' });
	get('unknown repository', 'repos/{{repo}}-nope/issues');
	get('unknown route', `${R}/nothing-here`);
	get('repository name in upper case', `repos/{{repoU}}/issues?labels=${L('none')}`);
	get('GET user', 'user', { subset: true });
	get('GET repository', R, { subset: true });
	get('GET rate_limit', 'rate_limit', { subset: true });
	add('invalid json', 'POST', `${R}/issues`, undefined, {
		rawBody: '{nope',
		headers: { 'content-type': 'application/json' },
	});

	// ================================ group: repository labels
	add('create label', 'POST', `${R}/labels`, { name: L('lab'), color: 'ff0000', description: 'a description' });
	add('create label without color', 'POST', `${R}/labels`, { name: L('lab2') });
	add('create label again', 'POST', `${R}/labels`, { name: L('lab'), color: '00ff00' });
	add('create label in other case', 'POST', `${R}/labels`, { name: L('LAB'), color: '00ff00' });
	add('create label of 51 characters', 'POST', `${R}/labels`, { name: RAW('l', 51 - 0) });
	add('create label with an empty name', 'POST', `${R}/labels`, { name: '' });
	add('create label without name', 'POST', `${R}/labels`, { color: 'ff0000' });
	add('create label with a comma', 'POST', `${R}/labels`, { name: L('a,b') });
	add('create label with a bad color', 'POST', `${R}/labels`, { name: L('badcolor'), color: 'red' });
	add('create label with a long description', 'POST', `${R}/labels`, {
		name: L('longdesc'),
		description: RAW('d', 101),
	});
	add('create label with a leading space', 'POST', `${R}/labels`, { name: ` ${L('lead')}` });
	add('create label with colons', 'POST', `${R}/labels`, { name: `conf-{{run}}::scope:x`, color: '0000ff' });
	get('get label', `${R}/labels/${L('lab')}`);
	get('get label in other case', `${R}/labels/${L('LAB')}`);
	get('get label with a colon', `${R}/labels/conf-{{run}}%3A%3Ascope%3Ax`);
	get('get unknown label', `${R}/labels/${L('never')}`);
	add('delete label', 'DELETE', `${R}/labels/${L('lab2')}`);
	add('delete a deleted label', 'DELETE', `${R}/labels/${L('lab2')}`);

	// ================================ group: create
	add(
		'create A',
		'POST',
		`${R}/issues`,
		{ title: T('A'), body: 'first\r\nline  ', labels: [L('x'), L('y')] },
		{ save: { a: 'number', aid: 'id', anode: 'node_id' }, track: 'a' }
	);
	get('get A', I('a'), { saveHeaders: { etag: 'etag' } });
	get('get A with its etag', I('a'), { headers: { 'if-none-match': '{{etag}}' } });
	get('get A with another etag', I('a'), {
		headers: { 'if-none-match': '"0000000000000000000000000000000000000000"' },
	});
	get('get an unknown number', `${R}/issues/99999999`);
	get('get a non numeric number', `${R}/issues/abc`);
	mk('create S', 's', { title: T('S') });
	mk('create F (state ignored)', 'f', { title: T('F'), state: 'closed', state_reason: 'not_planned' });
	mk('create with a native type', 'tb', { title: T('B'), type: 'Bug' });
	add('create with an unknown native type', 'POST', `${R}/issues`, { title: T('bogus type'), type: 'NoSuchType' });
	add('create without title', 'POST', `${R}/issues`, { body: 'x' });
	add('create with an empty title', 'POST', `${R}/issues`, { title: '' });
	add('create with a blank title', 'POST', `${R}/issues`, { title: '   ' });
	mk('create with a title of 326 characters', 'lt', { title: RAW('t', 326 - PREFIX.length, PREFIX) });
	add('create with a body of 65537 characters', 'POST', `${R}/issues`, { title: T('big'), body: RAW('d', 65537) });
	add('create with labels as a string', 'POST', `${R}/issues`, { title: T('labels string'), labels: 'x' });
	add('create with a label of 60 characters', 'POST', `${R}/issues`, {
		title: T('long label'),
		labels: [RAW('l', 60)],
	});
	add('create with a label with a comma', 'POST', `${R}/issues`, { title: T('comma label'), labels: ['a,b'] });
	mk('create with duplicate labels', 'dl', { title: T('dup'), labels: [L('dup'), L('dup'), L('DUP')] });
	mk('create with label objects', 'lo', { title: T('objects'), labels: [{ name: L('obj') }] });
	mk('create with a label with a leading space', 'ls', { title: T('lead'), labels: [` ${L('sp')}`] });

	// ================================ group: update
	add('PATCH title', 'PATCH', I('a'), { title: T('A renamed') });
	add('PATCH an empty title', 'PATCH', I('a'), { title: '' });
	add('PATCH the same title', 'PATCH', I('s'), { title: T('S') });
	add('PATCH nothing', 'PATCH', I('s'), {});
	add('PATCH an unknown parameter', 'PATCH', I('s'), { bogus: 1 });
	add('PATCH body', 'PATCH', I('a'), { body: 'second' });
	add('PATCH body with CRLF', 'PATCH', I('a'), { body: 'a\r\nb  \r\n' });
	add('PATCH body null', 'PATCH', I('a'), { body: null });
	add('PATCH body of 65536 characters', 'PATCH', I('a'), { body: RAW('d', 65536) });
	add('PATCH body of 65537 characters', 'PATCH', I('a'), { body: RAW('d', 65537) });
	add('PATCH state closed', 'PATCH', I('a'), { state: 'closed' });
	add('PATCH state closed again', 'PATCH', I('a'), { state: 'closed' });
	add('PATCH closed with a reason', 'PATCH', I('a'), { state: 'closed', state_reason: 'not_planned' });
	add('PATCH a reason alone on a closed issue', 'PATCH', I('a'), { state_reason: 'completed' });
	add('PATCH state open', 'PATCH', I('a'), { state: 'open' });
	add('PATCH state open again', 'PATCH', I('a'), { state: 'open' });
	add('PATCH state with a bad value', 'PATCH', I('a'), { state: 'bogus' });
	add('PATCH state_reason with a bad value', 'PATCH', I('a'), { state: 'closed', state_reason: 'bogus' });
	add('PATCH close as duplicate', 'PATCH', I('s'), {
		state: 'closed',
		state_reason: 'duplicate',
		duplicate_issue_id: '{{aid:n}}',
	});
	add('PATCH duplicate of an unknown issue', 'PATCH', I('f'), {
		state: 'closed',
		state_reason: 'duplicate',
		duplicate_issue_id: 900000000000,
	});
	add('PATCH labels', 'PATCH', I('a'), { labels: [L('c'), L('d')] });
	add('PATCH the same labels', 'PATCH', I('a'), { labels: [L('c'), L('d')] });
	add('PATCH labels with a comma', 'PATCH', I('a'), { labels: ['a,b'] });
	add('PATCH labels as a string', 'PATCH', I('a'), { labels: 'x' });
	add('PATCH labels empty', 'PATCH', I('a'), { labels: [] });
	mk('create CB', 'cb', { title: T('CB'), labels: [L('cbx')] });
	add('PATCH state, labels and title in one request', 'PATCH', I('cb'), {
		state: 'closed',
		state_reason: 'not_planned',
		labels: [L('e')],
		title: T('CB swap'),
	});
	add('PATCH state open and labels', 'PATCH', I('cb'), { state: 'open', labels: [L('f')] });
	add('PATCH labels with duplicates', 'PATCH', I('a'), { labels: [L('dd'), L('DD')] });
	add('PATCH type', 'PATCH', I('a'), { type: 'Task' });
	add('PATCH type to another', 'PATCH', I('a'), { type: 'Bug' });
	add('PATCH type null', 'PATCH', I('a'), { type: null });
	add('PATCH an unknown type', 'PATCH', I('a'), { type: 'NoSuchType' });
	add('PATCH an unknown issue', 'PATCH', `${R}/issues/99999999`, { title: 'x' });
	add('PATCH with If-Match', 'PATCH', I('a'), { title: T('x1') }, { headers: { 'if-match': '"abc"' } });
	get('GET A after If-Match', I('a'));
	add(
		'PATCH with If-Unmodified-Since',
		'PATCH',
		I('a'),
		{ title: T('x2') },
		{
			headers: { 'if-unmodified-since': 'Wed, 21 Oct 2026 07:28:00 GMT' },
		}
	);
	get('GET A after If-Unmodified-Since', I('a'));
	add('PATCH with If-None-Match star', 'PATCH', I('a'), { title: T('x3') }, { headers: { 'if-none-match': '*' } });
	get('GET A after If-None-Match star', I('a'));
	add('POST to the issue', 'POST', I('a'), { title: 'x' });
	add('DELETE the issue over REST', 'DELETE', I('f'));

	// ================================ group: issue labels
	add('POST labels', 'POST', `${I('a')}/labels`, { labels: [L('n1'), L('n2')] });
	add('POST labels already there', 'POST', `${I('a')}/labels`, { labels: [L('n1'), L('N2')] });
	add('POST label objects', 'POST', `${I('a')}/labels`, { labels: [{ name: L('n3') }] });
	add('POST labels with duplicates', 'POST', `${I('a')}/labels`, { labels: [L('bd'), L('BD')] });
	add('POST labels with a comma', 'POST', `${I('a')}/labels`, { labels: ['a,b'] });
	add('POST labels as a string', 'POST', `${I('a')}/labels`, { labels: 'x' });
	add('POST labels empty', 'POST', `${I('a')}/labels`, { labels: [] });
	add('POST labels of 60 characters', 'POST', `${I('a')}/labels`, { labels: [RAW('l', 60)] });
	add('PUT labels', 'PUT', `${I('a')}/labels`, { labels: [L('p1'), L('p2')] });
	add('PUT labels with duplicates', 'PUT', `${I('a')}/labels`, { labels: [L('pd'), L('PD')] });
	add('PUT labels with a comma', 'PUT', `${I('a')}/labels`, { labels: ['a,b'] });
	add('DELETE a label of the issue', 'DELETE', `${I('a')}/labels/${L('p1')}`);
	add('DELETE a label of the issue in other case', 'DELETE', `${I('a')}/labels/${L('P2')}`);
	add('DELETE an absent label of the issue', 'DELETE', `${I('a')}/labels/${L('p1')}`);
	add('DELETE a label with a colon', 'POST', `${I('a')}/labels`, { labels: [`conf-{{run}}::c:d`] });
	add('DELETE the colon label', 'DELETE', `${I('a')}/labels/conf-{{run}}%3A%3Ac%3Ad`);
	add('POST labels on an unknown issue', 'POST', `${R}/issues/99999999/labels`, { labels: ['x'] });
	add('DELETE all labels of the issue', 'DELETE', `${I('a')}/labels`);

	// ================================ group: comments
	add('POST comment', 'POST', `${I('a')}/comments`, { body: 'hello **comment**' }, { save: { c1: 'id' } });
	add('POST comment with CRLF', 'POST', `${I('a')}/comments`, { body: 'a\r\nb  \r\n' }, { save: { c2: 'id' } });
	add('POST second comment', 'POST', `${I('a')}/comments`, { body: 'third' }, { save: { c3: 'id' } });
	add('POST comment with an empty body', 'POST', `${I('a')}/comments`, { body: '' });
	add('POST comment without body', 'POST', `${I('a')}/comments`, {});
	add('POST comment on an unknown issue', 'POST', `${R}/issues/99999999/comments`, { body: 'x' });
	add('PATCH comment', 'PATCH', `${R}/issues/comments/{{c1}}`, { body: 'edited' });
	add('PATCH comment with an empty body', 'PATCH', `${R}/issues/comments/{{c1}}`, { body: '' });
	add('PATCH an unknown comment', 'PATCH', `${R}/issues/comments/99999999`, { body: 'x' });
	add('DELETE comment', 'DELETE', `${R}/issues/comments/{{c2}}`);
	add('DELETE a deleted comment', 'DELETE', `${R}/issues/comments/{{c2}}`);
	get('GET comments of the issue', `${I('a')}/comments?per_page=100`);
	get('GET comments, page of 1', `${I('a')}/comments?per_page=1`, { saveLinks: { next: 'next' } });
	get('GET comments, next page', '{{next}}');
	get('GET comments of an unknown issue', `${R}/issues/99999999/comments`);
	get('GET the issue after the comments', I('a'));
	mk('create K (big comments)', 'k', { title: T('K') });
	add('POST comment of 65537 characters', 'POST', `${I('k')}/comments`, { body: RAW('c', 65537) });
	add('POST comment of 262144 characters', 'POST', `${I('k')}/comments`, { body: RAW('c', 262144) });
	add('POST comment of 1000000 characters', 'POST', `${I('k')}/comments`, { body: RAW('c', 1000000) });

	// ================================ group: sub-issues
	mk('create P', 'p', { title: T('P') });
	mk('create C1', 'c1x', { title: T('C1') });
	mk('create C2', 'c2x', { title: T('C2') });
	mk('create C3', 'c3x', { title: T('C3') });
	add(
		'POST sub-issue',
		'POST',
		`${I('p')}/sub_issues`,
		{ sub_issue_id: '{{c1xid:n}}' },
		{ ignoreKeys: ['sub_issues_summary', 'issue_dependencies_summary'] }
	);
	add('POST sub-issue again', 'POST', `${I('p')}/sub_issues`, { sub_issue_id: '{{c1xid:n}}' });
	add('POST sub-issue of another parent', 'POST', `${I('c2x')}/sub_issues`, { sub_issue_id: '{{c1xid:n}}' });
	add(
		'POST sub-issue with replace_parent',
		'POST',
		`${I('c2x')}/sub_issues`,
		{
			sub_issue_id: '{{c1xid:n}}',
			replace_parent: true,
		},
		{ ignoreKeys: ['sub_issues_summary', 'issue_dependencies_summary'] }
	);
	add('POST sub-issue to its own parent chain', 'POST', `${I('c1x')}/sub_issues`, { sub_issue_id: '{{c2xid:n}}' });
	add('POST sub-issue to itself', 'POST', `${I('p')}/sub_issues`, { sub_issue_id: '{{pid:n}}' });
	add('POST sub-issue with an unknown id', 'POST', `${I('p')}/sub_issues`, { sub_issue_id: 900000000000 });
	add('POST sub-issue under an unknown issue', 'POST', `${R}/issues/99999999/sub_issues`, {
		sub_issue_id: '{{c3xid:n}}',
	});
	add(
		'POST sub-issue P of C2',
		'POST',
		`${I('p')}/sub_issues`,
		{ sub_issue_id: '{{c2xid:n}}' },
		{ ignoreKeys: ['sub_issues_summary', 'issue_dependencies_summary'] }
	);
	add(
		'POST sub-issue C3 of C2',
		'POST',
		`${I('c2x')}/sub_issues`,
		{ sub_issue_id: '{{c3xid:n}}' },
		{ ignoreKeys: ['sub_issues_summary', 'issue_dependencies_summary'] }
	);
	get('GET parent of a child', `${I('c2x')}/parent`, {
		ignoreKeys: ['sub_issues_summary', 'issue_dependencies_summary'],
	});
	get('GET parent of a root', `${I('p')}/parent`);
	get('GET sub-issues', `${I('p')}/sub_issues`, { ignoreKeys: ['sub_issues_summary', 'issue_dependencies_summary'] });
	get('GET sub-issues of a leaf', `${I('c3x')}/sub_issues`);
	get('GET sub-issues of an unknown issue', `${R}/issues/99999999/sub_issues`);
	get('GET a child (parent_issue_url)', I('c3x'));
	add('PATCH close a child', 'PATCH', I('c3x'), { state: 'closed' });
	get('GET the parent after a child closed', I('c2x'), { wait: 5000 });
	add(
		'DELETE sub-issue',
		'DELETE',
		`${I('c2x')}/sub_issue`,
		{ sub_issue_id: '{{c3xid:n}}' },
		{ ignoreKeys: ['sub_issues_summary', 'issue_dependencies_summary'] }
	);
	add('DELETE a sub-issue that is not one', 'DELETE', `${I('c2x')}/sub_issue`, { sub_issue_id: '{{c3xid:n}}' });
	add('DELETE a sub-issue of an unknown id', 'DELETE', `${I('c2x')}/sub_issue`, { sub_issue_id: 900000000000 });
	get('timeline of the parent', `${I('p')}/timeline?per_page=100`);
	for (let i = 1; i <= 9; i += 1) mk(`create L${i}`, `l${i}`, { title: T(`L${i}`) });
	for (let i = 2; i <= 9; i += 1)
		add(
			`POST sub-issue L${i} under L${i - 1}`,
			'POST',
			`${I(`l${i - 1}`)}/sub_issues`,
			{ sub_issue_id: `{{l${i}id:n}}` },
			{ ignoreKeys: ['sub_issues_summary', 'issue_dependencies_summary'] }
		);

	// ================================ group: dependencies
	mk('create X', 'x', { title: T('X') });
	mk('create Y', 'y', { title: T('Y') });
	mk('create Z', 'z', { title: T('Z') });
	const lag = ['sub_issues_summary', 'issue_dependencies_summary'];
	add('POST blocked_by', 'POST', `${I('x')}/dependencies/blocked_by`, { issue_id: '{{yid:n}}' }, { ignoreKeys: lag });
	add('POST blocked_by again', 'POST', `${I('x')}/dependencies/blocked_by`, { issue_id: '{{yid:n}}' });
	add('POST blocked_by on itself', 'POST', `${I('x')}/dependencies/blocked_by`, { issue_id: '{{xid:n}}' });
	add('POST blocked_by cycle', 'POST', `${I('y')}/dependencies/blocked_by`, { issue_id: '{{xid:n}}' });
	add('POST blocked_by with an unknown id', 'POST', `${I('x')}/dependencies/blocked_by`, { issue_id: 900000000000 });
	add('POST blocked_by on an unknown issue', 'POST', `${R}/issues/99999999/dependencies/blocked_by`, {
		issue_id: '{{zid:n}}',
	});
	add(
		'POST second blocked_by',
		'POST',
		`${I('x')}/dependencies/blocked_by`,
		{ issue_id: '{{zid:n}}' },
		{ ignoreKeys: lag }
	);
	get('GET blocked_by', `${I('x')}/dependencies/blocked_by`, { ignoreKeys: lag });
	get('GET blocking', `${I('y')}/dependencies/blocking`, { ignoreKeys: lag });
	get('GET blocking of a free issue', `${I('x')}/dependencies/blocking`);
	get('GET blocked_by of an unknown issue', `${R}/issues/99999999/dependencies/blocked_by`);
	get('GET X after the dependencies', I('x'), { wait: 5000 });
	get('GET Y after the dependencies', I('y'));
	add('PATCH close a blocker', 'PATCH', I('y'), { state: 'closed' });
	get('GET X with a closed blocker', I('x'), { wait: 5000 });
	add('DELETE blocked_by', 'DELETE', `${I('x')}/dependencies/blocked_by/{{yid}}`, undefined, { ignoreKeys: lag });
	add('DELETE blocked_by again', 'DELETE', `${I('x')}/dependencies/blocked_by/{{yid}}`, undefined, {
		ignoreKeys: lag,
	});
	add('DELETE blocked_by of an unknown id', 'DELETE', `${I('x')}/dependencies/blocked_by/900000000000`);
	get('timeline of X', `${I('x')}/timeline?per_page=100`, { wait: 3000 });

	// ================================ group: timeline and events
	get('timeline of A', `${I('a')}/timeline?per_page=100`);
	get('events of A', `${I('a')}/events?per_page=100`);
	get('timeline of A, page of 3', `${I('a')}/timeline?per_page=3`, { saveLinks: { tnext: 'next' } });
	get('timeline of A, next page', '{{tnext}}');
	get('events of S (duplicate close)', `${I('s')}/events?per_page=100`);
	get('timeline of S', `${I('s')}/timeline?per_page=100`);
	get('timeline of an issue created with a type', `${I('tb')}/timeline?per_page=100`);
	get('timeline of an unknown issue', `${R}/issues/99999999/timeline`);
	get('events of an unknown issue', `${R}/issues/99999999/events`);
	get('GET the issue created with a type', I('tb'));

	// ================================ group: list and search (after the index has caught up)
	for (const [n, suffix] of [
		[1, 'one'],
		[2, 'two'],
		[3, 'three'],
		[4, 'four'],
		[5, 'five'],
	])
		mk(`create M${n}`, `m${n}`, { title: T(`list ${suffix}`), labels: [L('list')] });
	add('PATCH close M3', 'PATCH', I('m3'), { state: 'closed' });
	add('PATCH close M4 as not planned', 'PATCH', I('m4'), { state: 'closed', state_reason: 'not_planned' });
	get('list open', `${R}/issues?labels=${L('list')}`, { wait: 12000 });
	get('list all', `${R}/issues?labels=${L('list')}&state=all`);
	get('list closed', `${R}/issues?labels=${L('list')}&state=closed`);
	get('list ascending', `${R}/issues?labels=${L('list')}&state=all&sort=created&direction=asc`);
	get('list by update', `${R}/issues?labels=${L('list')}&state=all&sort=updated&direction=desc`);
	get('list with a label in other case', `${R}/issues?labels=${L('LIST')}&state=all`);
	get('list with two labels', `${R}/issues?labels=${L('list')},${L('never')}&state=all`);
	get('list with no match', `${R}/issues?labels=${L('never')}`);
	get('list with a bad state', `${R}/issues?labels=${L('list')}&state=bogus`);
	get('list with the etag', `${R}/issues?labels=${L('list')}&state=all`, { saveHeaders: { letag: 'etag' } });
	get('list with its etag', `${R}/issues?labels=${L('list')}&state=all`, {
		headers: { 'if-none-match': '{{letag}}' },
	});
	get('list, page of 2', `${R}/issues?labels=${L('list')}&state=all&per_page=2&sort=created&direction=asc`, {
		saveLinks: { lnext: 'next' },
	});
	get('list, second page', '{{lnext}}', { saveLinks: { lnext2: 'next' } });
	get('list, last page', '{{lnext2}}');
	get(
		'search by title',
		`search/issues?q=${Q('repo:{{repo}} is:issue in:title "conf {{run}} list"')}&sort=created&order=asc`
	);
	get(
		'search with a label and a state',
		`search/issues?q=${Q('repo:{{repo}} is:issue label:"conf-{{run}}-list" state:closed')}&sort=created&order=asc`
	);
	get(
		'search with words out of order',
		`search/issues?q=${Q('repo:{{repo}} is:issue in:title "list conf {{run}}"')}&sort=created&order=asc`
	);
	get(
		'search with part of a word',
		`search/issues?q=${Q('repo:{{repo}} is:issue in:title "conf {{run}} lis"')}&sort=created&order=asc`
	);
	get('search with no match', `search/issues?q=${Q('repo:{{repo}} is:issue in:title "conf {{run}} nomatch"')}`);
	get('search for pull requests', `search/issues?q=${Q('repo:{{repo}} is:pr in:title "conf {{run}} list"')}`);
	get('search without a query', 'search/issues?q=');
	get('search in another repository', `search/issues?q=${Q('repo:{{repo}}-nope is:issue')}`);

	// ================================ group: graphql
	mk('create DD', 'dd', { title: T('DD'), labels: [L('list')] });
	add('GraphQL deleteIssue', 'POST', 'graphql', { query: DELETE_ISSUE, variables: { id: '{{ddnode}}' } });
	get('GET a deleted issue', I('dd'));
	add('PATCH a deleted issue', 'PATCH', I('dd'), { title: 'x' });
	add('POST comment on a deleted issue', 'POST', `${I('dd')}/comments`, { body: 'x' });
	get('timeline of a deleted issue', `${I('dd')}/timeline`);
	get('list after a deletion', `${R}/issues?labels=${L('list')}&state=all&per_page=100`);
	add('GraphQL deleteIssue again', 'POST', 'graphql', { query: DELETE_ISSUE, variables: { id: '{{ddnode}}' } });
	add('GraphQL deleteIssue of an unknown node', 'POST', 'graphql', {
		query: DELETE_ISSUE,
		variables: { id: 'I_kwDOunknown' },
	});
	add(
		'GraphQL without a token',
		'POST',
		'graphql',
		{ query: DELETE_ISSUE, variables: { id: 'x' } },
		{ auth: 'none' }
	);

	// ================================ group: bulk labels (a POST that creates many labels is a gateway timeout)
	mk('create G (50 new labels)', 'g', { title: T('G') });
	add('POST 50 new labels', 'POST', `${I('g')}/labels`, {
		labels: Array.from({ length: 50 }, (_, i) => `conf-{{run}}-bulk${i}`),
	});
	get('GET G after 50 new labels', `${I('g')}/timeline?per_page=100`, { wait: 3000 });
	mk('create H (100 new labels)', 'h', { title: T('H') });
	add('POST 100 new labels', 'POST', `${I('h')}/labels`, {
		labels: Array.from({ length: 100 }, (_, i) => `conf-{{run}}-huge${i}`),
	});
	get('GET H after 100 new labels', `${I('h')}/labels`, { wait: 3000 });
	return s;
}

/** The recorder: runs every step through `call` (the throttled client of the probe) and returns the fixture. */
export async function runScenario({ call, repo, run, apiBase, track, source }) {
	const kit = await import(kitUrl);
	const ctx = { run, apiBase };
	const vars = kit.scenarioVariables(repo, run);
	const out = [];
	const base = new Date().toISOString().slice(0, 10);
	// GH_SCENARIO_FROM=<step name> records only the tail of the scenario starting at that step (a few steps added later).
	const all = steps();
	const from = process.env.GH_SCENARIO_FROM;
	const start = from === undefined || from === '' ? 0 : all.findIndex(candidate => candidate.name === from);
	if (start < 0) throw new Error(`GH_SCENARIO_FROM: no scenario step is named "${from}"`);
	for (const step of all.slice(start)) {
		const request = JSON.parse(JSON.stringify(step.request));
		let route;
		let body;
		let headers;
		let rawBody;
		try {
			route = kit.substitute(request.path, vars);
			body = request.body === undefined ? undefined : kit.substitute(request.body, vars);
			headers = request.headers === undefined ? undefined : kit.substitute(request.headers, vars);
			rawBody = request.rawBody === undefined ? undefined : kit.substitute(request.rawBody, vars);
		} catch (error) {
			// A variable an earlier failed step should have saved: the step is skipped, loudly, and left out of the fixture.
			console.log(`  --- ${step.name} SKIPPED: ${error.message}`);
			continue;
		}
		const opts = { headers, rawBody };
		if (request.auth === 'none') opts.token = null;
		else if (request.auth === 'bad') opts.token = 'github_pat_xxxxxxxxxxxxxxxxxxxxxxxx';
		if (step.wait !== undefined) await new Promise(resolve => setTimeout(resolve, step.wait));
		const r = await call(`scenario: ${step.name}`, request.method, route, body, opts);
		const expect = kit.normalizeAnswer({ status: r.status, headers: r.headers, text: r.text, json: r.json }, ctx);
		const problems = [];
		if (r.status < 400) {
			for (const [name, dotted] of Object.entries(step.save ?? {})) {
				const found = kit.pick(r.json, dotted);
				if (found === undefined || found === null) problems.push(`save ${name}: nothing at ${dotted}`);
				else vars[name] = String(found);
			}
		}
		for (const [name, header] of Object.entries(step.saveHeaders ?? {})) {
			if (r.headers[header] === undefined) problems.push(`save ${name}: no ${header} header`);
			else vars[name] = r.headers[header];
		}
		for (const [name, rel] of Object.entries(step.saveLinks ?? {})) {
			const found = kit.linkOf(r.headers.link, rel);
			if (found === undefined) problems.push(`save ${name}: no Link with rel="${rel}"`);
			else vars[name] = found;
		}
		if (step.track !== undefined && vars[step.track] !== undefined) track.issues.add(Number(vars[step.track]));
		console.log(
			`  ${String(r.status).padStart(3)} ${String(r.ms).padStart(5)}ms ${step.name}${problems.length ? ` !! ${problems.join('; ')}` : ''}`
		);
		const { track: _track, ...kept } = step;
		void _track;
		out.push({ ...kept, expect });
	}
	return { format: 1, recordedAt: base, source, steps: out };
}
