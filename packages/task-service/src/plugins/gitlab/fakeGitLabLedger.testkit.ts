// The HYPOTHESIS LEDGER of the GitLab mock (fakeGitLab.testkit.ts + fakeGitLabGraphql.testkit.ts): one line per behaviour the mock
// implements, with how well it is known. The user's rule: "validate EVERY hypothesis of the mock against the real GitLab".
//
//   LIVE-VERIFIED        recorded on gitlab.com Free (2026-11-09). `evidence` names the exact steps of the conformance fixture
//                        (fixtures/live-conformance.json) that replay it. A line whose steps are not in the fixture FAILS the
//                        conformance test (drift guard): either the step was not recorded yet (the tail of the scenario) or it was
//                        renamed. A step only proves what the harness compares: status, key headers and the normalized body (ids and
//                        users are normalized; the instants of the EVENTS of one answer keep their relation: same / later / earlier).
//   DOCUMENTED-NOT-LIVE  a docs.gitlab.com page states it; `docs` is the page and `reason` says why no live probe is possible (a classic
//                        token, another role, an instance setting). Only reachable through an option of the mock that simulates that
//                        scenario (`classicToken`, `permissions`, `readOnlyToken`, `canDelete`, `issuesEnabled`, `accessLevel`...).
//   UNVERIFIABLE         cannot be probed on a Free project with the test token (`reason`): destructive on group data, a weaker token,
//                        another role, a quota to burn, a distance the harness does not keep. Where the mock would otherwise INVENT an
//                        answer it answers 501 `mock: not modelled: <what>` (header `x-mock-not-modelled: 1`) instead; the line says so.
//   ASSUMED              a guess nobody checked, allowed only while a live probe is pending (`probe`). There is none left: the test
//                        `no ledger entry is ASSUMED` keeps it that way.
//
// Count (fixture of 597 steps, 2026-11-09): 298 lines: 258 LIVE-VERIFIED, 13 DOCUMENTED-NOT-LIVE, 27 UNVERIFIABLE, 0 ASSUMED. The last
// LIVE-VERIFIED line (area "tail") names the steps of "TAIL 2" of the scenario (create W ...), not recorded yet: it fails the drift
// guard until the lead records them (GL_SCENARIO_FROM="create W").
//
// Conventions: `area` groups the lines; `behaviour` is one sentence naming the status code, the error text, the header or the rule as the
// mock implements it. `evidence` of a non LIVE-VERIFIED line may still name steps (the ones that show the shape).
// gitlabConformance.test.ts enforces: unique ids, every evidence step exists in the scenario, every LIVE-VERIFIED step exists in the
// fixture, no ASSUMED, DOCUMENTED-NOT-LIVE carries docs and reason, UNVERIFIABLE carries a reason.
// scripts/gitlab-ledger-md.mjs prints the table for the storage plan. Test-only: nothing in the shipped code imports this file.

export type LedgerStatus = 'LIVE-VERIFIED' | 'DOCUMENTED-NOT-LIVE' | 'UNVERIFIABLE' | 'ASSUMED';

export interface LedgerEntry {
	/** `L001`... stable once the ledger is final; unique. */
	id: string;
	area: string;
	behaviour: string;
	status: LedgerStatus;
	/** `YYYY-MM-DD` of the live run (LIVE-VERIFIED only). */
	date?: string;
	/** Exact step names (fixture and/or scenario). */
	evidence: string[];
	/** The documentation page (DOCUMENTED-NOT-LIVE). */
	docs?: string;
	/** Why it cannot be probed (DOCUMENTED-NOT-LIVE, UNVERIFIABLE). */
	reason?: string;
	/** The live request that settles it (ASSUMED; none is left). */
	probe?: string;
}

const LIVE_DATE = '2026-11-09';

let counter = 0;
const nextId = (): string => `L${String(++counter).padStart(3, '0')}`;

const live = (area: string, behaviour: string, ...evidence: string[]): LedgerEntry => ({
	id: nextId(),
	area,
	behaviour,
	status: 'LIVE-VERIFIED',
	date: LIVE_DATE,
	evidence,
});

const documented = (
	area: string,
	behaviour: string,
	docs: string,
	reason: string,
	...evidence: string[]
): LedgerEntry => ({ id: nextId(), area, behaviour, status: 'DOCUMENTED-NOT-LIVE', evidence, docs, reason });

const unverifiable = (area: string, behaviour: string, reason: string, ...evidence: string[]): LedgerEntry => ({
	id: nextId(),
	area,
	behaviour,
	status: 'UNVERIFIABLE',
	evidence,
	reason,
});

