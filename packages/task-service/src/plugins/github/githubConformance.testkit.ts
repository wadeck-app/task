// The conformance harness that keeps the local GitHub fake (fakeGitHub.testkit.ts) honest. A FIXTURE is a scripted sequence of requests
// that `scripts/live-github-probe.mjs scenario --record` ran against the REAL api.github.com (a throwaway repository) and recorded:
// per step the request, the variables to keep from the answer, and the SANITIZED answer (status, key headers, body). `replayFixture`
// runs the same requests against another server (the fake) and reports every difference. Nothing here talks to the real GitHub.
// Modelled on gitlabConformance.testkit.ts.
//
// SANITIZING (applied by BOTH sides, so the recorded and the replayed answers are compared in the same normal form):
//   - ids are volatile: numeric fields named `id`, `number` or `*_id` become "<n>"; `node_id` becomes "<node>"; digits in URLs and
//     `#12` references too;
//   - instants (ISO date-times) become "<time>"; an object with `created_at` and `updated_at` keeps how they relate (`updated_at` is
//     "<time same>" or "<time later>"); the items of an event list keep how each relates to the previous one ("<time same>",
//     "<time later>", "<time earlier>"): the fake and GitHub do not wait the same time between two requests, only the relation is
//     part of the contract;
//   - user objects (user, actor, ...) become "<user>" (no personal data in a fixture);
//   - the API root and the web root become "<api>" and "<web>"; the repository path stays (the repository is disposable);
//   - the token never appears in a fixture (the recorder redacts it before anything is stored);
//   - a string longer than LONG_TEXT characters (a 65537 character body) becomes "<string of N characters>", so the fixture stays
//     small and the length is still compared exactly.
// BIG REQUESTS: a body value {"$repeat": ["d", 65537]} (or ["d", 239, "prefix "]: the prefix goes first and counts) is expanded by
// `substitute` into that string, in the recorded scenario and in the replay alike, so the fixture does not hold the big text.
// WHAT IS COMPARED: the real answer carries many fields the strategy never reads (reactions, *_url, performed_via_github_app...). A key
// the FAKE sends must equal the real one; a key only the REAL answer has is a failure unless it is listed in REAL_ONLY_KEYS (the
// fields the strategy never reads, with the reason) or the step is flagged `subset` (an endpoint whose answer is huge and of which the
// fake models a few fields: /user, the repository, /rate_limit). So the fake can never claim something GitHub does not, and every
// field the strategy reads is in the fake.
import * as http from 'node:http';

export interface ConformanceRequest {
	method: string;
	/** Relative to the API root, `{{var}}` placeholders allowed (`repos/{{repo}}/issues/{{a}}`); an absolute URL is used as is. */
	path: string;
	body?: unknown;
	/** A body sent as is (no JSON encoding), with the `content-type` it needs in `headers`. */
	rawBody?: string;
	headers?: Record<string, string>;
	/** `token` (default, `Authorization: Bearer`), `none` (no credentials) or `bad` (a token GitHub does not know). */
	auth?: 'token' | 'none' | 'bad';
}

export interface ConformanceStep {
	name: string;
	request: ConformanceRequest;
	/** Variable name -> dotted path in the JSON answer (`number`, `0.id`, `data.deleteIssue.clientMutationId`). */
	save?: Record<string, string>;
	/** Variable name -> header name. */
	saveHeaders?: Record<string, string>;
	/** Variable name -> `rel` of the Link header whose URL is kept (`next`). */
	saveLinks?: Record<string, string>;
	/** Milliseconds the recorder waited before sending (an index that lags); the replay does not wait. */
	wait?: number;
	/** Body keys (at any depth) left out of the comparison on both sides: a value that lags by a second on the real API. */
	ignoreKeys?: string[];
	/** Only the keys the fake sends are compared (an endpoint the fake models in part). */
	subset?: boolean;
	expect: { status: number; headers: Record<string, string>; body: unknown };
}

