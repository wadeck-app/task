// The conformance harness that keeps the local GitLab mock (fakeGitLab.testkit.ts) honest. A FIXTURE is a scripted sequence of requests
// that `scripts/live-gitlab-probe.mjs scenario --record` ran against the REAL gitlab.com (Free tier) and recorded: per step the request,
// the variables to keep from the answer, and the SANITIZED answer (status, key headers, body). `replayFixture` runs the same requests
// against another server (the mock) and reports every difference. Nothing here talks to the real GitLab.
//
// SANITIZING (applied by BOTH sides, so the recorded and the replayed answers are compared in the same normal form):
//   - ids are volatile: any numeric field named `id`, `iid` or `*_id`/`*_iid` becomes "<n>"; digits in URLs and `#12` references too;
//   - instants (ISO date-times) become "<time>"; the run suffix of a title becomes "{{run}}";
//   - user objects (author, closed_by, user, ...) become "<user>" (no personal data in a fixture);
//   - the API root and the web root of the server become "<api>" and "<web>"; the project path stays (the project is disposable);
//   - the token never appears in a fixture (the recorder redacts it before anything is stored);
//   - a string longer than LONG_TEXT (200) characters (a 1 MiB description, a 255 character title) becomes "<string of N characters>", so the
//     fixture stays small and the length is still compared exactly (N is counted after the run suffix is normalized).
// BIG REQUESTS: a body value {"$repeat": ["d", 1048577]} (or ["d", 239, "prefix "]: the prefix goes first and counts) is expanded by
// `substitute` into that string, in the recorded scenario and in the replay alike, so the fixture does not hold the big text.
// Headers: only the KEY headers the strategy depends on are compared, with their volatile parts normalized.
import * as http from 'node:http';

export interface ConformanceRequest {
	method: string;
	/** Relative to the API root, `{{var}}` placeholders allowed (`projects/{{P}}/issues/{{a}}`). */
	path: string;
	body?: unknown;
	/** A body sent as is (no JSON encoding), with the `content-type` it needs in `headers`. */
	rawBody?: string;
	headers?: Record<string, string>;
	/** `token` (default, `PRIVATE-TOKEN`), `bearer` (`Authorization: Bearer`), `none` (no credentials) or `bad` (a token GitLab does not know). */
	auth?: 'token' | 'bearer' | 'none' | 'bad';
}

export interface ConformanceStep {
	name: string;
	request: ConformanceRequest;
	/** Variable name -> dotted path in the JSON answer (`iid`, `0.id`, `data.workItemUpdate.workItem.id`). */
	save?: Record<string, string>;
	/** Variable name -> header name. */
	saveHeaders?: Record<string, string>;
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
	/** `https://gitlab.com/api/v4` or `http://127.0.0.1:1234/api/v4`. */
	apiBase: string;
}

/** Headers compared (lower case). Everything else GitLab sends (cloudflare, security headers, cookies) is not part of the contract. */
export const KEY_HEADERS: readonly string[] = [
	'etag',
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
	'cache-control',
	'x-gitlab-meta',
];

/** A string longer than this is replaced by its length in a normalized answer. */
export const LONG_TEXT = 200;

/** The most characters one `$repeat` may produce (a typo must not allocate gigabytes). */
const REPEAT_MAX = 5_000_000;

