// The HYPOTHESIS LEDGER of the GitHub fake (fakeGitHub.testkit.ts): one line per behaviour the fake implements, with how well it is known.
// The rule: "validate EVERY hypothesis of the fake against the real GitHub". Modelled on fakeGitLabLedger.testkit.ts.
//
//   LIVE-VERIFIED        recorded on api.github.com (2026-11-14, an organization repository, a fine-grained token with Issues read and
//                        write, administrator). `evidence` names the exact steps of the conformance fixture
//                        (fixtures/live-conformance.json) that replay it. A line whose steps are not in the fixture FAILS the
//                        conformance test (drift guard). A step only proves what the harness compares: status, key headers and the
//                        normalized body (ids and users are normalized; instants keep their relation: `updated_at` to `created_at`,
//                        and each event to the previous one: same / later / earlier; only the keys the fake sends are compared, plus
//                        every key the strategy reads, see REAL_ONLY_KEYS in githubConformance.testkit.ts).
//   DOCUMENTED-NOT-LIVE  a docs.github.com page states it; `docs` is the page and `reason` says why no live probe is possible.
//   UNVERIFIABLE         cannot be probed with this token on a throwaway repository (`reason`): a weaker token, another role, a quota to
//                        burn, a duration the harness does not keep, a test hook that has no HTTP form.
//   ASSUMED              a guess nobody checked, allowed only while a live probe is pending (`probe`). There is none left: the test
//                        `no ledger entry is ASSUMED` keeps it that way.
//
// Conventions: `area` groups the lines; `behaviour` is one sentence naming the status, the message, the header or the rule as the fake
// implements it. `evidence` of a non LIVE-VERIFIED line may still name steps (the ones that show the shape).
// githubConformance.test.ts enforces: unique ids, every evidence step exists in the scenario, every LIVE-VERIFIED step exists in the
// fixture, no ASSUMED, DOCUMENTED-NOT-LIVE carries docs and reason, UNVERIFIABLE carries a reason.
// Test-only: nothing in the shipped code imports this file.

export type LedgerStatus = 'LIVE-VERIFIED' | 'DOCUMENTED-NOT-LIVE' | 'UNVERIFIABLE' | 'ASSUMED';