export interface ConformanceFixture {
	format: 1;
	/** Date of the live run, `YYYY-MM-DD`. */
	recordedAt: string;
	source: string;
	steps: ConformanceStep[];
}

export interface NormalizeContext {
	/** The random suffix of this run's titles and labels. */
	run: string;
	/** `https://api.github.com` or `http://127.0.0.1:1234`. */
	apiBase: string;
}

/** Headers compared (lower case). Everything else GitHub sends (cache-control, vary, security headers) is not part of the contract. */
export const KEY_HEADERS: readonly string[] = [
	'etag',
	'link',
	'retry-after',
	'x-ratelimit-limit',
	'x-ratelimit-remaining',
	'x-ratelimit-reset',
	'x-ratelimit-resource',
	'x-ratelimit-used',
	'github-authentication-token-expiration',
	'x-accepted-github-permissions',
	'content-type',
];

/** Compared only when the fake sends them (GitHub sends `x-accepted-github-permissions` on every answer; the fake on a refusal). */
export const OPTIONAL_HEADERS: readonly string[] = ['x-accepted-github-permissions'];

/** A string longer than this is replaced by its length in a normalized answer. */
export const LONG_TEXT = 200;

/** The most characters one `$repeat` may produce (a typo must not allocate gigabytes). */
const REPEAT_MAX = 2_000_000;

/**
 * Keys of a real answer the strategy never reads and the fake does not send: allowed to be missing from the fake. Everything the
 * strategy reads is NOT here (see ApiIssue, ApiComment and ApiEvent in issueMapping.ts), so the fake must have it.
 */
export const REAL_ONLY_KEYS: ReadonlySet<string> = new Set([
	// urls of related resources
	'labels_url',
	'comments_url',
	'events_url',
	'timeline_url',
	'html_url',
	'issue_url',
	'repository_url',
	// who and what else
	'assignee',
	'assignees',
	'milestone',
	'closed_by',
	'author_association',
	'active_lock_reason',
	'locked',
	'draft',
	'reactions',
	'performed_via_github_app',
	'pinned_comment',
	'issue_field_values',
	'parent_issue_id',
	// events
	'commit_id',
	'commit_url',
	'archived_at',
	'archived_by',
	// comments and events
	'pin',
	'minimized',
	'intent',
	'search_type',
	// the whole repository object of an issue answered by the sub-issue and dependency routes, and the type of a referenced issue
	'repository',
	'issue_type',
	'node_id',
	'score',
	'text_matches',
	'url',
]);