const USER_KEYS = new Set(['author', 'closed_by', 'user', 'assignee', 'created_by', 'updated_by', 'merged_by']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ID_KEY = /(^|_)(id|iid|ids)$/;

function normalizeText(text: string, ctx: NormalizeContext): string {
	let out = text;
	if (ctx.run !== '') out = out.split(ctx.run).join('{{run}}');
	const web = ctx.apiBase.replace(/\/api\/v4$/, '');
	out = out.split(ctx.apiBase).join('<api>').split(web).join('<web>');
	// GraphQL global ids: the type name stays, the number goes (work item TYPE ids are fixed constants and stay).
	out = out.replace(/(gid:\/\/gitlab\/(?!WorkItems::Type)[\w:]+\/)\d+/g, '$1N');
	// Ruby object addresses in messages (`#<GlobalID:0x00007ba7129ead88 ...>`) change at every request.
	out = out.replace(/0x[0-9a-f]{8,16}/g, '0xN');
	// References to issues in messages and system notes.
	out = out.replace(/#\d+/g, '#N');
	// A url inside a text ("... a duplicate of <web>/group/project/-/work_items/102"): its numbers are volatile ids.
	out = out.replace(/(<web>|<api>)\S*/g, url => url.replace(/\d+/g, 'N'));
	// Digits inside a URL (project id, issue iid, link id).
	if (/^https?:|^<api>|^<web>/.test(out)) out = out.replace(/\d+/g, 'N');
	return out;
}

/** Idempotent: the replacement is short, so a second pass leaves it alone. */
function normalizeLong(text: string): string {
	return text.length > LONG_TEXT ? `<string of ${text.length} characters>` : text;
}

/**
 * The events of one answer (items with a resource_type and a created_at) keep how their instants relate: the first one is `<time>`, each
 * next one is `<time same>` (the same instant as the previous event), `<time later>` or `<time earlier>`. Only the relation is kept,
 * never the distance, because the mock and GitLab do not wait the same time between two requests. This proves "the label events of one
 * PUT share one instant" and "two PUTs have distinct, increasing instants". A recording made before this rule holds `<time>` for every
 * event: `diff` accepts `<time>` as a wildcard for any of the forms.
 */
function relativeInstants(raw: unknown[], normalized: unknown[]): unknown[] {
	const stamp = (item: unknown): string | undefined => {
		if (item === null || typeof item !== 'object') return undefined;
		const record = item as Record<string, unknown>;
		const at = record['created_at'];
		return typeof record['resource_type'] === 'string' && typeof at === 'string' && ISO.test(at) ? at : undefined;
	};
	if (raw.length < 2 || raw.some(item => stamp(item) === undefined)) return normalized;
	return normalized.map((item, index) => {
		if (index === 0) return item;
		const before = Date.parse(stamp(raw[index - 1])!);
		const now = Date.parse(stamp(raw[index])!);
		const relation = now === before ? 'same' : now > before ? 'later' : 'earlier';
		return { ...(item as Record<string, unknown>), created_at: `<time ${relation}>` };
	});
}

/** The normal form of a JSON answer (see the header of this file). */
export function normalizeBody(value: unknown, ctx: NormalizeContext, key = ''): unknown {
	if (value === null || value === undefined) return value ?? null;
	if (typeof value === 'number') return ID_KEY.test(key) ? '<n>' : value;
	if (typeof value === 'string') {
		if (ISO.test(value)) return '<time>';
		// GraphQL sends iids as strings.
		if (ID_KEY.test(key) && /^\d+$/.test(value)) return '<n>';
		return normalizeLong(normalizeText(value, ctx));
	}
	if (typeof value !== 'object') return value;
	// GraphQL error positions depend on the text of the document, not on the server.
	if (key === 'locations') return '<loc>';
	if (Array.isArray(value))
		return relativeInstants(
			value,
			value.map(item => normalizeBody(item, ctx, key))
		);
	if (USER_KEYS.has(key) && key !== '') return '<user>';
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalizeBody(v, ctx, k);
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
		if (name === 'etag') value = raw.replace(/"[0-9a-f]{32}"/, '"<hash>"');
		else if (
			name === 'ratelimit-observed' ||
			name === 'ratelimit-remaining' ||
			name === 'ratelimit-reset' ||
			name === 'retry-after'
		)
			value = '<n>';
		else if (name === 'ratelimit-resettime') value = '<time>';
		else if (name === 'x-gitlab-meta') value = value.replace(/"correlation_id":"[^"]*"/, '"correlation_id":"<id>"');
		else if (name === 'link') {
			// The links echo the project as the request wrote it; page numbers and the other parameters are part of the contract.
			// The iids they carry (`issues/55`, `eventable_id=55`, `noteable_id=55`, `iids[]=63`) depend on how many issues the
			// recorded project already held, not on the server: normalized like the iids of a body.
			value = normalizeText(raw, ctx)
				.replace(/projects\/\d+\//g, 'projects/N/')
				.replace(/(issues\/|eventable_id=|noteable_id=|iids%5B%5D=|[?&]id=)\d+/g, '$1N')
				// The opaque cursor of a keyset page changes at every request.
				.replace(/cursor=[^&>]*/g, 'cursor=<cursor>');
		}
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

export interface RawAnswer {
	status: number;
	headers: Record<string, string>;
	text: string;
	json: unknown;
}

/** One HTTP exchange with node:http (no fetch: undici adds headers and follows nothing, and the mock is plain http). */
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
		...(request.headers === undefined ? {} : substitute(request.headers, vars)),
	};
	if (request.auth === 'bad') headers['private-token'] = 'glpat-xxxxxxxxxxxxxxxxxxxx';
	else if (request.auth === 'bearer') headers['authorization'] = `Bearer ${token}`;
	else if (request.auth !== 'none') headers['private-token'] = token;
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

function diff(path: string, expected: unknown, actual: unknown, out: string[]): void {
	if (out.length >= 12) return;
	if (JSON.stringify(expected) === JSON.stringify(actual)) return;
	// A recording made before the relative instants holds `<time>` where the mock now says `<time same>`, `<time later>`...
	if (expected === '<time>' && typeof actual === 'string' && actual.startsWith('<time ')) return;
	if (
		expected !== null &&
		actual !== null &&
		typeof expected === 'object' &&
		typeof actual === 'object' &&
		Array.isArray(expected) === Array.isArray(actual)
	) {
		const keys = new Set([...Object.keys(expected as object), ...Object.keys(actual as object)]);
		for (const key of keys)
			diff(
				`${path}.${key}`,
				(expected as Record<string, unknown>)[key],
				(actual as Record<string, unknown>)[key],
				out
			);
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
		// A non-JSON answer (the plain text of a 429) is compared as text.
		body:
			answer.json === undefined
				? normalizeLong(normalizeText(answer.text, ctx))
				: normalizeBody(answer.json, ctx),
	};
}

/**
 * The variables every scenario starts with (the recorder builds the same ones): \`P\` the encoded project path, \`PU\` the same in upper
 * case (a case probe), \`projectPath\`, \`group\` (the namespace of the project, '' for a project at the root) and \`run\`.
 */
export function scenarioVariables(projectPath: string, run: string): Record<string, string> {
	return {
		P: encodeURIComponent(projectPath),
		PU: encodeURIComponent(projectPath.toUpperCase()),
		projectPath,
		group: projectPath.split('/').slice(0, -1).join('/'),
		run,
	};
}

/**
 * Steps whose answer depends on how many issues the LIVE project held at the time (an unfiltered list of the whole project): the headers
 * that count them cannot be reproduced by a mock that starts empty. Everything else of those steps is still compared.
 */
export const SIZE_DEPENDENT_STEPS: Readonly<Record<string, readonly string[]>> = {
	'bearer token': ['x-total', 'x-total-pages', 'link'],
	'list with the project path in upper case': ['x-total', 'x-total-pages', 'link'],
	'list with the numeric project id': ['x-total', 'x-total-pages', 'link'],
};

/** Runs the fixture against `apiBase` and returns one outcome per step (problems empty = the mock agrees with the recording). */
export async function replayFixture(
	fixture: ConformanceFixture,
	options: { apiBase: string; token: string; projectPath: string; run: string }
): Promise<StepOutcome[]> {
	const vars: Record<string, string> = scenarioVariables(options.projectPath, options.run);
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
				`status: live ${step.expect.status} but mock ${actual.status} (${actual.body === null ? '' : JSON.stringify(actual.body).slice(0, 160)})`
			);
		else {
			// Like the body, the recorded headers are normalized again with the current rules (the iids of the recorded Link headers).
			const expectedHeaders = normalizeHeaders(name => step.expect.headers[name], {
				run: '',
				apiBase: options.apiBase,
			});
			const names = new Set([...Object.keys(expectedHeaders), ...Object.keys(actual.headers)]);
			for (const name of names) {
				if (SIZE_DEPENDENT_STEPS[step.name]?.includes(name) === true) continue;
				if (expectedHeaders[name] !== actual.headers[name])
					problems.push(
						`header ${name}: live ${JSON.stringify(expectedHeaders[name])} but mock ${JSON.stringify(actual.headers[name])}`
					);
			}
			// The recording is normalized again with the current rules, so a rule can change without a new live run.
			diff('body', normalizeBody(step.expect.body, { run: '', apiBase: options.apiBase }), actual.body, problems);
		}
		// A step the live GitLab refused saved nothing there either (the scenario asked for a variable the answer did not have).
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
		outcomes.push({ name: step.name, problems, actual });
	}
	return outcomes;
}