export interface LedgerEntry {
	/** `G001`... stable once the ledger is final; unique. */
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

const LIVE_DATE = '2026-11-14';

let counter = 0;
const nextId = (): string => `G${String(++counter).padStart(3, '0')}`;

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
		'a refused token is 401 {"message":"Bad credentials"} with a documentation_url and no rate-limit header',
		'bad token'
	),
	live(
		'auth',
		'no credentials on a private repository: 404 Not Found with the anonymous quota (limit 60, resource core, no token-expiration header)',
		'no token'
	),
	live(
		'auth',
		'GraphQL without credentials is 403 naming the anonymous rate limit (limit 0, resource graphql)',
		'GraphQL without a token'
	),
	unverifiable(
		'auth',
		'a path that is not under /repos, /graphql, /search/issues, /user or /rate_limit, without credentials, is 401 "Requires authentication"',
		'only the repository and GraphQL shapes were probed without a token; no route of the strategy is outside them'
	),
	unverifiable(
		'auth',
		'readOnlyToken: every write is 403 "Resource not accessible by personal access token" with x-accepted-github-permissions issues=write; denyIssues does the same on reads (issues=read)',
		'the only token has Issues write: a weaker one cannot be made from it. The shape (a 403 "Resource not accessible by personal access token" with x-accepted-github-permissions) was seen once on a different cause, a sub-issue id that was somebody else\'s issue, and not again'
	),
	live(
		'auth',
		'an authenticated answer carries x-ratelimit-limit 5000, x-ratelimit-resource core, a token-expiration header; search answers resource search with limit 30; GraphQL resource graphql; a 304 carries no expiration header',
		'get A',
		'get A with its etag',
		'search by title',
		'GraphQL deleteIssue'
	),
	live(
		'auth',
		'GET /user, GET the repository (private, has_issues, archived, permissions admin/push/pull) and GET /rate_limit (core, search, rate) have the shapes the strategy reads',
		'GET user',
		'GET repository',
		'GET rate_limit'
	),
	unverifiable(
		'rate limit',
		'a write spends one request of the quota, a 304 spends none, GET /rate_limit is free, an empty bucket answers 403 "API rate limit exceeded" with remaining 0',
		'the counters are eventually consistent live (x-ratelimit-used is not monotonic, measured 2026-11-08), so the harness normalizes them; exhausting the quota would burn the hour of the token; the secondary limits were not provoked'
	),
	documented(
		'rate limit',
		'403 with x-ratelimit-remaining 0 (primary) and 403/429 with retry-after (secondary) are the rate-limit answers',
		'https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api',
		'provoking either needs thousands of requests or a burst GitHub may punish with a ban of the token'
	),
	live('request', 'an invalid JSON body is 400 {"message":"Problems parsing JSON"}', 'invalid json'),
	live(
		'request',
		'the owner and the name of a repository are case-insensitive in the path',
		'repository name in upper case'
	),
	live(
		'request',
		'an unknown repository is 404 Not Found with the rate-limit headers; a path no route serves (unknown route, a method a route does not have) is 404 without them',
		'unknown repository',
		'unknown route',
		'DELETE the issue over REST'
	),
	live(
		'request',
		'If-Match and If-Unmodified-Since on a write are 400 "Bad Request" with errors ["Conditional request headers are not allowed ..."]; If-None-Match * is a 412 with an empty body',
		'PATCH with If-Match',
		'PATCH with If-Unmodified-Since',
		'PATCH with If-None-Match star'
	),
	live(
		'request',
		'a JSON answer carries an ETag; If-None-Match with it is a 304 (no content type, no body), with another value a 200; the same on a list',
		'get A',
		'get A with its etag',
		'get A with another etag',
		'list with the etag',
		'list with its etag'
	),
	unverifiable(
		'request',
		'the value of the ETag (a hash of the body in the fake, opaque on GitHub); a write answer also carries one',
		'only its presence and the 304 are compared, the value is opaque'
	),
	unverifiable(
		'request',
		'a route the strategy never calls (PATCH on a label, GET of one comment, ...) is a no-route 404',
		'GitHub answers those with a real answer; the fake models only the routes of the strategy and is wrong elsewhere, on purpose'
	),
	// ---- repository labels
	live(
		'labels',
		'POST /labels is 201 with name, color (default ededed), description (null by default), default false',
		'create label',
		'create label without color'
	),
	live(
		'labels',
		'a label that exists, in any case, is 422 already_exists on name',
		'create label again',
		'create label in other case'
	),
	live(
		'labels',
		'a name of 51 characters is 422 custom "name is too long (maximum is 50 characters)"; an empty name is 422 missing_field; no name at all is 422 \'Invalid request. "name" wasn\'t supplied.\'; a comma is 422 invalid',
		'create label of 51 characters',
		'create label with an empty name',
		'create label without name',
		'create label with a comma'
	),
	live(
		'labels',
		'a color that is not six hexadecimal digits is 422 invalid on color; a description over 100 characters is 422 custom',
		'create label with a bad color',
		'create label with a long description'
	),
	live(
		'labels',
		'a leading space of a name is trimmed; colons are allowed in names',
		'create label with a leading space',
		'create label with colons'
	),
	live(
		'labels',
		'GET /labels/{name} is case-insensitive, accepts a percent-encoded colon, and is 404 for an unknown label',
		'get label',
		'get label in other case',
		'get label with a colon',
		'get unknown label'
	),
	live(
		'labels',
		'DELETE /labels/{name} is 204 without a content type; a second time 404',
		'delete label',
		'delete a deleted label'
	),
	unverifiable(
		'labels',
		'GET /labels (the repository list, pages by `page`)',
		'its content depends on the labels the repository already has (the ten default ones), which the empty fake does not have; the page Link rule is the one recorded on comments and timelines'
	),
	// ---- create
	live(
		'create',
		'POST /issues is 201 with the issue (state open, state_reason null, updated_at equal to created_at, labels as objects, the labels it did not know are created grey)',
		'create A',
		'get A'
	),
	live('create', 'state and state_reason of a create are ignored without a word', 'create F (state ignored)'),
	live(
		'create',
		'a native type of the organization is accepted on a create (the answer carries its name); one the organization does not have is 422 invalid on type with the value',
		'create with a native type',
		'create with an unknown native type'
	),
	live(
		'create',
		'no title is 422 \'Invalid request. "title" wasn\'t supplied.\'; an empty or blank title is 422 invalid with "title can\'t be blank"',
		'create without title',
		'create with an empty title',
		'create with a blank title'
	),
	live(
		'create',
		'a title of 326 characters is accepted (no 256 limit); a body of 65537 characters is refused (422 invalid, "body is too long (maximum is 65536 characters)")',
		'create with a title of 326 characters',
		'create with a body of 65537 characters'
	),
	live(
		'create',
		'labels that is not an array is 422 with the schema message; a label of 60 characters or with a comma is 422 invalid on Label name with the value; a name given twice (any case) is 422 too; objects {name} and a leading space are accepted',
		'create with labels as a string',
		'create with a label of 60 characters',
		'create with a label with a comma',
		'create with duplicate labels',
		'create with label objects',
		'create with a label with a leading space'
	),
	live(
		'create',
		'an issue that does not exist is 404 on GET, as is a number that is not numeric',
		'get an unknown number',
		'get a non numeric number'
	),
	// ---- update
	live(
		'update',
		'PATCH title is 200 with the issue; an empty title is 422 missing_field on title; the same title changes nothing (updated_at stays equal to created_at); an empty body and an unknown parameter change nothing',
		'PATCH title',
		'PATCH an empty title',
		'PATCH the same title',
		'PATCH nothing',
		'PATCH an unknown parameter'
	),
	live(
		'update',
		'PATCH body keeps CRLF, null clears it; 65536 and 65537 characters are both accepted on an update',
		'PATCH body',
		'PATCH body with CRLF',
		'PATCH body null',
		'PATCH body of 65536 characters',
		'PATCH body of 65537 characters'
	),
	live(
		'update',
		'state closed closes as completed; closed again changes nothing; closed with a reason on a closed issue changes the reason (a new closed event); open reopens with state_reason reopened; open again changes nothing',
		'PATCH state closed',
		'PATCH state closed again',
		'PATCH closed with a reason',
		'PATCH state open',
		'PATCH state open again'
	),
	live(
		'update',
		'a reason alone on a closed issue is accepted without effect; a state that is neither open nor closed is ignored (200)',
		'PATCH a reason alone on a closed issue',
		'PATCH state with a bad value'
	),
	live(
		'update',
		'an unknown state_reason is 422 "Please specify a valid state reason."; state_reason duplicate with duplicate_issue_id closes as duplicate (the target is never served, it gets a marked_as_duplicate event); an unknown duplicate_issue_id is 422 "Issue not found for duplicate_issue_id."',
		'PATCH state_reason with a bad value',
		'PATCH close as duplicate',
		'PATCH duplicate of an unknown issue'
	),
	live(
		'update',
		'PATCH labels replaces the set (unlabeled then labeled events at one instant); the same set changes nothing; a comma or a non array is 422; an empty array clears',
		'PATCH labels',
		'PATCH the same labels',
		'PATCH labels with a comma',
		'PATCH labels as a string',
		'PATCH labels empty'
	),
	live(
		'update',
		'one PATCH that changes the state, the labels and the title is one 200 with all of it',
		'PATCH state, labels and title in one request',
		'PATCH state open and labels'
	),
	live(
		'update',
		'PATCH type adds, changes and clears (null) the native type (issue_type_added / changed / removed events); an unknown type is 422 invalid on type',
		'PATCH type',
		'PATCH type to another',
		'PATCH type null',
		'PATCH an unknown type'
	),
	live(
		'update',
		'PATCH of an unknown issue is 404; POST on the issue is the same call as PATCH; DELETE on the issue is no route (404)',
		'PATCH an unknown issue',
		'POST to the issue',
		'DELETE the issue over REST'
	),
	// ---- issue labels
	live(
		'issue labels',
		'POST /labels adds the missing ones and answers the whole list (200); names given again, in other cases or as objects are accepted',
		'POST labels',
		'POST labels already there',
		'POST label objects'
	),
	live(
		'issue labels',
		'a comma, 60 characters, a string or an empty array on POST /labels are 422 (the empty and string ones with the anyOf schema message)',
		'POST labels with a comma',
		'POST labels as a string',
		'POST labels empty',
		'POST labels of 60 characters'
	),
	live(
		'issue labels',
		'PUT /labels replaces the set (200, the labels of one request share one instant); a comma is 422',
		'PUT labels',
		'PUT labels with a comma'
	),
	live(
		'issue labels',
		'DELETE /labels/{name} removes one label (200 with the rest, case-insensitive, colons encoded); an absent one is 404 "Label does not exist"; DELETE /labels removes all (204); an unknown issue is 404',
		'DELETE a label of the issue',
		'DELETE a label of the issue in other case',
		'DELETE an absent label of the issue',
		'DELETE a label with a colon',
		'DELETE the colon label',
		'DELETE all labels of the issue',
		'POST labels on an unknown issue'
	),
	live(
		'issue labels',
		'a name given twice (any case) is 422 invalid on Label name with the second one as the value on a PATCH, a 500 with an empty body on a PUT, and accepted once on a POST',
		'PATCH labels with duplicates',
		'PUT labels with duplicates',
		'POST labels with duplicates'
	),
	live(
		'issue labels',
		'one POST that creates 50 or 100 new labels is a 502 {"message":"Server Error"} (the gateway timeout), with no token-expiration header',
		'POST 50 new labels',
		'POST 100 new labels'
	),
	live(
		'issue labels',
		'after the 502 of 50 new labels they are all applied (at one instant); after the 502 of 100 none is',
		'GET G after 50 new labels',
		'GET H after 100 new labels'
	),
	unverifiable(
		'issue labels',
		'an issue cannot hold more than 100 labels: the 101st is 422 "Issues cannot have more than 100 labels"',
		'measured by hand on 2026-11-08 (plan 2.2.1), not recorded: the scenario would need 101 labels (about 100 requests of 10 s each)'
	),
	// ---- comments
	live(
		'comments',
		'POST /comments is 201 with id, user, body (CRLF kept), created_at equal to updated_at; the issue counts it in `comments`',
		'POST comment',
		'POST comment with CRLF',
		'POST second comment',
		'GET the issue after the comments'
	),
	live(
		'comments',
		'an empty comment is 422 unprocessable "Body cannot be blank"; no body is 422 \'"body" wasn\'t supplied.\'; an unknown issue is 404',
		'POST comment with an empty body',
		'POST comment without body',
		'POST comment on an unknown issue'
	),
	live(
		'comments',
		'PATCH /issues/comments/{id} is 200 with a later updated_at; an empty body is 422 custom "body cannot be blank"; an unknown comment 404',
		'PATCH comment',
		'PATCH comment with an empty body',
		'PATCH an unknown comment'
	),
	live('comments', 'DELETE /issues/comments/{id} is 204; again 404', 'DELETE comment', 'DELETE a deleted comment'),
	live(
		'comments',
		'GET /comments lists them oldest first with the pages of the Link header (prev, next, last, first); an unknown issue is 404',
		'GET comments of the issue',
		'GET comments, page of 1',
		'GET comments, next page',
		'GET comments of an unknown issue'
	),
	live(
		'comments',
		'a comment of 65537 and of 262144 characters is accepted; one of 1000000 is 422 unprocessable "Body is too long (maximum is 65536 characters)"',
		'POST comment of 65537 characters',
		'POST comment of 262144 characters',
		'POST comment of 1000000 characters'
	),
	unverifiable(
		'comments',
		'the longest comment accepted is 262144 characters in the fake',
		'GitHub accepted 262144 and refused 1000000 on 2026-11-14; the limit between them was not searched (a bisection costs about 20 comments)'
	),
	unverifiable(
		'update',
		'the longest body accepted by an update; 65537 is accepted live and the fake accepts any length',
		'only 65536 and 65537 were probed; a bigger text would be a request of megabytes for nothing the strategy sends (it refuses over 65536 itself)'
	),
	// ---- sub-issues
	live(
		'sub-issues',
		'POST /sub_issues takes the numeric id of the child and is 201 with the parent; an id nobody has is 404',
		'POST sub-issue',
		'POST sub-issue with an unknown id',
		'POST sub-issue under an unknown issue'
	),
	live(
		'sub-issues',
		'a child already under the parent, or under another parent, is 422 (messages "...Sub issue may only have one parent"); replace_parent moves it; a cycle and the parent itself are 422 with their own message',
		'POST sub-issue again',
		'POST sub-issue of another parent',
		'POST sub-issue with replace_parent',
		'POST sub-issue to its own parent chain',
		'POST sub-issue to itself'
	),
	live(
		'sub-issues',
		'GET /parent is 200 with the parent or 404 "No parent issue found"; GET /sub_issues lists the children',
		'GET parent of a child',
		'GET parent of a root',
		'GET sub-issues',
		'GET sub-issues of a leaf',
		'GET sub-issues of an unknown issue'
	),
	live(
		'sub-issues',
		'the child carries parent_issue_url; the parent counts its children and the closed ones in sub_issues_summary',
		'GET a child (parent_issue_url)',
		'PATCH close a child',
		'GET the parent after a child closed',
		'POST sub-issue P of C2',
		'POST sub-issue C3 of C2'
	),
	live(
		'sub-issues',
		'DELETE /sub_issue with the id in the body is 200 with the parent; a child that is not one, or an unknown id, is 404',
		'DELETE sub-issue',
		'DELETE a sub-issue that is not one',
		'DELETE a sub-issue of an unknown id'
	),
	live(
		'sub-issues',
		'eight levels are allowed, the ninth is 422 "You cannot add more than 7 layers of sub-issues. To add a sub-issue, remove a parent issue at any level."',
		'POST sub-issue L2 under L1',
		'POST sub-issue L8 under L7',
		'POST sub-issue L9 under L8'
	),
	live(
		'sub-issues',
		'the timeline of the parent shows sub_issue_added / sub_issue_removed with the child as it is when read',
		'timeline of the parent'
	),
	unverifiable(
		'sub-issues',
		'the number of an issue given as sub_issue_id or issue_id is a 404, or a 403 "Resource not accessible" when it happens to be the id of an issue of somebody else',
		'recorded three times on 2026-11-14 with other issue numbers: sub-issue 403, 404, 403; dependency 404, 404, 403; it depends on numbers the repository does not control, so the two steps were taken out of the scenario; the fake cannot know which small ids exist and answers 404'
	),
	unverifiable(
		'sub-issues',
		'a parent cannot have more than 100 sub-issues (422, the message in the fake is a guess)',
		'the scenario would need 101 issues (about 200 requests); the limit is documented, not the message'
	),
	unverifiable(
		'sub-issues',
		'sub_issues_summary and issue_dependencies_summary in the answers of the sub-issue and dependency routes are exact',
		'they lag one to two seconds on GitHub (recorded: the steps that read them right after a change differ); the steps that carry them are compared without those two keys (ignoreKeys), and the fake can lag them on request (dependencySummaryLagReads)'
	),
	// ---- dependencies
	live(
		'dependencies',
		'POST /dependencies/blocked_by takes the numeric issue_id and is 201 with the blocked issue; again, itself and a cycle are 422 with the "Validation failed" message; an unknown id and an unknown issue are 404 (a number given as the id is 404, or a 403 when it is the id of an issue of somebody else: not stable, see the next lines)',
		'POST blocked_by',
		'POST blocked_by again',
		'POST blocked_by on itself',
		'POST blocked_by cycle',
		'POST blocked_by with an unknown id',
		'POST blocked_by on an unknown issue',
		'POST second blocked_by'
	),
	live(
		'dependencies',
		'GET /dependencies/blocked_by and /blocking list the issues; an unknown issue is 404',
		'GET blocked_by',
		'GET blocking',
		'GET blocking of a free issue',
		'GET blocked_by of an unknown issue'
	),
	live(
		'dependencies',
		'the summary counts blockers (total_blocked_by) and the open ones (blocked_by: a closed blocker stops counting)',
		'GET X after the dependencies',
		'GET Y after the dependencies',
		'PATCH close a blocker',
		'GET X with a closed blocker'
	),
	live(
		'dependencies',
		'DELETE /dependencies/blocked_by/{id} is 200 with the issue, also when the dependency is not there; an unknown id is 404',
		'DELETE blocked_by',
		'DELETE blocked_by again',
		'DELETE blocked_by of an unknown id'
	),
	live(
		'dependencies',
		'the timeline shows blocked_by_added / blocking_added with the other issue as it is when read',
		'timeline of X'
	),
	// ---- timeline and events
	live(
		'timeline',
		'timeline and events list labeled, unlabeled, renamed, closed (state_reason null for completed), reopened (state_reason reopened), marked_as_duplicate, issue_type_added / changed / removed, comments (timeline only); the labels of one request share one instant, two requests do not',
		'timeline of A',
		'events of A',
		'events of S (duplicate close)',
		'timeline of S',
		'timeline of an issue created with a type'
	),
	live(
		'timeline',
		'pages of a timeline follow the Link header (prev, next, last, first); an unknown issue is 404',
		'timeline of A, page of 3',
		'timeline of A, next page',
		'timeline of an unknown issue',
		'events of an unknown issue'
	),
	unverifiable(
		'timeline',
		'the order of the events of ONE request that changes several things (state, labels, title)',
		'GitHub orders them in an order that is not stable (recorded: unlabeled, renamed, closed, labeled; reopened, unlabeled, labeled); the fake orders title, labels, type, state; the strategy reads them by instant, never by position'
	),
	unverifiable(
		'timeline',
		'the events of a creation with labels or a type come one second after the creation',
		'the harness keeps the relation (same / later) and not the distance; measured on 2026-11-08 (plan 2.2.1)'
	),
	unverifiable(
		'timeline',
		'events of kinds the API cannot be asked for here (assigned, locked, milestoned, cross-referenced, ...) added by test code (addRawEvent)',
		'they are a test hook with no HTTP form; their shapes were listed in the plan (2.2.1, Timeline events) on 2026-11-08'
	),
	// ---- list
	live(
		'list',
		'GET /issues is newest first, open by default; state all / closed; labels is an AND of names, case-insensitive; sort=updated orders by last change; direction flips; no match is 200 []',
		'list open',
		'list all',
		'list closed',
		'list ascending',
		'list by update',
		'list with a label in other case',
		'list with two labels',
		'list with no match',
		'repository name in upper case'
	),
	live(
		'list',
		'a state that is not open, closed or all is 422 invalid on state with the value',
		'list with a bad state'
	),
	live(
		'list',
		'the pages are a cursor: next carries after=<cursor>&page=<n>, prev carries page=<n>&before=<cursor>, the last page has no next',
		'list, page of 2',
		'list, second page',
		'list, last page'
	),
	live('list', 'a deleted issue is not listed', 'list after a deletion'),
	documented(
		'list',
		'pull requests are items of the issue list (with a pull_request key)',
		'https://docs.github.com/en/rest/issues/issues#list-repository-issues',
		'creating a pull request needs a branch with a commit and the token has no pull-request permission (the search for pull requests is refused 422 for this token)'
	),
	unverifiable(
		'list',
		'a created issue is missing from the list for about 4 seconds (listLagRequests), a read by number is immediate',
		'a duration: the harness keeps no distance; measured by hand on 2026-11-08 (plan 2.2.1) and the recorded list steps wait 12 s first so they are not affected'
	),
	// ---- search
	live(
		'search',
		'GET /search/issues answers total_count, incomplete_results, items (the issues); a quoted phrase matches title words in any order, whole words only, case-insensitive; label and state qualifiers filter; no match is 200 with total_count 0',
		'search by title',
		'search with a label and a state',
		'search with words out of order',
		'search with part of a word',
		'search with no match'
	),
	live(
		'search',
		'another repository and pull requests cannot be searched (422 "The listed users and repositories cannot be searched ..."); an empty query is 422 missing on q',
		'search for pull requests',
		'search in another repository',
		'search without a query'
	),
	unverifiable(
		'search',
		'a new issue is not searchable for about 7 seconds (searchLagRequests)',
		'a duration: the harness keeps no distance; measured by hand on 2026-11-08 (found at the third poll, 3 s apart); the recorded search steps follow a 12 s wait'
	),
	// ---- graphql
	live(
		'graphql',
		'deleteIssue with the node id of an issue answers {"data":{"deleteIssue":{"clientMutationId":null}}}; afterwards the issue is 410 "This issue was deleted" on GET and PATCH, and 404 under it (comments, timeline)',
		'GraphQL deleteIssue',
		'GET a deleted issue',
		'PATCH a deleted issue',
		'POST comment on a deleted issue',
		'timeline of a deleted issue'
	),
	live(
		'graphql',
		'deleteIssue of an issue that is gone or of an id GitHub never issued answers data.deleteIssue null with a NOT_FOUND error "Could not resolve to a node with the global id of \'<id>\'." (no full stop for an id never issued)',
		'GraphQL deleteIssue again',
		'GraphQL deleteIssue of an unknown node'
	),
	unverifiable(
		'graphql',
		'any document other than deleteIssue answers an error "mock: not modelled"',
		'GitHub would execute it; the fake has no GraphQL engine and says so instead of inventing an answer'
	),
	unverifiable(
		'graphql',
		'a token that does not administer the repository gets a FORBIDDEN error on deleteIssue (admin: false)',
		'the token administers the repository; another one cannot be made from it'
	),
	// ---- repository settings and test hooks
	unverifiable(
		'repository',
		'hasIssues: false makes every issue route a 410 "Issues are disabled for this repo"',
		'disabling issues is an administration setting the token cannot change (and would break the other steps)'
	),
	unverifiable(
		'hooks',
		'failNext, dropNext, hangNext, latencyMs, setRateLimit: forced answers, dropped or hung connections, quotas',
		'faults of the network and of the server cannot be provoked on the real API; they are the way a test makes the client meet one'
	),
	unverifiable(
		'hooks',
		'the methods a test calls to change state the way a person would (addIssue, updateIssue, addComment, setParent, addBlockedBy, deleteIssue, ...) and the fake clock (clockStepMs, 5 s by default)',
		'they are not HTTP behaviour: they build the state the HTTP routes are then asked about; the instants GitHub gives have the resolution of a second, the fake moves 5 s per change so that two changes differ'
	),
];