const USER_KEYS = new Set(['user', 'actor', 'author', 'closed_by', 'assignee', 'sender', 'owner']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ID_KEY = /(^|_)(id|ids|number)$/;
// The counters of /rate_limit move with every request.
const COUNTER_KEY = /^(remaining|used|reset)$/;

function normalizeText(text: string, ctx: NormalizeContext): string {
	let out = text;
	if (ctx.run !== '') out = out.split(ctx.run).join('{{run}}');
	out = out.split(ctx.apiBase).join('<api>').split('https://github.com').join('<web>');
	// The address of the caller in a rate-limit message.
	out = out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>');
	// References to issues in messages.
	out = out.replace(/#\d+/g, '#N');
	// A url (or a url inside a sentence): its numbers are volatile ids.
	out = out.replace(/(<web>|<api>)\S*/g, url => url.replace(/\d+/g, 'N'));
	// GraphQL node ids in a message (`I_kwDO...`) are opaque.
	out = out.replace(/\bI_kw[\w-]+/g, '<node>');
	return out;
}

/** Idempotent: the replacement is short, so a second pass leaves it alone. */
function normalizeLong(text: string): string {
	return text.length > LONG_TEXT ? `<string of ${text.length} characters>` : text;
}

const isIso = (value: unknown): value is string => typeof value === 'string' && ISO.test(value);

/** The relation of `at` to `before` as a placeholder. */
function relation(before: string, at: string, prefix = '<time'): string {
	const a = Date.parse(before);
	const b = Date.parse(at);
	return `${prefix} ${b === a ? 'same' : b > a ? 'later' : 'earlier'}>`;
}

/** The items of an event list keep how each instant relates to the previous one; the first one is `<time>`. */
function relativeEvents(raw: unknown[], normalized: unknown[]): unknown[] {
	const stamp = (item: unknown): string | undefined => {
		if (item === null || typeof item !== 'object') return undefined;
		const record = item as Record<string, unknown>;
		return typeof record['event'] === 'string' && isIso(record['created_at']) ? record['created_at'] : undefined;
	};
	if (raw.length < 2 || raw.some(item => stamp(item) === undefined)) return normalized;
	return normalized.map((item, index) =>
		index === 0
			? item
			: { ...(item as Record<string, unknown>), created_at: relation(stamp(raw[index - 1])!, stamp(raw[index])!) }
	);
}

/** The normal form of a JSON answer (see the header of this file). */
export function normalizeBody(value: unknown, ctx: NormalizeContext, key = ''): unknown {
	if (value === null || value === undefined) return value ?? null;
	if (typeof value === 'number') return ID_KEY.test(key) || COUNTER_KEY.test(key) ? '<n>' : value;
	if (typeof value === 'string') {
		if (ISO.test(value)) return '<time>';
		if (key === 'node_id') return '<node>';
		// The login of a user object that is not under a user key (GET /user).
		if (key === 'login') return '<user>';
		// The page of the documentation depends on the endpoint; that an error carries one is the contract.
		if (key === 'documentation_url') return '<docs>';
		return normalizeLong(normalizeText(value, ctx));
	}
	if (typeof value !== 'object') return value;
	// GraphQL error positions depend on the text of the document, not on the server.
	if (key === 'locations') return '<loc>';
	if (Array.isArray(value))
		return relativeEvents(
			value,
			value.map(item => normalizeBody(item, ctx, key))
		);
	if (USER_KEYS.has(key) && key !== '') return '<user>';
	// A native issue type: the strategy reads its name only (the organization's description, colour and dates are not ours).
	if (
		(key === 'type' || key === 'issue_type' || key === 'prev_issue_type') &&
		typeof (value as Record<string, unknown>)['name'] === 'string'
	)
		return { name: (value as Record<string, unknown>)['name'] };
	const record = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(record)) {
		// `updated_at` keeps its relation to `created_at` of the same object (a PATCH that changes nothing leaves them equal).
		if (k === 'updated_at' && isIso(v) && isIso(record['created_at'])) out[k] = relation(record['created_at'], v);
		else out[k] = normalizeBody(v, ctx, k);
	}
	return out;
}

/** The normal form of the key headers of an answer. Absent headers are absent from the result. */
export function normalizeHeaders(
	get: (name: string) => string | null | undefined,
	ctx: NormalizeContext
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of KEY_HEADERS) {
		const raw = get(name);
		if (raw === null || raw === undefined) continue;
		let value = raw;
		if (name === 'etag') value = raw.replace(/^W\//, '').replace(/"[0-9a-f-]+"/, '"<hash>"');
		else if (
			name === 'x-ratelimit-remaining' ||
			name === 'x-ratelimit-reset' ||
			name === 'x-ratelimit-used' ||
			name === 'retry-after'
		)
			value = '<n>';
		else if (name === 'github-authentication-token-expiration') value = '<expiration>';
		else if (name === 'link') {
			// The links echo the path as GitHub writes it (`/repositories/<id>/issues`, the fake `/repos/<owner>/<name>/issues`): both
			// are the same resource, and the strategy follows the URL verbatim. Page numbers and the other parameters are part of
			// the contract, the opaque cursors are not.
			// GitHub also announces the deprecation of the API version on writes (rel="deprecation"): not part of the contract.
			value = normalizeText(raw, ctx)
				.split(/,s*(?=<)/)
				.filter(part => !/rel="deprecation"/.test(part))
				.join(', ')
				.replace(/\/repositories\/(?:\d+|N)\//g, '/repo/')
				.replace(/\/repos\/[^/]+\/[^/]+\//g, '/repo/')
				.replace(/(after|before)=(?:<cursor>|[^&>]*)/g, '$1=<cursor>');
		}
		if (name === 'link' && value === '') continue;
		out[name] = value;
	}
	return out;
}

/**
 * Expands `{"$repeat": [unit, count]}` or `{"$repeat": [unit, count, prefix]}` into `prefix + unit x count`; undefined when the object
 * is anything else. A malformed `$repeat` throws: a scenario that asks for a big text must get exactly that text.
 */
function expandRepeat(value: object, vars: Readonly<Record<string, string>>): string | undefined {
	const keys = Object.keys(value);
	if (keys.length !== 1 || keys[0] !== '$repeat') return undefined;
	const spec = (value as { $repeat: unknown }).$repeat;
	if (
		!Array.isArray(spec) ||
		(spec.length !== 2 && spec.length !== 3) ||
		typeof spec[0] !== 'string' ||
		spec[0] === '' ||
		!Number.isInteger(spec[1]) ||
		(spec[1] as number) < 0 ||
		(spec[1] as number) > REPEAT_MAX ||
		(spec.length === 3 && typeof spec[2] !== 'string')
	)
		throw new Error(
			`conformance: "$repeat" must be [unit, count] or [unit, count, prefix] (unit a non empty string, count an integer 0..${REPEAT_MAX}), got ${JSON.stringify(spec)}`
		);
	const prefix = spec.length === 3 ? substitute(spec[2] as string, vars) : '';
	return prefix + spec[0].repeat(spec[1] as number);
}

/**
 * Replaces `{{name}}` (text) and `{{name:n}}` (a number when the whole string is that placeholder), and expands `$repeat` objects
 * (see the header).
 */
export function substitute<T>(value: T, vars: Readonly<Record<string, string>>): T {
	if (typeof value === 'string') {
		const whole = /^\{\{(\w+):n\}\}$/.exec(value);
		if (whole !== null) {
			const found = vars[whole[1]!];
			if (found === undefined) throw new Error(`conformance: variable "${whole[1]}" is not set`);
			return Number(found) as T;
		}
		return value.replace(/\{\{(\w+)\}\}/g, (_all, name: string) => {
			const found = vars[name];
			if (found === undefined) throw new Error(`conformance: variable "${name}" is not set`);
			return found;
		}) as T;
	}
	if (Array.isArray(value)) return value.map(item => substitute(item, vars)) as T;
	if (value !== null && typeof value === 'object') {
		const repeated = expandRepeat(value, vars);
		if (repeated !== undefined) return repeated as T;
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)])) as T;
	}
	return value;
}