export const MOCK_LEDGER: readonly LedgerEntry[] = [
	// ---- auth
	live(
		'auth',
		'a bad token is 401 {"message":"401 Unauthorized"} with the unauthenticated quota (500 / throttle_unauthenticated_api)',
		'bad token'
	),
	live(
		'auth',
		'no token on a private project is 404 {"message":"404 Project Not Found"} (its existence is not revealed), unauthenticated quota',
		'no token on a private project'
	),
	live('auth', 'the Authorization: Bearer header works like PRIVATE-TOKEN', 'bearer token'),
	live(
		'auth',
		'no token on a known route that is not a project route (version, user) is 401 {"message":"401 Unauthorized"}; on an unknown route it is the route 404 {"error":"404 Not Found"}; both with the unauthenticated quota',
		'GET version without a token',
		'GET user without a token',
		'GET an unknown route without a token'
	),
	live('auth', 'a bad token on a route that is not a project route is 401 Unauthorized', 'GET user with a bad token'),
	unverifiable(
		'auth',
		'the token is read from PRIVATE-TOKEN or Authorization only: ?private_token= in the query is ignored (the mock answers as if no token was sent)',
		'the recorder would have to store the token in the request path of the fixture, which must never contain a credential'
	),
	live(
		'auth',
		'an invalid JSON body is 400 {"error":"Invalid JSON format"} before authentication and before the rate limit (no ratelimit header)',
		'invalid json'
	),
	live(
		'auth',
		'a content type other than JSON / form is 415 {"error":"The provided content-type \'text/plain\' is not supported."}',
		'unsupported content type'
	),
	unverifiable(
		'auth',
		'a non JSON body with no content-type at all answers 501 not modelled',
		"the recorder (fetch) always sends a content-type with a body, so GitLab's answer cannot be recorded"
	),
	// ---- headers
	live(
		'headers',
		'ratelimit-limit 100, ratelimit-name burst_traffic_per_user_free_plan, -observed, -remaining, -reset on every authenticated answer',
		'get A',
		'create A',
		'PUT title'
	),
	live(
		'headers',
		'the unauthenticated answers carry ratelimit-limit 500 and throttle_unauthenticated_api',
		'bad token',
		'no token on a private project'
	),
	live('headers', 'x-gitlab-meta {"correlation_id":..,"version":"1"} on every answer', 'get A', 'get an unknown iid'),
	live('headers', 'cache-control max-age=0, private, must-revalidate on a 200 / 201', 'get A', 'create A'),
	live(
		'headers',
		'cache-control no-store, private, max-age=0 on an error',
		'get an unknown iid',
		'create without title'
	),
	live('headers', 'cache-control no-cache on a 204 and on a 202', 'delete a note', 'note with a quick action only'),
	live(
		'headers',
		'a weak etag W/"<md5 of the body>" on every 200 / 201 JSON answer (also on the 200 of a PUT)',
		'get A',
		'PUT title',
		'create A'
	),
	live(
		'headers',
		'If-None-Match with the etag is 304 for a single issue and for a list; the 304 keeps the pagination headers and has no content-type',
		'get A again with its etag',
		'list an etag',
		'list with that etag'
	),
	live('headers', 'If-None-Match: * is NOT a match: a normal 200 with the body', 'get A with If-None-Match star'),
	live('headers', 'a stale etag in If-None-Match is a normal 200 with the new body', 'get A with a stale etag'),
	live('headers', 'If-Modified-Since is ignored (200, no last-modified header)', 'get A with If-Modified-Since'),
	live(
		'headers',
		'If-Match and If-Unmodified-Since on a PUT are ignored (200)',
		'PUT with a stale If-Match',
		'PUT with If-Unmodified-Since in the past'
	),
	live(
		'headers',
		'content-type application/json (GraphQL: application/json; charset=utf-8)',
		'get A',
		'read A hierarchy'
	),
	// ---- rate limit
	unverifiable(
		'rate limit',
		'with the rateLimit option, the 101st request of a 60 s fixed window is 429 text/plain "Rate limit exceeded; see https://docs.gitlab.com/user/gitlab_com/rate_limits/ for more details" with retry-after 2 and ratelimit-resettime',
		'observed once by the "ratelimit" section of scripts/live-gitlab-probe.mjs (storage plan 2.3.1, "Rate limit"); a fixture step cannot loop 100 requests and burning the quota would starve the other steps'
	),
	unverifiable(
		'rate limit',
		'retry-after is misleading: the window is still closed when it elapses, ratelimit-reset / -resettime is the truth',
		'same: needs an exhausted quota (section "ratelimit" of the discovery script)'
	),
	unverifiable(
		'rate limit',
		'ratelimit-observed grows by one per request and ratelimit-remaining falls by one',
		'the harness normalizes instants, so only their order can be compared: both are normalized to <n>, the replay cannot compare the arithmetic'
	),
	unverifiable(
		'rate limit',
		'without the rateLimit option nothing is refused (headers only)',
		'test tooling: a mock option, not a GitLab behaviour'
	),
	// ---- routing
	live('routing', 'an unknown route is 404 {"error":"404 Not Found"}', 'unknown route'),
	live(
		'routing',
		'a known route with a method it does not have is the same route 404',
		'PATCH is not a method of the issues route'
	),
	live(
		'routing',
		'POST on an issue, DELETE / PUT on the issues collection and POST on the events route are the route 404',
		'POST on the issue route',
		'DELETE on the issues route',
		'PUT on the issues route',
		'POST on the events route'
	),
	live('routing', 'an unknown project is 404 {"message":"404 Project Not Found"} (read)', 'unknown project'),
	live(
		'routing',
		'in a project that does not exist: reading its issues is 404 {"message":"404 Project Not Found"} (also by numeric id), but a create and the labels route are the plain {"message":"404 Not Found"}',
		'unknown project',
		'list in an unknown project by its numeric id',
		'create in an unknown project',
		'labels of an unknown project'
	),
	live(
		'routing',
		'the project is looked up before the permission: GET projects/<unknown> is 404 {"message":"404 Not Found"}, not the 403 of a token that may not read projects',
		'GET an unknown project (denied route)'
	),
	live(
		'routing',
		'the project can be addressed by its numeric id (the Link header echoes id=<number>)',
		'list with the numeric project id'
	),
	live(
		'routing',
		'the project can be addressed by its URL-encoded path (the Link header echoes the encoded path)',
		'list page 1 of 2'
	),
	live(
		'routing',
		'the project path is case insensitive (the Link header echoes it as written); the size headers depend on the live project and are not compared',
		'list with the project path in upper case'
	),
	live(
		'routing',
		'the project route accepts only the iid: the global id of an issue is 404 {"message":"404 Not found"}',
		'get an issue by its global id on the project route'
	),
	live('routing', 'a non numeric iid is 400 {"error":"issue_iid is invalid"}', 'get a non numeric iid'),
	live('routing', 'an unknown iid is 404 {"message":"404 Not found"}', 'get an unknown iid'),
	unverifiable(
		'routing',
		'the mock also serves GraphQL at /api/v4/graphql (GitLab: /api/graphql only)',
		"harmless superset so that the replay, which addresses <api>/graphql, reaches it; GitLab's answer on /api/v4/graphql is not needed"
	),
	unverifiable(
		'routing',
		'a GitLab route the mock does not have answers the plain route 404 (and not 501) when it is not in the list of known unmodelled sub-resources',
		'GitLab has hundreds of routes; the list of 501 sub-resources (time tracking, award emoji, subscriptions, discussions...) covers the ones of an issue only'
	),
	// ---- permissions
	live(
		'permissions',
		"the default permissions are the live token's: every Work Item and Label permission; the issue, notes, links, events and label routes work",
		'create A',
		'label events of A',
		'create label'
	),
	live(
		'permissions',
		'GET /projects/:id is 403 {"error":"insufficient_granular_scope","error_description":"Access denied: This operation requires a fine-grained personal access token with the following project permissions: [Project: Read]."}',
		'GET the project (denied)'
	),
	live(
		'permissions',
		'GET /user is 403 insufficient_granular_scope naming [User: Read] with the word "user"',
		'GET user (denied)'
	),
	live(
		'permissions',
		'GET /version and GET /metadata are 403 insufficient_granular_scope naming [Metadata: Read] with the word "instance"',
		'GET version (denied)',
		'GET metadata (denied)'
	),
	live(
		'permissions',
		'GET /personal_access_tokens/self is 403 naming [Personal Access Token: Read] with the word "user"',
		'GET personal_access_tokens/self (denied)'
	),
	live(
		'permissions',
		'GET /namespaces/<group> is 403 naming [Namespace: Read] with the word "user"',
		'GET the namespace (denied)'
	),
	live(
		'permissions',
		'GET members is 403 naming [Member: Read], hooks [Webhook: Read] (word "project"), languages [Project: Read] (word "project")',
		'GET members (denied)',
		'GET languages (denied)',
		'GET hooks (denied)'
	),
	live('permissions', 'GET /search is 403 naming [Global Search: Use] with the word "user"', 'GET search (denied)'),
	live(
		'permissions',
		'GET /issues/:id (instance route, global id) is 403 naming [Work Item: Read] with the word "instance"',
		'GET an issue by its global id (denied)'
	),
	live(
		'permissions',
		'GET /issues (instance list) is 403 naming [Work Item: Read] with the word "user"',
		'GET the instance issue list'
	),
	live(
		'permissions',
		'GraphQL project(fullPath) and namespace(fullPath) are null (no error) without Project / Namespace read',
		'project and namespace without permission'
	),
	unverifiable(
		'permissions',
		'GraphQL workItem / workItemUpdate / workItemConvert without the Work Item permission answer the REST-shaped 403 insufficient_granular_scope',
		'needs a token weaker than the only one we have (the owner cannot make a second one); kept because backend tests use the `permissions` option to simulate it, the shape is a guess'
	),
	documented(
		'permissions',
		'with a classic token (classicToken / permissions "all") every route is readable and writable',
		'https://docs.gitlab.com/auth/tokens/',
		'the live test token is fine-grained; a classic api token cannot be made'
	),
	documented(
		'permissions',
		'readOnlyToken: every write is 403 {"error":"insufficient_scope",...} with a WWW-Authenticate Bearer challenge',
		'https://docs.gitlab.com/api/rest/authentication/',
		'needs a read_api classic token we do not have'
	),
	documented(
		'permissions',
		'canDelete false: DELETE of an issue is 403 {"message":"403 Forbidden"}',
		'https://docs.gitlab.com/user/permissions/',
		'needs a user below Planner / Owner; the live token holder can delete'
	),
	documented(
		'permissions',
		'issuesEnabled false: every issue route is 403 {"message":"403 Forbidden"}',
		'https://docs.gitlab.com/user/project/settings/',
		'switching the Issues feature of the project off needs Project: Update, which the test token does not hold'
	),
	documented(
		'permissions',
		'accessLevel / archived / tokenScopes / tokenExpiresAt shape the project, the token and the member answers',
		'https://docs.gitlab.com/api/projects/',
		'the live token cannot read projects, tokens or members'
	),
	// ---- classic-token reads
	documented(
		'classic-token reads',
		'GET /user answers a user object with is_admin',
		'https://docs.gitlab.com/api/users/',
		'denied for the live token (User: Read)'
	),
	documented(
		'classic-token reads',
		'GET /version and /metadata answer {version, revision} and the metadata shape',
		'https://docs.gitlab.com/api/version/',
		'denied for the live token (Metadata: Read)'
	),
	documented(
		'classic-token reads',
		'GET /personal_access_tokens/self answers the token with scopes, active, expires_at',
		'https://docs.gitlab.com/api/personal_access_tokens/',
		'denied for the live token (Personal Access Token: Read)'
	),
	documented(
		'classic-token reads',
		'GET /namespaces/<id|path> answers the group with plan "free" and 404 {"message":"404 Namespace Not Found"} for an unknown one',
		'https://docs.gitlab.com/api/namespaces/',
		'denied for the live token (Namespace: Read)'
	),
	documented(
		'classic-token reads',
		'GET /projects/:id answers id, path_with_namespace, archived, issues_enabled, permissions.project_access.access_level, namespace',
		'https://docs.gitlab.com/api/projects/',
		'denied for the live token (Project: Read)'
	),
	documented(
		'classic-token reads',
		'GET members answers [{id, username, access_level}], languages {}, hooks []',
		'https://docs.gitlab.com/api/project_members/',
		'denied for the live token (Member / Repository / Webhook: Read); the bodies are minimal'
	),
	documented(
		'classic-token reads',
		'GET /issues/:id (global id) answers the issue',
		'https://docs.gitlab.com/api/issues/',
		'administrator only on GitLab; the live token is denied (Work Item: Read, instance)'
	),
	unverifiable(
		'classic-token reads',
		'GET /search answers 501 not modelled (a classic token only)',
		'global search needs [Global Search: Use] which the live token does not hold; the strategy lists with the project route'
	),
	// ---- issue shape
	live(
		'issue shape',
		'a created or updated issue has the 39 keys of the full issue (subscribed included), the list 38, the issue inside a link answer 29',
		'create A',
		'list page 1 of 2',
		'link A to B'
	),
	live(
		'issue shape',
		'type is upper case (ISSUE, INCIDENT, TASK), issue_type lower case, web_url is /-/work_items/N (/-/issues/N for an incident), references, severity UNKNOWN, time_stats zeros, subscribed true',
		'create A',
		'create B (incident)',
		'create C (task)'
	),
	live(
		'issue shape',
		'author and closed_by are user objects (the token user); closed_at / closed_by are set by a close and cleared by a reopen',
		'PUT close',
		'PUT reopen'
	),
	live('issue shape', 'discussion_locked is null until a person sets it', 'create A'),
	unverifiable(
		'issue shape',
		'ids: the global id is distinct from the iid and the iids count up from 1 per project',
		'the harness normalizes ids and instants, so only their order can be compared'
	),
	live('issue shape', 'user_notes_count counts the notes that are not system notes', 'G after the escaped ones'),
	live(
		'issue shape',
		'checkboxes in the description: task_completion_status {count, completed_count} counts them (-, * and numbered bullets, [x] and [X]), has_tasks is false and the task_status key is absent; without checkboxes has_tasks is true and task_status is "0 of 0 checklist items completed" (or "" when the description is null)',
		'create with a checklist',
		'create A',
		'get A'
	),
	live('issue shape', '_links.closed_as_duplicate_of is null for an issue that is not a duplicate', 'get A'),
	live(
		'issue shape',
		'_links.closed_as_duplicate_of is the API url of the original after /duplicate',
		'Q after /duplicate'
	),
	live(
		'issue shape',
		'the labels of an issue are sorted by plain code unit order and deduplicated per exact case',
		'create with duplicate labels',
		'create A'
	),
	live(
		'issue shape',
		'with_labels_details=true turns the labels into objects (id, name, description, text_color, description_html, color, archived)',
		'list with label details'
	),
	// ---- create
	live(
		'create',
		'POST 201 with the full issue; title is required (400 {"error":"title is missing"})',
		'create A',
		'create without title'
	),
	live(
		'create',
		'an empty or blank title is 400 {"message":{"title":["can\'t be blank"]}}',
		'create with an empty title',
		'create with a blank title'
	),
	live(
		'create',
		'a title of 256 characters is 400 {"message":{"title":["is too long (maximum is 255 characters)"]}}',
		'create with a title of 256 characters'
	),
	live('create', 'a title of exactly 255 characters is accepted', 'create with a title of 255 characters'),
	live(
		'create',
		'the title limit counts characters, not bytes (255 two-byte characters are accepted)',
		'create with a title of 255 two-byte characters'
	),
	live(
		'create',
		'a PUT title of 255 characters is accepted and 256 is refused with the same text as a create',
		'PUT a title of 255 characters',
		'PUT a title of 256 characters'
	),
	live('create', 'a number is accepted as a title and stored as text', 'PUT a numeric title'),
	live(
		'create',
		'a description of exactly 1,048,576 characters is accepted, 1,048,577 is 400 {"message":{"description":["is too long (1 MiB). The maximum size is 1 MiB."]}}',
		'create with a description of 1048576 characters',
		'create with a description of 1048577 characters'
	),
	live(
		'create',
		'the description limit is 1 MiB of BYTES: 600,000 two-byte characters are 400 {"message":{"description":["is too long (1.14 MiB). The maximum size is 1 MiB."]}}',
		'create with a description of 600000 two-byte characters'
	),
	live(
		'create',
		'the same description limit applies to a PUT',
		'PUT a description of 1048576 characters',
		'PUT a description of 1048577 characters'
	),
	live(
		'create',
		'CRLF becomes LF and trailing blanks of the description are stripped',
		'create A',
		'PUT description with CRLF'
	),
	live(
		'create',
		'issue_type test_case silently becomes issue; an unknown type is 400 {"error":"issue_type does not have a valid value"}; incident and task are accepted',
		'create D (test_case)',
		'create with an unknown issue_type',
		'create B (incident)',
		'create C (task)'
	),
	live(
		'create',
		'state and state_event are ignored on create (the issue is opened)',
		'create F (issue, state ignored)'
	),
	live(
		'create',
		'labels given as a string, an array, with duplicates (kept per exact case)',
		'create A',
		'create with labels as an array',
		'create with duplicate labels'
	),
	live('create', 'a comma inside an array element splits the label', 'create with a comma inside an array element'),
	live('create', 'spaces around the labels of a comma list are trimmed', 'create with spaces around the labels'),
	live('create', 'labels "" creates no label', 'create with an empty labels string'),
	live(
		'create',
		'creating an issue with a label that does not exist creates the label with the default colour',
		'search labels'
	),
	live('create', '100 labels are accepted on create', 'create with 100 labels'),
	live(
		'create',
		'101 labels on create are 400 {"message":"Cannot add more than 100 labels to a work item."} and create nothing',
		'create with 101 labels'
	),
	live('create', 'a form encoded body is accepted', 'create with a form encoded body'),
	live(
		'create',
		'the parameters can be given in the query string of a POST',
		'create with the title in the query string'
	),
	live('create', 'an unknown field in the body is ignored (201)', 'create with an unknown field'),
	live('create', 'description null creates an issue with a null description', 'create with a null description'),
	live('create', 'issue_type null on create is the same as no type (201, an issue)', 'create with a null issue_type'),
	live('create', 'a POST with no body at all is 400 {"error":"title is missing"}', 'create with no body at all'),
	live(
		'create',
		'confidential true on create makes a confidential issue without a system note',
		'create confidential',
		'notes of the confidential issue'
	),
	live(
		'create',
		'confidential "maybe" on create is 400 {"error":"confidential is invalid"}; a due_date that is not a date ("nope") is accepted and means no due date (201)',
		'create with a bad confidential',
		'create with a bad due_date'
	),
	live(
		'create',
		'a due date given at creation writes the system note "changed due date to May 06, 2031"',
		'create with a due date',
		'notes of DD after the creation'
	),
	live('create', 'weight (a paid parameter) is ignored on create', 'create with weight (paid)'),
	unverifiable(
		'create',
		'assignee_id(s), milestone(_id), severity, created_at, start_date, iid and the discussion parameters answer 501 not modelled on a create or a PUT',
		'GitLab honours them; the strategy never sends them and assigning needs member ids we cannot enumerate with this token'
	),
	live(
		'create',
		'the iid of a deleted newest issue is not reused by the next create',
		'create after the deletion',
		'list the deleted newest iid'
	),
	// ---- update
	live(
		'update',
		'a PUT with no known parameter is 400 {"error":"assignee_id, assignee_ids, confidential, ... are missing, at least one parameter must be provided"}',
		'PUT no parameter',
		'PUT an unknown parameter'
	),
	live(
		'update',
		'state is not a PUT parameter; state_event close / reopen is, any other value is 400 {"error":"state_event does not have a valid value"}',
		'PUT a state (not a parameter)',
		'PUT state_event bogus',
		'PUT close',
		'PUT reopen'
	),
	live('update', 'a second close or reopen is a 200 no-op', 'PUT close again', 'PUT reopen again'),
	live('update', 'a PUT with no body at all is the "at least one parameter" 400', 'PUT without a body'),
	live(
		'update',
		'labels replaces, add_labels adds, remove_labels removes; together they apply in that order',
		'PUT labels replace',
		'PUT add_labels',
		'PUT remove_labels',
		'PUT labels with add_labels',
		'PUT labels with remove_labels'
	),
	live(
		'update',
		'removing an absent label is a 200 no-op; labels "" clears; labels as an array',
		'PUT remove an unknown label',
		'PUT labels empty',
		'PUT labels array'
	),
	live('update', 'labels null clears the labels', 'PUT labels null'),
	live(
		'update',
		'a comma inside an array element of labels splits',
		'PUT labels with a comma inside an array element'
	),
	live(
		'update',
		'add_labels "" and remove_labels of several comma separated labels',
		'PUT add_labels empty',
		'PUT remove_labels of several labels'
	),
	live('update', 'one PUT can swap labels, close and rename at once', 'PUT one swap: labels + close + title'),
	live(
		'update',
		'issue_type incident <-> issue works, test_case is silently ignored, task is 400 {"message":{"work_item_type_id":["can not be changed to Task"]}}, a bogus type 400',
		'PUT issue_type incident',
		'PUT issue_type issue',
		'PUT issue_type test_case (ignored)',
		'PUT issue_type task (refused)',
		'PUT issue_type bogus'
	),
	live(
		'update',
		'an empty title is 400; description null is accepted; an unknown issue is 404',
		'PUT an empty title',
		'PUT description null',
		'PUT an unknown issue'
	),
	live(
		'update',
		'more than 100 labels on a PUT is 400 {"message":"Cannot add more than 100 labels to a work item."}',
		'PUT 101 labels'
	),
	live(
		'update',
		'add_labels that would exceed 100, and 100 labels plus a repeat of one (still 100), follow the same rule',
		'PUT add_labels beyond 100',
		'PUT 100 labels plus a duplicate'
	),
	live(
		'update',
		'updated_at is NOT a PUT parameter: a PUT with only updated_at is the "at least one parameter must be provided" 400',
		'updated order after updated_at in the future'
	),
	live(
		'update',
		'updated_at moves with a new title, a description and a real change of state; it does NOT move with labels nor with a repeated close',
		'updated order after a new title',
		'updated order after a description',
		'updated order after labels',
		'updated order after a close',
		'updated order after a repeated close'
	),
	live(
		'update',
		'updated_at does NOT move with a note; the PUT of the same title that followed it was the FIRST PUT of that issue, which moves it (see the first-PUT line)',
		'updated order after a note',
		'updated order after the same title'
	),
	live(
		'update',
		'updated_at does not move with the same description, the same labels, or the edit of a note',
		'updated order after the same description',
		'updated order after the same labels',
		'updated order after a note edit'
	),
	live(
		'update',
		'a system note is written for a title change (HTML diff), a description change, a type change, a due date, confidentiality; none for labels or state',
		'notes of F, oldest first',
		'PUT title of F (system note)',
		'PUT description of F (system note)',
		'PUT issue_type of F (system note)',
		'PUT labels of F (no system note)',
		'PUT close of F (no system note)'
	),
	live(
		'update',
		'removing the due date (null or "") writes the system note "removed due date <the old date, e.g. May 06, 2031>"',
		'PUT due_date null',
		'PUT due_date empty string',
		'notes of DD after the due date changes'
	),
	live(
		'update',
		'a due_date that is not a real day ("2031-13-45", "tomorrow") is accepted (200) and means no due date; the same date again changes nothing',
		'PUT due_date with an invalid date',
		'PUT due_date not a date',
		'PUT the same due_date',
		'PUT due_date again'
	),
	live(
		'update',
		'confidential true / false writes "made the item confidential" / "made the item visible to everyone"',
		'PUT confidential of F (system note)',
		'PUT not confidential of F'
	),
	live(
		'update',
		'confidential "maybe" is 400 {"error":"confidential is invalid"}',
		'PUT confidential with a bad value'
	),
	live(
		'update',
		'discussion_locked true / false writes the system notes "locked the discussion in this issue" / "unlocked the discussion in this issue"',
		'PUT discussion_locked',
		'PUT discussion_locked false',
		'notes of DD after the lock'
	),
	live('update', 'epic_id is 404 on Free', 'PUT epic_id'),
	live(
		'update',
		'epic_iid is 404 {"message":"404 Epic Not Found"}; weight alone is a 200 that changes nothing; health_status and iteration_id alone are the "at least one parameter" 400',
		'PUT epic_iid',
		'PUT weight (paid)',
		'PUT health_status (paid)',
		'PUT iteration_id (paid)'
	),
	live(
		'update',
		'a number as the title of a PUT is stored as its text and the title can be restored',
		'PUT a numeric title',
		'PUT a title after the numeric one'
	),
	live(
		'update',
		'move needs to_project_id (400 {"error":"to_project_id is missing"}) and a project that does not exist is 404 {"message":"404 Project Not Found"}',
		'POST move without a target',
		'POST move to an unknown project'
	),
	unverifiable(
		'update',
		'a move to the project itself or to a real project answers 501 not modelled',
		'moving closes the issue and copies it to another project with a new iid: destructive for the numbering and needs a second project'
	),
	unverifiable(
		'update',
		'time tracking, award emoji, subscriptions, discussions, participants, to-do items, closing merge requests, reorder, clone, promote, metric images and designs of an issue answer 501 not modelled',
		'the strategy never uses them; the discovery saw time estimate / spent work on Free and [Issue: Subscribe] denied for the test token, but nothing was recorded in the fixture'
	),
	unverifiable(
		'update',
		'order_by priority, due_date, relative_position, label_priority, milestone_due, popularity, weight answer 501 not modelled (any other unknown value is the recorded 400)',
		'the strategy only orders by created_at and updated_at'
	),
	// ---- events
	live(
		'events',
		'resource_label_events: one event per label change, add before remove, with the label {id, name}, resource_type Issue, a user',
		'label events of A'
	),
	live(
		'events',
		'resource_state_events: states closed and reopened, never opened',
		'state events of A',
		'state events of F'
	),
	live('events', 'the events of an unknown issue are 404', 'events of an unknown issue'),
	live(
		'events',
		'a label change and a state change are NOT notes',
		'PUT labels of F (no system note)',
		'PUT close of F (no system note)'
	),
	live(
		'events',
		'a deleted label shows label null in its old events',
		'label events of EV after the label was deleted'
	),
	live(
		'events',
		'the events of an issue without labels or never closed are an empty list',
		'label events of an issue without labels',
		'state events of an issue never closed'
	),
	live(
		'events',
		'the events are paginated like the lists; the Link header carries eventable_id and id and lists prev before next, then first and last',
		'label events of A, one per page'
	),
	live(
		'events',
		'under a sub-resource a non numeric issue is the plain 404 {"message":"404 Not found"} (not the 400 issue_iid is invalid of the issue itself); the state events of an unknown issue are 404',
		'state events of an unknown issue',
		'events of a non numeric issue'
	),
	live(
		'events',
		'the label events of one PUT share one created_at (<time same>), added before removed; a later PUT gives later events (<time later>)',
		'label events of S'
	),
	unverifiable(
		'events',
		'the state event of a PUT is about 0.5 s EARLIER than the label events of the same PUT',
		'the label events and the state events are two lists and the harness keeps the relation between the instants of ONE answer only; a rule comparing two lists would need a step that saves an instant, which no answer exposes as text (the 0.5 s was seen once by the discovery script)',
		'label events of S',
		'state events of S'
	),
	unverifiable(
		'events',
		'the initial state of an issue is not a state event; a quick action /close writes the event with the same rules',
		'the instants are normalized; the absence of an "opened" event is proved by the step "state events of A"',
		'state events of A'
	),
	live('events', 'the quick actions /label and /unlabel write label events', 'label events of Q'),
	// ---- notes
	live(
		'notes',
		'POST a note is 201 with the note object (type null, system false, noteable_type Issue, commands_changes {})',
		'note'
	),
	live(
		'notes',
		'an empty note body is 400 with the "can\'t be blank" text, a missing body 400 {"error":"body is missing"}',
		'note with an empty body',
		'note without body'
	),
	live('notes', 'a body of spaces only is the same "can\'t be blank" 400', 'note with a whitespace body'),
	live('notes', 'CRLF becomes LF in a note', 'note with CRLF'),
	live(
		'notes',
		'edit a note; an unknown note is 404; a note on an unknown issue is 404',
		'edit note',
		'edit an unknown note',
		'note on an unknown issue'
	),
	live(
		'notes',
		'editing a note with no body is a 200 that changes nothing; an empty body is 400 {"error":"body is empty"}',
		'edit a note without body',
		'edit a note with an empty body'
	),
	live('notes', 'delete a note is 204, again 404', 'delete a note', 'delete a deleted note'),
	live(
		'notes',
		'a system note cannot be edited or deleted (403 {"message":"403 Forbidden"})',
		'the oldest system note of F',
		'edit a system note',
		'delete a system note'
	),
	live(
		'notes',
		'a single note can be read; an unknown one is 404; deleting an unknown one is 404',
		'get a note',
		'get an unknown note',
		'delete an unknown note'
	),
	live(
		'notes',
		'a note of 1,000,001 characters is accepted (the limit is not enforced)',
		'note of 1000001 characters'
	),
	live('notes', 'editing a note to 1,000,001 characters is accepted too', 'edit a note to 1000001 characters'),
	live(
		'notes',
		'the list filters with activity_filter only_comments / only_activity and sorts with sort / order_by',
		'notes of F, oldest first',
		'notes of F, only comments',
		'notes of F, only activity'
	),
	live('notes', 'the default order of the notes is created_at descending', 'notes of F, default order'),
	live('notes', 'the notes of an unknown issue are 404', 'notes of an unknown issue'),
	live(
		'notes',
		'a bad activity_filter, order_by or sort is 400 "<name> does not have a valid value"',
		'notes with a bad activity_filter',
		'notes with a bad order_by',
		'notes with a bad sort'
	),
	live(
		'notes',
		'order_by=updated_at is accepted; the Link header carries activity_filter, id, noteable_id, order_by and sort, prev before next',
		'notes ordered by updated_at',
		'notes of F, two per page'
	),
	live('notes', 'a note does not move updated_at of the issue', 'updated order after a note'),
	live(
		'notes',
		'system note texts: HTML title diff, "changed the description", "changed type to **Incident**", "changed due date to January 02, 2030", "made the item confidential", "made the item visible to everyone"',
		'notes of F, oldest first'
	),
	live(
		'notes',
		'system notes of a link: "marked as related to #N" on both issues and "removed the relation with #N"',
		'notes of B after the link',
		'notes of B after the unlink'
	),
	live(
		'notes',
		'system notes of the hierarchy: "added #N as child item" on the parent and "added #N as parent item" on the child',
		'notes of C after the parent'
	),
	live(
		'notes',
		'removing a parent writes "removed child item #N" on the parent and "removed parent item #N" on the child',
		'HT without parent',
		'notes of HJ after the removal',
		'notes of HT after the removal'
	),
	live(
		'notes',
		'replacing a parent writes "moved child task #C to #P" on the old parent, "added #C as child item" on the new one and "added #P as parent item" on the child (no "removed parent item")',
		'notes of HI after the replace',
		'notes of HJ after the replace',
		'notes of HT after the replace'
	),
	live('notes', 'a GraphQL type conversion writes "changed type to **Issue**"', 'notes of CX after the convert'),
	live(
		'notes',
		'/duplicate writes, on the issue, "marked this issue as a duplicate of #N" then "marked as related to #N"; on the other issue "marked #M as a duplicate of this issue" then "marked as related to #M"',
		'notes of Q after /duplicate',
		'notes of Q3 after /duplicate'
	),
	live(
		'notes',
		'deleting an issue removes its links; the system notes of the other issues that mention it disappear from their lists but x-total still counts them',
		'links of U2 after the deletion',
		'notes of U2 after the deletion'
	),
	// ---- quick actions
	live(
		'quick actions',
		'a note holding only /close closes the issue, creates no note and answers 202 {"commands_changes":{"state_event":"close"},"summary":["Closed this issue."]}',
		'note with a quick action only',
		'G after its quick action'
	),
	live(
		'quick actions',
		'text plus a quick action: the note is kept without the command line; /label ~unknown is ignored (no label is created)',
		'note with text and a quick action'
	),
	live(
		'quick actions',
		'a command after a backslash or in a code fence is not run (the body keeps the backslash)',
		'note with an escaped quick action',
		'note with a quick action in a code fence',
		'G after the escaped ones'
	),
	live(
		'quick actions',
		'a command inside backticks is not run',
		'note with a quick action in backticks',
		'Q3 after the backtick note'
	),
	live(
		'quick actions',
		'a quick action in the description of a create is run and its line stripped',
		'create with a quick action in the description',
		'notes of QD'
	),
	live(
		'quick actions',
		'a quick action in the description of an update is run and its line stripped',
		'PUT a description with a quick action',
		'Q3 after the description quick action'
	),
	live(
		'quick actions',
		'/reopen reopens (summary "Reopened this issue.", commands_changes state_event reopen); on an open issue it is a 202 {"commands_changes":{},"summary":["Could not apply reopen command."]}',
		'quick action /reopen',
		'quick action /reopen on an open issue'
	),
	live(
		'quick actions',
		'/close on a closed issue is a 202 {"commands_changes":{},"summary":["Could not apply close command."]}',
		'quick action /close',
		'quick action /close on a closed issue',
		'Q after /close'
	),
	live(
		'quick actions',
		'/label ~existing adds it (summary Added ~"x" label., commands_changes add_label_ids); a label already held gives the same answer',
		'quick action /label with an existing label',
		'quick action /label with a label already held',
		'Q after /label'
	),
	live(
		'quick actions',
		'/label handles quoted names with spaces and several labels (plural "labels", add_label_ids lists them)',
		'quick action /label with a label that has spaces',
		'quick action /label with two labels'
	),
	live(
		'quick actions',
		'/unlabel ~x answers Removed ~"x" label. with remove_label_ids even when the issue did not hold it; /unlabel alone answers {"label_ids":[]} and "Removed all labels."',
		'quick action /unlabel with a label',
		'quick action /unlabel with a label not held',
		'quick action /unlabel without argument',
		'Q after /unlabel'
	),
	live(
		'quick actions',
		'/relate #N links both issues and writes "marked as related to #N" on the issue the command ran on ONLY; the summary is "Added #N as a linked item related to this issue." (again: the same, no second link; an unknown issue: "Added  as a linked item related to this issue."); with no argument the answer is 400 {"message":"400 Bad request - Failed to apply commands."}',
		'quick action /relate',
		'quick action /relate again',
		'quick action /relate to an unknown issue',
		'quick action /relate without argument',
		'notes of Q2 after /relate',
		'links of Q after /relate'
	),
	live(
		'quick actions',
		'/duplicate #N closes the issue, relates it, commands_changes {canonical_issue_id} and the summary "Closed this Issue. Marked as related to, and a duplicate of, <url of #N>."; on itself it answers "Failed to mark the Issue as duplicate of itself."',
		'quick action /duplicate',
		'quick action /duplicate on itself',
		'links of Q after /duplicate'
	),
	live(
		'quick actions',
		'several commands in one note run in order, the visible text stays as a 201 note whose commands_changes holds what they changed (add_label_ids, state_event close)',
		'note with text and two quick actions',
		'Q2 after the two quick actions'
	),
	live(
		'quick actions',
		'an unknown command (/bogus) is kept as text; the commands are case insensitive: /CLOSE closes (202)',
		'note with an unknown quick action',
		'note with an uppercase quick action'
	),
	live(
		'quick actions',
		'editing a note into a quick action RUNS it: the answer is a 202 like a new note and a note left with only commands is removed (the issue was reopened and its comment count fell)',
		'edit a note into a quick action',
		'Q2 after the note edit'
	),
	unverifiable(
		'quick actions',
		'the other commands (/assign, /milestone, /title, /confidential, /due, /estimate, /spend, /weight, /blocks, /blocked_by, /set_parent, /epic, /move, /lock, /subscribe, /todo, /shrug, ...) answer 501 not modelled in a note, a description or a note edit',
		'the strategy refuses text with a command line and never sends them; running them live would assign, move or change real data'
	),
	// ---- links
	live(
		'links',
		'POST links is 201 {id, source_issue, target_issue, link_type} with target_project_id the path or the numeric id',
		'link A to B'
	),
	live(
		'links',
		'GET links lists the issues with link_type relates_to and issue_link_id, the same from both ends, with no pagination header',
		'links of A',
		'links of B'
	),
	live(
		'links',
		'a duplicate link in any direction is 409 {"message":"Issue(s) already assigned"}',
		'same link again',
		'reverse link'
	),
	live(
		'links',
		'a link to itself is 422 {"message":"#N cannot be added: cannot be related to itself"}',
		'link to itself'
	),
	live(
		'links',
		'blocks / is_blocked_by are 403 {"message":"Blocked issues not available for current license"} on Free',
		'blocks link (paid)',
		'is_blocked_by link (paid)'
	),
	live(
		'links',
		'a bad link_type is 400; a missing target is 400; an unknown target issue / project / source issue is 404',
		'unknown link_type',
		'link without target',
		'link to an unknown issue',
		'link to an unknown project',
		'link from an unknown issue'
	),
	live('links', 'target_project_id as the numeric project id works', 'link with the numeric project id'),
	live(
		'links',
		'target_project_id as the URL-encoded path is 404 Project Not Found',
		'link with an encoded project path'
	),
	live('links', 'a closed target issue can be linked', 'link to a closed issue'),
	live('links', 'an explicit link_type relates_to is the default', 'link with an explicit relates_to'),
	live(
		'links',
		'a non numeric target_issue_iid and a deleted target are the unknown issue 404',
		'link with a non numeric target iid',
		'link to a deleted issue'
	),
	live(
		'links',
		'DELETE a link is 200 with the link, again 404; both issues get "removed the relation with #N"',
		'delete the link',
		'delete the link again',
		'notes of B after the unlink'
	),
	live(
		'links',
		"a link can be deleted from either end and the answer keeps the link's own source and target; through an issue that is not part of it, or an unknown id, it is 404",
		'delete the link from the other end',
		'delete a link through an issue that is not part of it',
		'delete an unknown link',
		'notes of L2 after the unlink'
	),
	live(
		'links',
		'an issue without links lists []; the links of an unknown issue are 404',
		'links of an issue without links',
		'links of an unknown issue'
	),
	documented(
		'links',
		'seedLink with type blocks / is_blocked_by stores a Premium link (stored swapped, seen as is_blocked_by from the target) for backend tests',
		'https://docs.gitlab.com/api/issue_links/',
		'blocking links are Premium; they cannot be created on Free so no live answer exists; reachable only through the seed helper, never through the API'
	),
	// ---- labels
	live(
		'labels',
		'a label needs name and color ({"error":"color is missing"}); a bad colour is 400 {"message":{"color":["must be a valid color code"]}}',
		'create a label without color',
		'create a label with a bad color'
	),
	live(
		'labels',
		'create 201 with the label object (is_project_label true, subscribed false, priority null, text_color, description_html); a duplicate name is 409 {"message":"Label already exists"}',
		'create label',
		'create the same label'
	),
	live('labels', 'the CSS name red is accepted and stored as #FF0000', 'create a label with a color name'),
	live(
		'labels',
		'the CSS colour names blue, green, black, white, yellow, orange, purple, gray, grey, pink, brown, aqua, fuchsia, lime, navy, teal, maroon, olive, silver are accepted and stored as their hex; cyan and magenta are 400',
		'create a label with the color name blue',
		'create a label with the color name green',
		'create a label with the color name black',
		'create a label with the color name white',
		'create a label with the color name yellow',
		'create a label with the color name orange',
		'create a label with the color name purple',
		'create a label with the color name gray',
		'create a label with the color name grey',
		'create a label with the color name pink',
		'create a label with the color name brown',
		'create a label with the color name cyan',
		'create a label with the color name aqua',
		'create a label with the color name magenta',
		'create a label with the color name fuchsia',
		'create a label with the color name lime',
		'create a label with the color name navy',
		'create a label with the color name teal',
		'create a label with the color name maroon',
		'create a label with the color name olive',
		'create a label with the color name silver'
	),
	live(
		'labels',
		'colour forms: #F00 is kept as written, #ff0000 keeps its case, FF0000 (no hash) and #GGGGGG and #FF00 are invalid, RED (upper case name) is accepted',
		'create a label with the color three digits #F00',
		'create a label with the color lower case #ff0000',
		'create a label with the color no hash FF0000',
		'create a label with the color upper case name RED',
		'create a label with the color an invalid hex #GGGGGG',
		'create a label with the color a short wrong length #FF00'
	),
	live(
		'labels',
		'text_color is #1F1E24 for a light colour (0.2126 R + 0.7152 G + 0.0722 B over 255 above 0.6: #00FF00, #AAAAAA, #FFA500 are light, #999999 is not) and #FFFFFF otherwise',
		'create a label with the color #000000',
		'create a label with the color #FFFFFF',
		'create a label with the color #FFFF00',
		'create a label with the color #336699',
		'create a label with the color #7F7F7F',
		'create a label with the color #808080',
		'create a label with the color #999999',
		'create a label with the color #AAAAAA',
		'create a label with the color #BBBBBB',
		'create a label with the color #00FF00',
		'create a label with the color #00FFFF',
		'create a label with the color #FF00FF',
		'create a label with the color #FFA500'
	),
	live(
		'labels',
		'an empty name is 400 {"message":{"title":["can\'t be blank","is invalid"]}}, a comma 400 ["is invalid"], 256 characters 400 ["is too long (maximum is 255 characters)"]',
		'create a label with an empty name',
		'create a label with a comma',
		'create a label of 256 characters'
	),
	live('labels', 'a name of exactly 255 characters is accepted', 'create a label of 255 characters'),
	live(
		'labels',
		'edge spaces are trimmed; / % & quotes, a tab, an emoji and accents are accepted in a name',
		'create a label with edge spaces',
		'create a label with a slash',
		'create a label with a percent',
		'create a label with an ampersand',
		'create a label with double quotes',
		'create a label with a single quote',
		'create a label with a tab',
		'create a label with an emoji',
		'create a label with accents'
	),
	live(
		'labels',
		'a colon and a plus are accepted in a name',
		'create a label with a colon',
		'create a label with a plus'
	),
	live(
		'labels',
		':: labels are plain names: two of one scope stay together, a PUT swaps them, the list filters on them; no exclusivity on Free',
		'create a scoped looking label',
		'create an issue with a scoped looking label',
		'add a second label of the same scope',
		'replace with two labels of the same scope',
		'swap in one PUT between scoped looking labels',
		'list by a scoped looking label'
	),
	live('labels', 'names are case sensitive (bug next to Bug)', 'create with duplicate labels', 'search labels'),
	live(
		'labels',
		'a description of 300 characters is accepted',
		'create a label with a description of 300 characters'
	),
	live(
		'labels',
		'a description of 1000 characters and a null description are accepted (no limit modelled)',
		'create a label with a description of 1000 characters',
		'create a label with a null description'
	),
	live(
		'labels',
		'the list is sorted by name, searchable (case-insensitive substring) and paginated; the Link header carries id, include_ancestor_groups, with_counts and search',
		'search labels'
	),
	live(
		'labels',
		'search is case insensitive; page 2 of ten is cut from the 19 accepted names; with_counts adds the issue counts; include_ancestor_groups=false is echoed',
		'list labels, search in upper case',
		'list labels, second page of ten',
		'list labels with counts',
		'list labels without ancestor groups'
	),
	live('labels', 'a bad per_page on the labels list is the same 400', 'list labels with a bad per_page'),
	live('labels', 'GET a label by its URL-encoded name; a :: name works', 'get a label', 'get a scoped looking label'),
	live('labels', 'an unknown label is 404 {"message":"404 Label Not Found"}', 'get an unknown label'),
	live(
		'labels',
		'a label can be read, changed and deleted by its numeric id; an unknown id is 404',
		'get a label by id',
		'get an unknown label by id',
		'PUT a label by id',
		'delete a label by id',
		'delete a label by id again'
	),
	live('labels', 'PUT new_name renames (the issues holding the label follow)', 'rename a label'),
	live(
		'labels',
		'a rename to a taken name is 400 {"message":{"title":["has already been taken"]}}; to its own name, an empty name, a comma, 256 characters, edge spaces',
		'rename a label to an existing name',
		'rename a label to its own name',
		'rename a label to an empty name',
		'rename a label to a name with a comma',
		'rename a label to 256 characters',
		'rename a label with edge spaces'
	),
	live(
		'labels',
		'a PUT with no parameter is 400 {"error":"new_name, color, description, priority, archived are missing, at least one parameter must be provided"}; colour only, bad colour, description null, unknown label 404',
		'PUT a label without parameter',
		'PUT a label color only',
		'PUT a label with a bad color',
		'PUT a label description null',
		'PUT an unknown label'
	),
	live(
		'labels',
		'DELETE a label is 204, again 404 {"message":"404 Label Not Found"}',
		'delete a label',
		'delete a deleted label'
	),
	live('labels', 'deleting an unknown label is that 404', 'delete an unknown label'),
	live('labels', 'deleting a label removes it from the issues holding it', 'EV after its label was deleted'),
	unverifiable(
		'labels',
		'label priority (create, PUT) answers 501 not modelled; the key priority stays null',
		'unused by the strategy and the Free tier has no label priorities to verify'
	),
	unverifiable(
		'labels',
		'a GROUP label: it is listed with is_project_label false, a project label of the same name is 409, issues can hold it without creating a project label',
		'seen by the discovery of 2026-11-09 (storage plan 2.3.1); a fixture cannot create a group label (it writes group data and needs Label permissions on the group)'
	),
	unverifiable(
		'labels',
		'changing or deleting a GROUP label through the project route answers 501 not modelled',
		'destructive on group data: no probe is allowed'
	),
	// ---- lists
	live(
		'lists',
		'default order created_at descending; x-page, x-per-page, x-total, x-total-pages, x-next-page, x-prev-page; Link first / prev / next / last with the parameters sorted by name',
		'list page 1 of 2',
		'list page 2'
	),
	live('lists', 'a page beyond the end is [] with a 200', 'list page beyond'),
	live('lists', 'per_page 0 is 400 {"error":"per_page has a value not allowed"}', 'list per_page 0'),
	live('lists', 'per_page 101 is clamped to 100; page 0 is page 1', 'list per_page 101 (clamped)', 'list page 0'),
	live(
		'lists',
		'page -1 is page 1; a negative per_page is the default 20 (200); per_page / page "abc" are 400 "per_page is invalid" / "page is invalid"',
		'list page -1',
		'list per_page -1',
		'list per_page not a number',
		'list page not a number'
	),
	live(
		'lists',
		'pagination=keyset answers a Link with ONLY rel="next" holding an opaque cursor (and page=1), no x-* header; the last page has no link',
		'list keyset pagination'
	),
	live(
		'lists',
		'iids[] selects issues; state opened / closed filters; the unknown state is 400 "state does not have a valid value"',
		'list by iids',
		'list opened',
		'list closed',
		'list closed (none yet)',
		'list bad state'
	),
	live('lists', 'state=all is the default and is echoed in the Link header', 'list state all'),
	live(
		'lists',
		'order_by updated_at and sort asc; a bad order_by is 400 {"error":"order_by does not have a valid value"}',
		'list ascending by updated_at',
		'list bad order_by'
	),
	live(
		'lists',
		'order_by created_at with sort asc; a bad sort is 400 "sort does not have a valid value"',
		'list ascending by created_at',
		'list sort bogus'
	),
	live(
		'lists',
		'labels= selects the issues holding the label; issue_type filters',
		'list by a scoped looking label',
		'list issue_type'
	),
	live(
		'lists',
		'labels=a,b requires ALL labels; labels=None / Any select unlabeled / labeled issues',
		'list Z by one label',
		'list Z by two labels (all of them)',
		'list Z with no label',
		'list Z with any label'
	),
	live(
		'lists',
		'not[labels]=a excludes the issues holding a; not[labels]=a,b excludes the issues holding ANY of them; labels and not[labels] combine',
		'list not labels',
		'list Z not one label',
		'list Z not the other label',
		'list Z not two labels',
		'list Z by a label and not another'
	),
	live(
		'lists',
		'search matches the title and the description by WORD START, case-insensitive: "zed<run>" finds "conf <run> zed<run> two", "ed<run>" (the middle of the word) finds nothing',
		'list search title',
		'list search description'
	),
	live(
		'lists',
		'search is case insensitive and one character is enough ("z" finds the words starting with z); the middle of a word does not match',
		'list search in upper case',
		'list search inside a word',
		'list search of one character'
	),
	live(
		'lists',
		'in=title / in=description / in=title,description restrict the fields; an unknown in value is ignored and both fields are searched',
		'list search of a description with in=title',
		'list search of a description with in=description',
		'list search of a title with in=description',
		'list search of a title with in=title',
		'list search with in=title,description',
		'list search with an unknown in value',
		'list search in the description only'
	),
	live(
		'lists',
		'search words must each START a word of the title or description in any order ("one zed<run>" finds "zed<run> one"); an empty search and an empty labels are ignored',
		'list search of two words in order',
		'list search of two words reversed',
		'list with an empty search',
		'list with an empty labels'
	),
	live(
		'lists',
		'issue_type filters a list; created_after / created_before / updated_after / updated_before filter on the instants and are echoed in the Link as 2999-01-01T00:00:00+00:00; a value that is not a date is 400 {"error":"created_after is invalid"}',
		'list incident by iid',
		'list task by the iid of an incident',
		'list created_after in the future',
		'list created_before in the future',
		'list updated_after in the future',
		'list updated_before in the future',
		'list created_after not a date'
	),
	live(
		'lists',
		'an unknown iid selects nothing; a non numeric iid counts as 0 (echoed iids[]=0); an unknown filter is ignored and echoed in the Link header',
		'list an unknown iid',
		'list a non numeric iid',
		'list with an unknown filter'
	),
	live('lists', 'a list is visible at once after a create (no lag)', 'list page 1 of 2', 'list by iids'),
	live(
		'lists',
		'issues_statistics answers {statistics:{counts:{all, closed, opened}}} for the labels filter',
		'statistics'
	),
	live(
		'lists',
		'issues_statistics honours search and ignores state (the counts always cover all states); labels=None works',
		'statistics of Z',
		'statistics of Z with a state',
		'statistics of Z with labels=None'
	),
	live(
		'lists',
		'with_labels_details=true is echoed in the Link header and gives label objects',
		'list with label details'
	),
	// ---- delete
	live(
		'delete',
		'DELETE an issue is 204 (open); afterwards GET, notes and list by iid find nothing (404 / [])',
		'delete H',
		'get the deleted issue',
		'notes of the deleted issue',
		'list by iids with the deleted one'
	),
	live(
		'delete',
		'DELETE a closed issue is 204; its links go with it',
		'link DC to U2',
		'close DC',
		'delete a closed issue with a link'
	),
	live('delete', 'DELETE a deleted issue is 404 {"message":"404 Issue Not Found"}', 'delete the deleted issue'),
	live('delete', 'a PUT on a deleted issue is 404 {"message":"404 Not found"}', 'PUT the deleted issue'),
	live(
		'delete',
		'deleting a parent leaves its child without a parent and takes the child\'s "added #N as parent item" note out of its list (x-total still counts it)',
		'DK under DP',
		'delete a parent',
		'read DK after its parent was deleted',
		'notes of DK after its parent was deleted'
	),
	// ---- graphql
	live(
		'graphql',
		'HTTP 200 for every answer with the errors in the body; a syntax error has no data; an unknown field suggests (Did you mean `note`?)',
		'graphql syntax error'
	),
	live(
		'graphql',
		'workItem(id: gid://gitlab/WorkItem/<REST id>): id, iid (a string), workItemType.name, 19 widgets for an Issue with the hierarchy at index 9, 16 for a Task with the hierarchy at index 6',
		'read A hierarchy',
		'read the child C'
	),
	live(
		'graphql',
		'the hierarchy widget carries parent {id iid} and children(first:100) {nodes}',
		'read the parent A',
		'read the child C'
	),
	live(
		'graphql',
		'an Incident has 18 widgets, with the hierarchy at index 8 (an Issue has 19, hierarchy at 9)',
		'read B hierarchy'
	),
	live(
		'graphql',
		'widget types in order: Issue ASSIGNEES, AWARD_EMOJI, CRM_CONTACTS, CURRENT_USER_TODOS, DESCRIPTION, DESIGNS, DEVELOPMENT, EMAIL_PARTICIPANTS, ERROR_TRACKING, HIERARCHY, LABELS, LINKED_ITEMS, MILESTONE, NOTES, NOTIFICATIONS, PARTICIPANTS, START_AND_DUE_DATE, TIME_TRACKING, LINKED_RESOURCES; Incident has 18 (ESCALATION_STATUS, SEVERITY, no DESIGNS / ERROR_TRACKING / START_AND_DUE_DATE); Task 16',
		'widget types of an Issue',
		'widget types of an Incident',
		'widget types of a Task'
	),
	live(
		'graphql',
		'workItemUpdate hierarchyWidget.parentId: a Task under an Issue works; Task under Task, Issue under Issue, an item under itself, a Task under an Incident... answer errors ["#N cannot be added: it\'s not allowed to add this type of parent item"] (+ " and is not allowed to point to itself")',
		'task C under issue A',
		'task E under task C',
		'issue A under issue F',
		'task C under itself',
		'task C under incident B',
		'task C under issue F'
	),
	live(
		'graphql',
		'a parent is replaced by setting another; parentId null removes it (idempotent)',
		'HT under HI',
		'HT under HJ (replace the parent)',
		'task C without parent',
		'task C without parent again'
	),
	live(
		'graphql',
		'an unknown work item in workItemUpdate is the field error "404 Not Found" with a null field',
		'unknown work item'
	),
	live(
		'graphql',
		'workItemConvert with gid://gitlab/WorkItems::Type/N: 1 Issue, 5 Task work; 3 Test Case is the field error "You are not allowed to change the Work Item type to Test Case."',
		'convert D (test case) to task',
		'convert E to issue',
		'convert E to test case'
	),
	live(
		'graphql',
		'workItemConvert: to Incident (2) and back, to the same type (no-op); the types 4 Requirement, 6 Objective, 7 Key Result, 8 Epic are field errors "You are not allowed to change the Work Item type to <Name>."; an unknown id (99) is "Work Item type <gid> was not found"; a malformed or missing type id is a variable error',
		'convert CX to issue',
		'convert CX to incident',
		'convert CX to task',
		'convert CX to the work item type 4',
		'convert CX to the work item type 6',
		'convert CX to the work item type 7',
		'convert CX to the work item type 8',
		'convert CX to the work item type 99',
		'convert with a malformed type id',
		'convert without a type id',
		'convert HT to its own type',
		'CX after the conversions'
	),
	live(
		'graphql',
		'an issue with children cannot become a Task ("Work item type cannot be changed to Task with these child item types.") and a child task cannot become an issue ("Work item type cannot be changed to issue when linked to a parent issue."), both in the payload errors',
		'convert HI (with a child) to task',
		'convert HT (a child) to issue'
	),
	live(
		'graphql',
		'a conversion moves updated_at (the converted issue sorts after the newer one)',
		'updated order after the convert'
	),
	live('graphql', 'aliases batch several workItem reads in ONE request', 'batched reads with aliases'),
	live(
		'graphql',
		'named and inline fragments, variables, @include and @skip behave as the GraphQL spec',
		'fragments and directives'
	),
	live(
		'graphql',
		'WorkItem scalar fields: title, state OPEN / CLOSED, confidential, webUrl, createdAt, updatedAt, closedAt, workItemType.id',
		'scalar fields of a work item'
	),
	live(
		'graphql',
		'a work item that does not exist is the field error "The resource that you are attempting to access does not exist or you don\'t have permission to perform this action" with data.workItem null; a malformed global id is the variable error "Variable $id of type WorkItemID! was provided invalid value" (problems[0].explanation: \'"x" is not a valid Global ID\')',
		'read an unknown work item',
		'read a malformed global id'
	),
	live(
		'graphql',
		'workItemUpdate: an unknown parent is a field error "No object found for `parentId: #<GlobalID:0x... @uri=#<URI::GID gid://gitlab/WorkItem/N>>`" with data.workItemUpdate null; malformed ids are variable errors naming the path (id, hierarchyWidget.parentId); no hierarchyWidget changes nothing; no id is "Expected value to not be null"',
		'task C under an unknown parent',
		'workItemUpdate with a malformed id',
		'workItemUpdate with a malformed parent id',
		'workItemUpdate without hierarchyWidget',
		'workItemUpdate without an id'
	),
	live(
		'graphql',
		'an unknown field of the input object is the variable error "... invalid value for bogus (Field is not defined on WorkItemUpdateInput)" with locations',
		'workItemUpdate with an unknown input field'
	),
	live(
		'graphql',
		'validation messages with the names the live answers use: "Selections can\'t be made on scalars (... but has selections [\\"x\\"])", "Field must have selections", "Field \'workItem\' is missing required arguments: id", "doesn\'t accept argument" (typeName Field), "Field \'x\' doesn\'t exist on type" (+ Did you mean), "Fragment X was used, but not defined", "No such type X, so it can\'t be a fragment condition (Did you mean `Note`?)", "Expected string or block string, but it was malformed"; nodeName is "field \'iid\'", the fragment paths are "... X" / "... on X"',
		'graphql selection on a scalar',
		'graphql missing selection',
		'graphql missing argument',
		'graphql unknown argument',
		'graphql unknown field with a suggestion',
		'graphql unknown field without a suggestion',
		'graphql undefined fragment',
		'graphql unknown fragment type',
		'graphql unterminated string'
	),
	live(
		'graphql',
		'operation errors: no query and an empty query are "Unexpected end of document" (with locations); two operations without a name "An operation name is required"; an unknown operation name "No operation named"',
		'graphql without a query',
		'graphql with an empty query',
		'graphql with two operations and no name',
		'graphql with an unknown operation name'
	),
	live(
		'graphql',
		'variable errors: a missing or null required variable is "Variable $id of type WorkItemID! was provided invalid value" (problem "Expected value to not be null"); a variable of the wrong type is the same message with the explanation "5 is not a valid Global ID"',
		'graphql variable missing',
		'graphql variable null',
		'graphql variable of the wrong type'
	),
	live('graphql', '__typename answers the type name', 'graphql selecting __typename'),
	live(
		'graphql',
		'GraphQL without a token is answered (an anonymous { __typename } is 200 with the unauthenticated quota); with a bad token it is 401 {"errors":[{"message":"Invalid token"}]} with the GraphQL content type',
		'graphql without a token',
		'graphql with a bad token'
	),
	unverifiable(
		'graphql',
		'fields of a widget other than type / the hierarchy, fields of a connection other than nodes, workItemUpdate inputs other than id / hierarchyWidget.parentId, GraphQL over GET and subscriptions answer 501 not modelled',
		'GitLab has dozens of fields per widget; the strategy reads the hierarchy only; a write with another input (title, stateEvent...) would change real data'
	),
	unverifiable(
		'graphql',
		'a field of WorkItem, Query, Project or Namespace the mock does not know is reported as nonexistent ("doesn\'t exist on type") although GitLab may have it',
		'the full GraphQL schema is not available offline; only the fields listed in the ledger are modelled'
	),
	// ---- tooling
	unverifiable(
		'tooling',
		'failNext / dropNext / hangNext / forceRateLimit inject faults (forced status, dropped connection, no answer)',
		'test tooling: not a GitLab behaviour'
	),
	unverifiable(
		'tooling',
		'the fake clock moves 5 s per change (clockStepMs) and the events of one request share one instant',
		'test tooling: real GitLab uses its own clock'
	),
	unverifiable(
		'tooling',
		'seedIssue / seedNote / seedLabel / seedGroupLabel / seedLink / seedParent / seedDemo create state without the API rules (no license check, no type rule)',
		'test tooling: a person using the UI, not an API behaviour'
	),
	unverifiable(
		'tooling',
		'every request is recorded (method, normalized path, query, status, auth, body) and setPermissions changes the token mid-run',
		'test tooling'
	),
	// ---- tail (recorded after the first recordings; the last line waits for the tail 2 steps)
	live(
		'lists',
		'a native task (issue_type task) appears in the unfiltered list of the project, next to the issues',
		'list a task and an issue together'
	),
	live(
		'update',
		'the FIRST PUT of an issue after its creation moves updated_at even with nothing changed (a fresh issue sorts before a newer one)',
		'updated order after the same title on a fresh issue',
		'updated order after the same title'
	),
	live('events', 'a close with a label swap in one PUT gives one state event "closed"', 'state events of S'),
	live(
		'update',
		'the PUTs after the first one that change nothing do NOT move updated_at: the same title, description null on null, labels "" on none, reopen on an open issue',
		'updated order after the first PUT of W',
		'updated order after the second PUT of W',
		'updated order after description null on W',
		'updated order after labels empty on W',
		'updated order after reopen on an open W',
		'updated order after the third PUT of W'
	),
];