export function pick(json: unknown, dotted: string): unknown {
	let at: unknown = json;
	for (const part of dotted.split('.')) {
		if (at === null || typeof at !== 'object') return undefined;
		at = (at as Record<string, unknown>)[part];
	}
	return at;
}

/** The URL of the Link header entry with this `rel`, or undefined. */
export function linkOf(header: string | undefined, rel: string): string | undefined {
	if (header === undefined) return undefined;
	for (const part of header.split(/,\s*(?=<)/)) {
		const match = /^<([^>]+)>;\s*rel="([^"]+)"/.exec(part.trim());
		if (match !== null && match[2] === rel) return match[1];
	}
	return undefined;
}

export interface RawAnswer {
	status: number;
	headers: Record<string, string>;
	text: string;
	json: unknown;
}

/** One HTTP exchange with node:http (the fake is plain http, and no library adds headers of its own). */
export async function exchange(
	apiBase: string,
	token: string,
	request: ConformanceRequest,
	vars: Readonly<Record<string, string>>
): Promise<RawAnswer> {
	const path = substitute(request.path, vars);
	const url = new URL(path.startsWith('http') ? path : `${apiBase}/${path}`);
	const headers: Record<string, string> = {
		'user-agent': 'task-conformance',
		accept: 'application/vnd.github+json',
		'x-github-api-version': '2022-11-28',
		...(request.headers === undefined ? {} : substitute(request.headers, vars)),
	};
	if (request.auth === 'bad') headers['authorization'] = 'Bearer github_pat_xxxxxxxxxxxxxxxxxxxxxxxx';
	else if (request.auth !== 'none') headers['authorization'] = `Bearer ${token}`;
	let payload: string | undefined;
	if (request.rawBody !== undefined) payload = substitute(request.rawBody, vars);
	else if (request.body !== undefined) {
		payload = JSON.stringify(substitute(request.body, vars));
		headers['content-type'] ??= 'application/json';
	}
	if (payload !== undefined) headers['content-length'] = String(Buffer.byteLength(payload));
	return await new Promise<RawAnswer>((resolve, reject) => {
		const req = http.request(url, { method: request.method, headers }, res => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8');
				const out: Record<string, string> = {};
				for (const [k, v] of Object.entries(res.headers))
					if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
				let json: unknown;
				try {
					json = text === '' ? undefined : JSON.parse(text);
				} catch {
					json = undefined;
				}
				resolve({ status: res.statusCode ?? 0, headers: out, text, json });
			});
		});
		req.on('error', reject);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

export interface StepOutcome {
	name: string;
	problems: string[];
	actual: { status: number; headers: Record<string, string>; body: unknown };
}

interface DiffOptions {
	subset: boolean;
	ignoreKeys: ReadonlySet<string>;
}

/** Differences of the fake (`actual`) from the recording (`expected`), at most a dozen. */
function diff(path: string, expected: unknown, actual: unknown, out: string[], options: DiffOptions, key = ''): void {
	if (out.length >= 12) return;
	if (options.ignoreKeys.has(key)) return;
	if (JSON.stringify(expected) === JSON.stringify(actual)) return;
	// A recording made with plain `<time>` where the fake says `<time same>`, `<time later>`...
	if (expected === '<time>' && typeof actual === 'string' && actual.startsWith('<time ')) return;
	// The events of one request share a second, unless the request straddles two seconds: a live `later` is then accepted for a `same`.
	if (key === 'created_at' && expected === '<time later>' && actual === '<time same>') return;
	if (
		expected !== null &&
		actual !== null &&
		typeof expected === 'object' &&
		typeof actual === 'object' &&
		Array.isArray(expected) === Array.isArray(actual)
	) {
		const e = expected as Record<string, unknown>;
		const a = actual as Record<string, unknown>;
		const keys = new Set([...Object.keys(e), ...Object.keys(a)]);
		for (const k of keys) {
			const inLive = k in e;
			const inMock = k in a;
			if (!Array.isArray(expected) && inLive && !inMock) {
				// Only the real answer has it: fine when the strategy never reads it, or the step compares the fake's keys only.
				if (options.subset || REAL_ONLY_KEYS.has(k)) continue;
			}
			// `repository` inside an event or a sub-issue is the whole repository object of GitHub; the fake sends its identity.
			diff(`${path}.${k}`, e[k], a[k], out, k === 'repository' ? { ...options, subset: true } : options, k);
		}
		return;
	}
	out.push(`${path}: live ${JSON.stringify(expected)} but mock ${JSON.stringify(actual)}`);
}

export function normalizeAnswer(
	answer: RawAnswer,
	ctx: NormalizeContext
): { status: number; headers: Record<string, string>; body: unknown } {
	return {
		status: answer.status,
		headers: normalizeHeaders(name => answer.headers[name], ctx),
		// An empty answer (204, 304) is null; a non-JSON answer is compared as text.
		body:
			answer.json === undefined
				? answer.text === ''
					? null
					: normalizeLong(normalizeText(answer.text, ctx))
				: normalizeBody(answer.json, ctx),
	};
}

/**
 * The variables every scenario starts with (the recorder builds the same ones): `repo` (`owner/name`), `repoU` (the same in upper case:
 * GitHub ignores the case of a repository) and `run`.
 */
export function scenarioVariables(repo: string, run: string): Record<string, string> {
	return { repo, repoU: repo.toUpperCase(), run };
}

/** Runs the fixture against `apiBase` and returns one outcome per step (problems empty = the fake agrees with the recording). */
export async function replayFixture(
	fixture: ConformanceFixture,
	options: { apiBase: string; token: string; repo: string; run: string }
): Promise<StepOutcome[]> {
	const vars: Record<string, string> = scenarioVariables(options.repo, options.run);
	const ctx: NormalizeContext = { run: options.run, apiBase: options.apiBase };
	const outcomes: StepOutcome[] = [];
	for (const step of fixture.steps) {
		let answer: RawAnswer;
		try {
			answer = await exchange(options.apiBase, options.token, step.request, vars);
		} catch (error) {
			// A step that cannot even be sent (a variable an earlier failed step should have saved) is a problem, not a crash.
			outcomes.push({
				name: step.name,
				problems: [`not sent: ${(error as Error).message}`],
				actual: { status: 0, headers: {}, body: null },
			});
			continue;
		}
		const actual = normalizeAnswer(answer, ctx);
		const problems: string[] = [];
		if (actual.status !== step.expect.status)
			problems.push(
				`status: live ${step.expect.status} but mock ${actual.status} (${actual.body === null ? '' : JSON.stringify(actual.body).slice(0, 200)})`
			);
		else {
			// The recorded headers and body are normalized again with the current rules, so a rule can change without a new live run.
			const expectedHeaders = normalizeHeaders(name => step.expect.headers[name], {
				run: '',
				apiBase: options.apiBase,
			});
			const names = new Set([...Object.keys(expectedHeaders), ...Object.keys(actual.headers)]);
			for (const name of names) {
				if (OPTIONAL_HEADERS.includes(name) && actual.headers[name] === undefined) continue;
				if (expectedHeaders[name] !== actual.headers[name])
					problems.push(
						`header ${name}: live ${JSON.stringify(expectedHeaders[name])} but mock ${JSON.stringify(actual.headers[name])}`
					);
			}
			diff(
				'body',
				normalizeBody(step.expect.body, { run: '', apiBase: options.apiBase }),
				actual.body,
				problems,
				{ subset: step.subset === true, ignoreKeys: new Set(step.ignoreKeys ?? []) }
			);
		}
		// A step the live GitHub refused saved nothing there either.
		for (const [name, dotted] of Object.entries(step.expect.status >= 400 ? {} : (step.save ?? {}))) {
			const found = pick(answer.json, dotted);
			if (found === undefined || found === null)
				problems.push(`save ${name}: no value at "${dotted}" in the mock answer`);
			else vars[name] = String(found);
		}
		for (const [name, header] of Object.entries(step.saveHeaders ?? {})) {
			const found = answer.headers[header];
			if (found === undefined) problems.push(`save ${name}: the mock sent no ${header} header`);
			else vars[name] = found;
		}
		for (const [name, rel] of Object.entries(step.saveLinks ?? {})) {
			const found = linkOf(answer.headers['link'], rel);
			if (found === undefined) problems.push(`save ${name}: the mock sent no Link with rel="${rel}"`);
			else vars[name] = found;
		}
		outcomes.push({ name: step.name, problems, actual });
	}
	return outcomes;
}
