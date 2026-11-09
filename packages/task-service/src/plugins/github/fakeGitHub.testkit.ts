// A fake GitHub REST server for tests: node:http on a free loopback port, state in memory, the subset of endpoints the github
// strategy uses, with the behaviours measured on the real API (design 2.2.1 and the live smoke runs): ETag and 304 without
// spending the quota, Link pagination (a cursor on the issue list, `page` elsewhere), rate-limit headers, 401 / 403 / 404 / 410 / 422,
// sub-issues, dependencies, the timeline, comments, labels, and the search index that lags behind a write.
//
// Writes (stage 2) follow what the real API did when the strategy was run against it: `state` / `state_reason` of a create are
// ignored, `If-Match` is a 400, labels are at most 50 characters and 100 per issue, a POST that creates 50 or more labels answers 502,
// a sub-issue is added by numeric id and has one parent, dependencies refuse duplicates and cycles, `duplicate_issue_id` is write-only,
// comments and label changes bump `updated_at`. Every request is recorded in `requests` (with its instant), so a test asserts what was
// sent. State can also be changed through the methods of the class (the way a person would on GitHub).
// Test-only: nothing in the shipped code imports this file.
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeComment {
	id: number;
	user: string;
	body: string;
	createdAt: string;
	updatedAt: string;
}

export interface FakeEvent {
	id: number;
	event: string;
	createdAt: string;
	actor: string;
	extra: Record<string, unknown>;
}

export interface FakeIssue {
	id: number;
	number: number;
	title: string;
	body: string | null;
	state: 'open' | 'closed';
	stateReason: string | null;
	labels: string[];
	/** Name of the native issue type, or null. */
	type: string | null;
	user: string;
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
	parent: number | null;
	blockedBy: number[];
	comments: FakeComment[];
	events: FakeEvent[];
	pull: boolean;
	deleted: boolean;
	/** The target of a `duplicate_issue_id`: accepted, never readable (measured). */
	duplicateTarget: number | null;
	/** The search index shows the issue once this many search requests have been made. */
	visibleAtSearch: number;
	/** The issue list shows the issue once this many list requests have been made. */
	visibleAtList: number;
}

export interface NewIssue {
	title: string;
	body?: string | null;
	labels?: string[];
	state?: 'open' | 'closed';
	stateReason?: 'completed' | 'not_planned' | 'duplicate';
	type?: string;
	user?: string;
	pull?: boolean;
}

export interface IssuePatch {
	title?: string;
	body?: string | null;
	state?: 'open' | 'closed';
	stateReason?: 'completed' | 'not_planned' | 'duplicate';
	/** The whole label set after the change. */
	labels?: string[];
	type?: string | null;
	/** Numeric issue id; kept with the issue, never served. */
	duplicateIssueId?: number;
}

export interface RequestRecord {
	method: string;
	/** Path without query, relative to the server root. */
	path: string;
	query: string;
	status: number;
	auth: 'ok' | 'missing' | 'bad';
	conditional: boolean;
	/** Epoch ms at which the request arrived (real time, to check the spacing of writes). */
	at: number;
	/** The parsed JSON body of a write; absent for a read or a write without body. */
	body?: unknown;
}

export interface FakeGitHubOptions {
	/** `owner/name` served; other repositories answer 404. Default `acme/shop`. */
	repo?: string;
	/** The token the server accepts. Default `fake-token-for-tests`. */
	token?: string;
	/** Core bucket. Default 5000 remaining, resetting in an hour. */
	rateLimit?: { limit: number; remaining: number; resetAt: number };
	/** Added to every answer. */
	latencyMs?: number;
	/** An issue is visible to search only after this many search requests (the real index lags about 7 s). Default 0. */
	searchLagRequests?: number;
	/**
	 * An issue created over the API is missing from the issue LIST for this many list requests (measured on the real API: about 4 s,
	 * a read by number and an update are immediate). Default 0.
	 */
	listLagRequests?: number;
	/**
	 * After a dependency is added or removed, the dependency counts (`issue_dependencies_summary`) of the two issues keep their old
	 * value for this many reads of the issue (measured on the real API: 1 to 2 s; the dependency lists themselves are immediate).
	 */
	dependencySummaryLagReads?: number;
	/** Value of `github-authentication-token-expiration`. */
	tokenExpiration?: string;
	hasIssues?: boolean;
	/** Adds `x-accepted-github-permissions` and a 403 on the issue endpoints. */
	denyIssues?: boolean;
	/** The token has Issues read only: every write is a 403 naming `issues=write`. */
	readOnlyToken?: boolean;
	/** The token's user administers the repository (GraphQL `deleteIssue` works). Default true. */
	admin?: boolean;
	/** Milliseconds the fake clock moves for each change (GitHub's resolution is a second). Default 5000; 0 puts changes in one second. */
	clockStepMs?: number;
}

export interface ForcedResponse {
	status: number;
	headers?: Record<string, string>;
	body?: unknown;
	/** Only for requests whose path starts with this. */
	pathPrefix?: string;
	/** A write is APPLIED first and the forced answer is sent anyway (a 502 for something that did happen: the outcome is unknown to the client). */
	applyWrite?: boolean;
	/** Only for requests of this method. */
	method?: string;
	/** Let this many matching requests through first (the fault hits the one after them). */
	skip?: number;
}

type WriteAnswer = { status: number; body: unknown; headers?: Record<string, string> };

type Fault = { kind: 'respond'; response: ForcedResponse } | { kind: 'drop' } | { kind: 'hang' };

const BASE_TIME = Date.parse('2026-11-08T10:00:00Z');

const ISSUE_BASE_PATH = /^\/repos\/([^/]+)\/([^/]+)\/issues(?:\/(.*))?$/;

function sha(text: string): string {
	return crypto.createHash('sha1').update(text).digest('hex');
}

async function readBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

export class FakeGitHub {
	readonly requests: RequestRecord[] = [];
	readonly token: string;
	readonly repo: string;
	readonly issues = new Map<number, FakeIssue>();
	/** Repository labels (name -> color), in creation order. */
	readonly repoLabels = new Map<string, string>();
	private readonly labelDescriptions = new Map<string, string | null>();
	baseUrl = '';
	private server: http.Server | undefined;
	private nextNumber = 1;
	private nextId = 1_000_000;
	private clockMs = BASE_TIME;
	private frozenAt: string | undefined;
	private searchCount = 0;
	private listCount = 0;
	private readonly frozenDependencySummary = new Map<number, { value: Record<string, number>; reads: number }>();
	private core: { limit: number; remaining: number; resetAt: number };
	private search = { limit: 30, remaining: 30, resetAt: Math.floor(BASE_TIME / 1000) + 3600 };
	private readonly faults: Fault[] = [];
	private readonly sockets = new Set<import('node:net').Socket>();
	private readonly held: Array<http.ServerResponse> = [];
	private readonly options: Required<Pick<FakeGitHubOptions, 'latencyMs' | 'searchLagRequests' | 'hasIssues'>> &
		FakeGitHubOptions;

	private constructor(options: FakeGitHubOptions) {
		this.options = { latencyMs: 0, searchLagRequests: 0, hasIssues: true, ...options };
		this.token = options.token ?? 'fake-token-for-tests';
		this.repo = options.repo ?? 'acme/shop';
		this.core = options.rateLimit ?? { limit: 5000, remaining: 5000, resetAt: Math.floor(BASE_TIME / 1000) + 3600 };
	}

	static async start(options: FakeGitHubOptions = {}): Promise<FakeGitHub> {
		const fake = new FakeGitHub(options);
		fake.server = http.createServer((req, res) => void fake.handle(req, res));
		fake.server.on('connection', socket => {
			fake.sockets.add(socket);
			socket.on('close', () => fake.sockets.delete(socket));
		});
		await new Promise<void>((resolve, reject) => {
			fake.server!.once('error', reject);
			fake.server!.listen(0, '127.0.0.1', () => resolve());
		});
		fake.baseUrl = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
		return fake;
	}

	async stop(): Promise<void> {
		for (const res of this.held) res.destroy();
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>(resolve => this.server?.close(() => resolve()));
	}

	// ---------------------------------------------------------------- state, the way a person changes it on GitHub

	/** An ISO instant without milliseconds (GitHub's resolution); every call moves the fake clock on (5 s by default: changes made by hand are seconds apart). */
	private stamp(stepMs = this.options.clockStepMs ?? 5000): string {
		// Measured: the events one request produces (labels and state of one PATCH) all carry the same instant.
		if (this.frozenAt !== undefined) return this.frozenAt;
		this.clockMs += stepMs;
		return new Date(this.clockMs).toISOString().replace('.000Z', 'Z');
	}

	/** `at`: the instant of the event; by default the clock moves on. A creation event shares the creation instant of the issue. */
	private event(
		issue: FakeIssue,
		event: string,
		extra: Record<string, unknown> = {},
		actor = 'octocat',
		at?: string
	): void {
		issue.events.push({ id: this.nextId++, event, createdAt: at ?? this.stamp(), actor, extra });
		issue.updatedAt = issue.events.at(-1)!.createdAt;
	}

	addIssue(input: NewIssue): number {
		const createdAt = this.stamp();
		const issue: FakeIssue = {
			id: this.nextId++,
			number: this.nextNumber++,
			title: input.title,
			body: input.body ?? null,
			state: 'open',
			stateReason: null,
			labels: [],
			type: input.type ?? null,
			user: input.user ?? 'octocat',
			createdAt,
			updatedAt: createdAt,
			closedAt: null,
			parent: null,
			blockedBy: [],
			comments: [],
			events: [],
			pull: input.pull === true,
			deleted: false,
			duplicateTarget: null,
			visibleAtSearch: this.searchCount + this.options.searchLagRequests,
			visibleAtList: 0,
		};
		this.issues.set(issue.number, issue);
		// Measured on the real API: the events of an issue created with labels (or a type) all carry one instant, one second after
		// its creation.
		const creationEvents = this.stamp(this.options.clockStepMs === 0 ? 0 : 1000);
		for (const label of input.labels ?? []) {
			this.ensureLabel(label);
			issue.labels.push(label);
			this.event(issue, 'labeled', { label: { name: label, color: 'ededed' } }, 'octocat', creationEvents);
		}
		if (input.type !== undefined) {
			this.event(issue, 'issue_type_added', { issue_type: this.typeJson(input.type) }, 'octocat', creationEvents);
		}
		if (input.state === 'closed')
			this.updateIssue(issue.number, { state: 'closed', stateReason: input.stateReason });
		return issue.number;
	}

	private ensureLabel(name: string): void {
		if (![...this.repoLabels.keys()].some(known => known.toLowerCase() === name.toLowerCase())) {
			this.repoLabels.set(name, 'ededed');
		}
	}

	addRepoLabel(name: string, color = 'ededed'): void {
		this.repoLabels.set(name, color);
	}

	updateIssue(number: number, patch: IssuePatch): void {
		const issue = this.require(number);
		if (patch.title !== undefined && patch.title !== issue.title) {
			const from = issue.title;
			issue.title = patch.title;
			this.event(issue, 'renamed', { rename: { from, to: patch.title } });
		}
		if (patch.body !== undefined && patch.body !== issue.body) {
			issue.body = patch.body;
			issue.updatedAt = this.stamp();
		}
		if (patch.labels !== undefined) {
			const wanted = patch.labels;
			for (const label of issue.labels.filter(held => !wanted.includes(held))) {
				this.event(issue, 'unlabeled', { label: { name: label, color: 'ededed' } });
			}
			for (const label of wanted.filter(next => !issue.labels.includes(next))) {
				this.ensureLabel(label);
				this.event(issue, 'labeled', { label: { name: label, color: 'ededed' } });
			}
			issue.labels = [...wanted];
		}
		if (patch.type !== undefined && patch.type !== issue.type) {
			const had = issue.type;
			issue.type = patch.type;
			this.event(
				issue,
				patch.type === null ? 'issue_type_removed' : had === null ? 'issue_type_added' : 'issue_type_changed',
				patch.type === null ? {} : { issue_type: this.typeJson(patch.type) }
			);
		}
		if (
			patch.state === 'closed' &&
			issue.state === 'closed' &&
			patch.stateReason !== undefined &&
			patch.stateReason !== issue.stateReason
		) {
			// Measured: `state: closed` with a reason on an issue that is already closed changes the reason (a reason alone is ignored).
			issue.stateReason = patch.stateReason;
			if (patch.duplicateIssueId !== undefined) issue.duplicateTarget = patch.duplicateIssueId;
			issue.updatedAt = this.stamp();
		}
		if (patch.state !== undefined && patch.state !== issue.state) {
			if (patch.state === 'closed') {
				issue.state = 'closed';
				issue.stateReason = patch.stateReason ?? 'completed';
				if (patch.duplicateIssueId !== undefined) issue.duplicateTarget = patch.duplicateIssueId;
				// Measured: a `completed` close shows `state_reason: null` in the events, the others show their value.
				this.event(issue, 'closed', {
					state_reason: issue.stateReason === 'completed' ? null : issue.stateReason,
				});
				issue.closedAt = issue.updatedAt;
			} else {
				issue.state = 'open';
				issue.stateReason = 'reopened';
				this.event(issue, 'reopened', { state_reason: 'reopened' });
				issue.closedAt = null;
			}
		}
	}

	addComment(number: number, body: string, user = 'octocat'): number {
		const issue = this.require(number);
		const at = this.stamp();
		const comment: FakeComment = { id: this.nextId++, user, body, createdAt: at, updatedAt: at };
		issue.comments.push(comment);
		issue.events.push({
			id: comment.id,
			event: 'commented',
			createdAt: at,
			actor: user,
			extra: { body, user: { login: user }, updated_at: at, author_association: 'MEMBER' },
		});
		issue.updatedAt = at;
		return comment.id;
	}

	editComment(number: number, commentId: number, body: string): void {
		const issue = this.require(number);
		const comment = issue.comments.find(c => c.id === commentId)!;
		comment.body = body;
		comment.updatedAt = this.stamp();
		issue.updatedAt = comment.updatedAt;
	}

	setParent(child: number, parent: number | null): void {
		const c = this.require(child);
		if (c.parent !== null) {
			const old = this.require(c.parent);
			this.event(old, 'sub_issue_removed', { sub_issue: this.refJson(c) });
			this.event(c, 'parent_issue_removed', { parent_issue: this.refJson(old) });
		}
		c.parent = parent;
		if (parent !== null) {
			const p = this.require(parent);
			this.event(p, 'sub_issue_added', { sub_issue: this.refJson(c) });
			this.event(c, 'parent_issue_added', { parent_issue: this.refJson(p) });
		}
	}

	private freezeDependencySummary(...issues: FakeIssue[]): void {
		const reads = this.options.dependencySummaryLagReads ?? 0;
		if (reads <= 0) return;
		for (const issue of issues)
			this.frozenDependencySummary.set(issue.number, { value: this.dependencySummary(issue), reads });
	}

	private dependencySummary(issue: FakeIssue): Record<string, number> {
		const blocking = [...this.issues.values()].filter(other => other.blockedBy.includes(issue.number));
		const openBlockers = issue.blockedBy.filter(n => this.issues.get(n)?.state === 'open');
		return {
			blocked_by: openBlockers.length,
			total_blocked_by: issue.blockedBy.length,
			blocking: blocking.filter(other => other.state === 'open').length,
			total_blocking: blocking.length,
		};
	}

	addBlockedBy(blocked: number, blocker: number): void {
		const a = this.require(blocked);
		const b = this.require(blocker);
		this.freezeDependencySummary(a, b);
		a.blockedBy.push(blocker);
		this.event(a, 'blocked_by_added', { blocked_by: this.refJson(b) });
		this.event(b, 'blocking_added', { blocking: this.refJson(a) });
	}

	removeBlockedBy(blocked: number, blocker: number): void {
		const a = this.require(blocked);
		const b = this.require(blocker);
		this.freezeDependencySummary(a, b);
		a.blockedBy = a.blockedBy.filter(n => n !== blocker);
		this.event(a, 'blocked_by_removed', { blocked_by: this.refJson(b) });
		this.event(b, 'blocking_removed', { blocking: this.refJson(a) });
	}

	/** An event of a kind the strategy does not map (assigned, locked...). */
	addRawEvent(number: number, event: string, extra: Record<string, unknown> = {}): void {
		this.event(this.require(number), event, extra);
	}

	/** Makes the issue a tombstone: GET answers 410 "This issue was deleted". */
	deleteIssue(number: number): void {
		this.require(number).deleted = true;
	}

	private require(number: number): FakeIssue {
		const issue = this.issues.get(number);
		if (issue === undefined) throw new Error(`The fake server has no issue #${number}`);
		return issue;
	}

	// ---------------------------------------------------------------- behaviours a test switches on

	/** The next `times` requests (matching `pathPrefix` when given) get this answer instead of the real one. */
	failNext(response: ForcedResponse, times = 1): void {
		for (let i = 0; i < times; i++) this.faults.push({ kind: 'respond', response });
	}

	/** The next request's connection is destroyed before any answer (a network failure). */
	dropNext(times = 1): void {
		for (let i = 0; i < times; i++) this.faults.push({ kind: 'drop' });
	}

	/** The next request never gets an answer (a timeout). */
	hangNext(times = 1): void {
		for (let i = 0; i < times; i++) this.faults.push({ kind: 'hang' });
	}

	setRateLimit(bucket: 'core' | 'search', value: { limit?: number; remaining?: number; resetAt?: number }): void {
		const target = bucket === 'core' ? this.core : this.search;
		Object.assign(target, value);
	}

	get coreRemaining(): number {
		return this.core.remaining;
	}

	/** Requests other than GET (the strategy must send none). */
	writes(): RequestRecord[] {
		return this.requests.filter(request => request.method !== 'GET');
	}

	requestsTo(pathPrefix: string): RequestRecord[] {
		return this.requests.filter(request => request.path.startsWith(pathPrefix));
	}

	// ---------------------------------------------------------------- JSON shapes

	private typeJson(name: string): Record<string, unknown> {
		return { id: 800_000 + name.length, name, color: 'red' };
	}

	private repoJson(): Record<string, unknown> {
		return { full_name: this.repo, name: this.repo.split('/')[1], owner: { login: this.repo.split('/')[0] } };
	}

	private refJson(issue: FakeIssue): Record<string, unknown> {
		return { number: issue.number, title: issue.title, state: issue.state, repository: this.repoJson() };
	}

	private issueUrl(issue: FakeIssue): string {
		return `${this.baseUrl}/repos/${this.repo}/issues/${issue.number}`;
	}

	private issueJson(issue: FakeIssue): Record<string, unknown> {
		const children = [...this.issues.values()].filter(other => other.parent === issue.number && !other.deleted);
		return {
			url: this.issueUrl(issue),
			repository_url: `${this.baseUrl}/repos/${this.repo}`,
			html_url: `https://github.com/${this.repo}/issues/${issue.number}`,
			id: issue.id,
			node_id: `I_${issue.id}`,
			number: issue.number,
			title: issue.title,
			user: { login: issue.user },
			labels: issue.labels.map(name => this.labelJson(name)),
			state: issue.state,
			state_reason: issue.stateReason,
			locked: false,
			comments: issue.comments.length,
			created_at: issue.createdAt,
			updated_at: issue.updatedAt,
			closed_at: issue.closedAt,
			body: issue.body,
			author_association: 'MEMBER',
			type: issue.type === null ? null : this.typeJson(issue.type),
			sub_issues_summary: {
				total: children.length,
				completed: children.filter(child => child.state === 'closed').length,
				percent_completed:
					children.length === 0
						? 0
						: Math.round(
								(100 * children.filter(child => child.state === 'closed').length) / children.length
							),
			},
			issue_dependencies_summary: this.servedDependencySummary(issue),
			...(issue.parent === null ? {} : { parent_issue_url: this.issueUrl(this.require(issue.parent)) }),
			...(issue.pull
				? { pull_request: { url: `${this.baseUrl}/repos/${this.repo}/pulls/${issue.number}` } }
				: {}),
		};
	}

	private eventJson(issue: FakeIssue, event: FakeEvent): Record<string, unknown> {
		return {
			id: event.id,
			url: `${this.baseUrl}/repos/${this.repo}/issues/events/${event.id}`,
			actor: { login: event.actor },
			event: event.event,
			created_at: event.createdAt,
			commit_id: null,
			commit_url: null,
			...(event.event === 'commented' ? { issue_url: this.issueUrl(issue) } : {}),
			...event.extra,
		};
	}

	private commentJson(issue: FakeIssue, comment: FakeComment): Record<string, unknown> {
		return {
			id: comment.id,
			issue_url: this.issueUrl(issue),
			user: { login: comment.user },
			created_at: comment.createdAt,
			updated_at: comment.updatedAt,
			body: comment.body,
			author_association: 'MEMBER',
		};
	}

	// ---------------------------------------------------------------- HTTP

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://fake');
		const record: RequestRecord = {
			method: req.method ?? 'GET',
			path: url.pathname,
			query: url.search.replace(/^\?/, ''),
			status: 0,
			auth: 'missing',
			conditional: req.headers['if-none-match'] !== undefined,
			at: Date.now(),
		};
		this.requests.push(record);
		const rawBody = await readBody(req);
		let parsedBody: unknown;
		let badJson = false;
		if (rawBody !== '') {
			try {
				parsedBody = JSON.parse(rawBody);
				record.body = parsedBody;
			} catch {
				badJson = true;
			}
		}

		if (this.options.latencyMs > 0) await new Promise(resolve => setTimeout(resolve, this.options.latencyMs));

		const fault = this.nextFault(url.pathname, req.method ?? 'GET');
		if (fault?.kind === 'drop') {
			record.status = -1;
			req.socket.destroy();
			return;
		}
		if (fault?.kind === 'hang') {
			record.status = -2;
			this.held.push(res);
			return;
		}
		const finish = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
			record.status = status;
			const text = body === undefined ? '' : JSON.stringify(body);
			res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
			res.end(status === 304 ? undefined : text);
		};
		if (fault?.kind === 'respond') {
			const { status, headers = {}, body = { message: 'forced' }, applyWrite } = fault.response;
			if (applyWrite === true && req.method !== 'GET')
				this.routeWrite(req.method ?? '', url, parsedBody, req.headers);
			finish(status, body, headers);
			return;
		}

		const authorization = req.headers['authorization'];
		if (authorization === undefined) {
			finish(401, { message: 'Requires authentication', status: '401' });
			return;
		}
		if (authorization !== `Bearer ${this.token}`) {
			record.auth = 'bad';
			finish(401, { message: 'Bad credentials', status: '401' });
			return;
		}
		record.auth = 'ok';
		const isWrite = req.method !== 'GET';
		if (isWrite && this.options.readOnlyToken === true) {
			finish(
				403,
				{ message: 'Resource not accessible by personal access token', status: '403' },
				{ 'x-accepted-github-permissions': 'issues=write' }
			);
			return;
		}
		if (isWrite && badJson) {
			finish(400, { message: 'Problems parsing JSON', status: '400' });
			return;
		}

		const isSearch = url.pathname === '/search/issues';
		const bucket = isSearch ? this.search : this.core;
		const resource = isSearch ? 'search' : 'core';
		const headers: Record<string, string> = {
			'x-ratelimit-limit': String(bucket.limit),
			'x-ratelimit-reset': String(bucket.resetAt),
			'x-ratelimit-resource': resource,
			...(this.options.tokenExpiration === undefined
				? {}
				: { 'github-authentication-token-expiration': this.options.tokenExpiration }),
		};
		if (url.pathname !== '/rate_limit') {
			if (bucket.remaining <= 0) {
				finish(
					403,
					{ message: 'API rate limit exceeded for user ID 1.', status: '403' },
					{ ...headers, 'x-ratelimit-remaining': '0', 'x-ratelimit-used': String(bucket.limit) }
				);
				return;
			}
		}

		if (isWrite) {
			const written = this.routeWrite(req.method ?? '', url, parsedBody, req.headers);
			// A write spends the quota like a read.
			bucket.remaining -= 1;
			finish(written.status, written.body, {
				...headers,
				'x-ratelimit-remaining': String(bucket.remaining),
				'x-ratelimit-used': String(bucket.limit - bucket.remaining),
				...written.headers,
			});
			return;
		}

		const answer = this.route(url, req);
		const etagged = answer.status === 200 && answer.etag !== false;
		const body = answer.body;
		const etag = etagged ? `"${sha(JSON.stringify(body))}"` : undefined;
		const sent = req.headers['if-none-match'];
		const notModified = etag !== undefined && typeof sent === 'string' && sent.replace(/^W\//, '') === etag;
		// A 304 does not spend the quota (measured: x-ratelimit-used did not move).
		if (!notModified && url.pathname !== '/rate_limit') bucket.remaining -= 1;
		const base: Record<string, string> = {
			...headers,
			'x-ratelimit-remaining': String(bucket.remaining),
			'x-ratelimit-used': String(bucket.limit - bucket.remaining),
			...(etag === undefined ? {} : { etag }),
			...answer.headers,
		};
		if (this.options.denyIssues === true && /\/issues(\/|$)/.test(url.pathname) && !isSearch) {
			finish(
				403,
				{ message: 'Resource not accessible by personal access token', status: '403' },
				{ ...base, 'x-accepted-github-permissions': 'issues=read' }
			);
			return;
		}
		if (notModified) {
			finish(304, undefined, base);
			return;
		}
		finish(answer.status, body, base);
	}

	private nextFault(pathname: string, method: string): Fault | undefined {
		const index = this.faults.findIndex(
			fault =>
				fault.kind !== 'respond' ||
				(((fault.response.pathPrefix ?? '') === '' || pathname.startsWith(fault.response.pathPrefix!)) &&
					(fault.response.method === undefined || fault.response.method === method))
		);
		if (index < 0) return undefined;
		const fault = this.faults[index]!;
		if (fault.kind === 'respond' && (fault.response.skip ?? 0) > 0) {
			fault.response.skip = (fault.response.skip ?? 0) - 1;
			return undefined;
		}
		return this.faults.splice(index, 1)[0];
	}

	private route(
		url: URL,
		_req: http.IncomingMessage
	): { status: number; body: unknown; headers?: Record<string, string>; etag?: boolean } {
		const path = url.pathname;
		const notFound = (message = 'Not Found'): { status: number; body: unknown } => ({
			status: 404,
			body: { message, documentation_url: 'https://docs.github.com/rest', status: '404' },
		});

		if (path === '/user') return { status: 200, body: { login: 'fake-user', id: 1 } };
		if (path === '/rate_limit') {
			const entry = (bucket: { limit: number; remaining: number; resetAt: number }) => ({
				limit: bucket.limit,
				remaining: bucket.remaining,
				reset: bucket.resetAt,
				used: bucket.limit - bucket.remaining,
			});
			return {
				status: 200,
				body: { resources: { core: entry(this.core), search: entry(this.search) }, rate: entry(this.core) },
				etag: false,
			};
		}
		if (path === '/search/issues') return this.searchIssues(url);

		const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
		if (repoMatch === null) return notFound();
		if (`${repoMatch[1]}/${repoMatch[2]}`.toLowerCase() !== this.repo.toLowerCase()) return notFound();
		const rest = repoMatch[3] ?? '';
		if (rest === '') {
			return {
				status: 200,
				body: {
					...this.repoJson(),
					private: true,
					has_issues: this.options.hasIssues,
					archived: false,
					permissions: {
						admin: this.options.admin !== false,
						push: this.options.readOnlyToken !== true,
						pull: true,
					},
				},
			};
		}
		if (rest === '/labels') {
			const all = [...this.repoLabels.keys()].map((name, index) => ({ ...this.labelJson(name), id: index + 1 }));
			return this.paged(url, all, item => item);
		}
		const oneLabel = /^\/labels\/([^/]+)$/.exec(rest);
		if (oneLabel !== null) {
			const wanted = decodeURIComponent(oneLabel[1]!).toLowerCase();
			const known = [...this.repoLabels.keys()].find(label => label.toLowerCase() === wanted);
			return known === undefined ? notFound() : { status: 200, body: this.labelJson(known) };
		}
		if (!ISSUE_BASE_PATH.test(path)) return notFound();
		if (!this.options.hasIssues) {
			return { status: 410, body: { message: 'Issues are disabled for this repo', status: '410' } };
		}
		const issueRest = ISSUE_BASE_PATH.exec(path)![3];
		if (issueRest === undefined || issueRest === '') return this.listIssues(url);

		const [numberText, ...more] = issueRest.split('/');
		const number = Number(numberText);
		if (!Number.isInteger(number)) return notFound();
		const issue = this.issues.get(number);
		if (issue === undefined) return notFound();
		if (issue.deleted) return { status: 410, body: { message: 'This issue was deleted', status: '410' } };
		const tail = more.join('/');
		if (tail === '') return { status: 200, body: this.issueJson(issue) };
		if (tail === 'comments') {
			return this.paged(url, issue.comments, comment => this.commentJson(issue, comment));
		}
		if (tail === 'timeline' || tail === 'events') {
			const wanted = tail === 'events' ? issue.events.filter(e => e.event !== 'commented') : issue.events;
			return this.paged(url, wanted, event => this.eventJson(issue, event));
		}
		if (tail === 'sub_issues') {
			const children = [...this.issues.values()].filter(other => other.parent === issue.number && !other.deleted);
			return this.paged(url, children, child => this.issueJson(child));
		}
		if (tail === 'parent') {
			if (issue.parent === null) return notFound('No parent issue found');
			return { status: 200, body: this.issueJson(this.require(issue.parent)) };
		}
		if (tail === 'dependencies/blocked_by') {
			return this.paged(
				url,
				issue.blockedBy.map(n => this.require(n)),
				blocker => this.issueJson(blocker)
			);
		}
		if (tail === 'dependencies/blocking') {
			const blocked = [...this.issues.values()].filter(other => other.blockedBy.includes(issue.number));
			return this.paged(url, blocked, item => this.issueJson(item));
		}
		return notFound();
	}

	// ---------------------------------------------------------------- writes over HTTP

	private invalid422(errors: unknown[]): WriteAnswer {
		return {
			status: 422,
			body: {
				message: 'Validation Failed',
				errors,
				documentation_url: 'https://docs.github.com/rest',
				status: '422',
			},
		};
	}

	/** The shape of the sub-issue and dependency errors (measured): one message, no `errors` array. */
	private message422(message: string): WriteAnswer {
		return {
			status: 422,
			body: { message, documentation_url: 'https://docs.github.com/rest', status: '422' },
		};
	}

	private subIssue422(text: string): WriteAnswer {
		return this.message422(`An error occurred while adding the sub-issue to the parent issue. ${text}`);
	}

	private dependency422(text: string): WriteAnswer {
		return this.message422(
			`An error occurred while adding the blocking issue to the issue. Validation failed: ${text}`
		);
	}

	private custom422(resource: string, field: string, message: string): WriteAnswer {
		return this.invalid422([{ resource, code: 'custom', field, message }]);
	}

	private notFound404(message = 'Not Found'): WriteAnswer {
		return { status: 404, body: { message, documentation_url: 'https://docs.github.com/rest', status: '404' } };
	}

	/** The problem GitHub reports for a label name given to an issue endpoint (no message, only the field), or undefined. */
	private issueLabelProblem(names: unknown): WriteAnswer | undefined {
		if (!Array.isArray(names)) return this.invalid422([{ resource: 'Issue', field: 'labels', code: 'invalid' }]);
		for (const entry of names) {
			const name = typeof entry === 'string' ? entry : (entry as { name?: unknown })?.name;
			if (typeof name !== 'string' || name.trim() === '' || name.includes(',') || name.length > 50) {
				return this.invalid422([{ resource: 'Label', field: 'name', code: 'invalid' }]);
			}
		}
		return undefined;
	}

	private labelNamesOf(names: unknown[]): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const entry of names) {
			const raw = typeof entry === 'string' ? entry : String((entry as { name: unknown }).name);
			const name = raw.replace(/^\s+/, '');
			if (seen.has(name.toLowerCase())) continue;
			seen.add(name.toLowerCase());
			out.push(name);
		}
		return out;
	}

	private labelsJson(issue: FakeIssue): unknown[] {
		return issue.labels.map(name => this.labelJson(name));
	}

	private labelJson(name: string): Record<string, unknown> {
		const known = [...this.repoLabels.keys()].find(label => label.toLowerCase() === name.toLowerCase()) ?? name;
		return {
			id: sha(name).length,
			name: known,
			color: this.repoLabels.get(known) ?? 'ededed',
			description: this.labelDescriptions.get(known) ?? null,
			default: false,
		};
	}

	private issueByNumber(text: string | undefined): FakeIssue | WriteAnswer {
		const number = Number(text);
		const issue = Number.isInteger(number) ? this.issues.get(number) : undefined;
		if (issue === undefined) return this.notFound404();
		if (issue.deleted) return { status: 410, body: { message: 'This issue was deleted', status: '410' } };
		return issue;
	}

	private issueById(id: unknown): FakeIssue | undefined {
		return typeof id === 'number'
			? [...this.issues.values()].find(issue => issue.id === id && !issue.deleted)
			: undefined;
	}

	/** Adds the labels the issue lacks, one `labeled` event each. */
	private addLabelsTo(issue: FakeIssue, names: readonly string[]): void {
		for (const name of names) {
			if (issue.labels.some(held => held.toLowerCase() === name.toLowerCase())) continue;
			this.ensureLabel(name);
			issue.labels.push(name);
			this.event(issue, 'labeled', { label: { name, color: this.repoLabels.get(name) ?? 'ededed' } });
		}
	}

	removeComment(number: number, commentId: number): void {
		const issue = this.require(number);
		issue.comments = issue.comments.filter(comment => comment.id !== commentId);
		issue.events = issue.events.filter(event => !(event.event === 'commented' && event.id === commentId));
		issue.updatedAt = this.stamp();
	}

	private levelOf(issue: FakeIssue): number {
		let level = 1;
		for (let current = issue; current.parent !== null; current = this.require(current.parent)) level += 1;
		return level;
	}

	private heightOf(issue: FakeIssue): number {
		const children = [...this.issues.values()].filter(other => other.parent === issue.number && !other.deleted);
		return 1 + Math.max(0, ...children.map(child => this.heightOf(child)));
	}

	private dependsOn(start: FakeIssue, target: number, seen = new Set<number>()): boolean {
		if (seen.has(start.number)) return false;
		seen.add(start.number);
		return start.blockedBy.some(next => next === target || this.dependsOn(this.require(next), target, seen));
	}

	private servedDependencySummary(issue: FakeIssue): Record<string, number> {
		const frozen = this.frozenDependencySummary.get(issue.number);
		if (frozen !== undefined && frozen.reads > 0) {
			frozen.reads -= 1;
			return frozen.value;
		}
		return this.dependencySummary(issue);
	}

	/** What GraphQL `deleteIssue` does: the issue is gone (410), its relations with the others are cut. */
	private eraseIssue(issue: FakeIssue): void {
		for (const child of [...this.issues.values()].filter(other => other.parent === issue.number)) {
			this.setParent(child.number, null);
		}
		if (issue.parent !== null) this.setParent(issue.number, null);
		for (const blocker of [...issue.blockedBy]) this.removeBlockedBy(issue.number, blocker);
		for (const other of this.issues.values()) {
			if (other.blockedBy.includes(issue.number)) this.removeBlockedBy(other.number, issue.number);
		}
		issue.deleted = true;
	}

	private routeWrite(method: string, url: URL, body: unknown, headers: http.IncomingHttpHeaders): WriteAnswer {
		const path = url.pathname;
		const input = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<
			string,
			unknown
		>;
		// Measured: conditional headers on an unsafe request are refused loudly, never ignored.
		if (headers['if-match'] !== undefined || headers['if-unmodified-since'] !== undefined) {
			return {
				status: 400,
				body: {
					message:
						'Conditional request headers are not allowed in unsafe requests unless supported by the endpoint',
					status: '400',
				},
			};
		}
		if (headers['if-none-match'] === '*') return { status: 412, body: undefined };

		if (path === '/graphql' && method === 'POST') return this.graphql(input);

		const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
		if (repoMatch === null || `${repoMatch[1]}/${repoMatch[2]}`.toLowerCase() !== this.repo.toLowerCase()) {
			return this.notFound404();
		}
		const rest = repoMatch[3] ?? '';

		if (rest === '/labels' && method === 'POST') return this.createRepoLabel(input);
		const labelMatch = /^\/labels\/([^/]+)$/.exec(rest);
		if (labelMatch !== null && method === 'DELETE') {
			const name = decodeURIComponent(labelMatch[1]!);
			const known = [...this.repoLabels.keys()].find(label => label.toLowerCase() === name.toLowerCase());
			if (known === undefined) return this.notFound404();
			this.repoLabels.delete(known);
			this.labelDescriptions.delete(known);
			for (const issue of this.issues.values()) {
				issue.labels = issue.labels.filter(held => held.toLowerCase() !== known.toLowerCase());
			}
			return { status: 204, body: undefined };
		}

		if (!this.options.hasIssues) {
			return { status: 410, body: { message: 'Issues are disabled for this repo', status: '410' } };
		}
		if (rest === '/issues' && method === 'POST') return this.createIssue(input);

		const commentMatch = /^\/issues\/comments\/(\d+)$/.exec(rest);
		if (commentMatch !== null) return this.writeComment(method, Number(commentMatch[1]), input);

		const issueMatch = /^\/issues\/(\d+)(?:\/(.*))?$/.exec(rest);
		if (issueMatch === null) return this.notFound404();
		const found = this.issueByNumber(issueMatch[1]);
		if (!('number' in found)) return found;
		const issue = found;
		const tail = issueMatch[2] ?? '';

		if (tail === '' && method === 'PATCH') return this.patchIssue(issue, input);
		if (tail === 'comments' && method === 'POST') return this.createComment(issue, input);
		if (tail === 'labels') return this.writeIssueLabels(method, issue, input);
		const oneLabel = /^labels\/(.+)$/.exec(tail);
		if (oneLabel !== null && method === 'DELETE') {
			const name = decodeURIComponent(oneLabel[1]!);
			const held = issue.labels.find(label => label.toLowerCase() === name.toLowerCase());
			if (held === undefined) return this.notFound404('Label does not exist');
			issue.labels = issue.labels.filter(label => label !== held);
			this.event(issue, 'unlabeled', { label: { name: held, color: this.repoLabels.get(held) ?? 'ededed' } });
			return { status: 200, body: this.labelsJson(issue) };
		}
		if (tail === 'sub_issues' && method === 'POST') return this.addSubIssue(issue, input);
		if (tail === 'sub_issue' && method === 'DELETE') {
			const child = this.issueById(input['sub_issue_id']);
			if (child === undefined || child.parent !== issue.number) return this.notFound404();
			this.setParent(child.number, null);
			return { status: 200, body: this.issueJson(issue) };
		}
		if (tail === 'dependencies/blocked_by' && method === 'POST') return this.addDependency(issue, input);
		const dependency = /^dependencies\/blocked_by\/(\d+)$/.exec(tail);
		if (dependency !== null && method === 'DELETE') {
			const blocker = this.issueById(Number(dependency[1]));
			if (blocker === undefined) return this.notFound404();
			// Measured: removing a dependency that is not there is a 200 with the issue, not a 404.
			if (issue.blockedBy.includes(blocker.number)) this.removeBlockedBy(issue.number, blocker.number);
			return { status: 200, body: this.issueJson(issue) };
		}
		return this.notFound404();
	}

	private graphql(input: Record<string, unknown>): WriteAnswer {
		const query = typeof input['query'] === 'string' ? input['query'] : '';
		const variables = (input['variables'] ?? {}) as Record<string, unknown>;
		if (!/deleteIssue/.test(query)) {
			return { status: 200, body: { errors: [{ message: 'The fake GraphQL endpoint only knows deleteIssue' }] } };
		}
		const nodeId = String(variables['id'] ?? '');
		const issue = [...this.issues.values()].find(candidate => `I_${candidate.id}` === nodeId && !candidate.deleted);
		if (issue === undefined) {
			return {
				status: 200,
				body: {
					data: { deleteIssue: null },
					errors: [
						{ type: 'NOT_FOUND', message: `Could not resolve to an Issue with the id of '${nodeId}'.` },
					],
				},
			};
		}
		if (this.options.admin === false) {
			return {
				status: 200,
				body: {
					data: { deleteIssue: null },
					errors: [
						{
							type: 'FORBIDDEN',
							message: `${this.token.length > 0 ? 'fake-user' : 'user'} does not have the correct permissions to execute \`DeleteIssue\``,
						},
					],
				},
			};
		}
		this.eraseIssue(issue);
		return { status: 200, body: { data: { deleteIssue: { clientMutationId: null } } } };
	}

	private createRepoLabel(input: Record<string, unknown>): WriteAnswer {
		const name = typeof input['name'] === 'string' ? input['name'].replace(/^\s+/, '') : '';
		if (name === '') return this.invalid422([{ resource: 'Label', code: 'missing_field', field: 'name' }]);
		if (name.length > 50) return this.custom422('Label', 'name', 'name is too long (maximum is 50 characters)');
		if (name.includes(',')) return this.invalid422([{ resource: 'Label', code: 'invalid', field: 'name' }]);
		const color = input['color'] === undefined ? 'ededed' : input['color'];
		if (typeof color !== 'string' || !/^[0-9a-fA-F]{6}$/.test(color)) {
			return this.invalid422([{ resource: 'Label', code: 'invalid', field: 'color' }]);
		}
		const description = input['description'];
		if (typeof description === 'string' && description.length > 100) {
			return this.custom422('Label', 'description', 'description is too long (maximum is 100 characters)');
		}
		if ([...this.repoLabels.keys()].some(known => known.toLowerCase() === name.toLowerCase())) {
			return this.invalid422([{ resource: 'Label', code: 'already_exists', field: 'name' }]);
		}
		this.repoLabels.set(name, color.toLowerCase());
		this.labelDescriptions.set(name, typeof description === 'string' ? description : null);
		return { status: 201, body: this.labelJson(name) };
	}

	private createIssue(input: Record<string, unknown>): WriteAnswer {
		const title = input['title'];
		if (typeof title !== 'string' || title.trim() === '') {
			return this.invalid422([{ resource: 'Issue', code: 'missing_field', field: 'title' }]);
		}
		const text = input['body'];
		if (typeof text === 'string' && text.length > 65536) {
			return this.custom422('Issue', 'body', 'body is too long (maximum is 65536 characters)');
		}
		let labels: string[] = [];
		if (input['labels'] !== undefined) {
			const problem = this.issueLabelProblem(input['labels']);
			if (problem !== undefined) return problem;
			labels = this.labelNamesOf(input['labels'] as unknown[]);
			if (labels.length > 100)
				return this.custom422('Issue', 'labels', 'Issues cannot have more than 100 labels');
		}
		// Measured: `state` and `state_reason` of a create are ignored without a word.
		const number = this.addIssue({
			title,
			body: typeof text === 'string' ? text : null,
			labels,
			...(typeof input['type'] === 'string' ? { type: input['type'] } : {}),
			user: 'fake-user',
		});
		// Measured: the list shows a new issue a few seconds after the creation, a read by number at once.
		this.require(number).visibleAtList = this.listCount + (this.options.listLagRequests ?? 0);
		return { status: 201, body: this.issueJson(this.require(number)) };
	}

	private patchIssue(issue: FakeIssue, input: Record<string, unknown>): WriteAnswer {
		const patch: IssuePatch = {};
		if (input['title'] !== undefined) {
			if (typeof input['title'] !== 'string' || input['title'].trim() === '') {
				return this.invalid422([{ resource: 'Issue', code: 'invalid', field: 'title' }]);
			}
			patch.title = input['title'];
		}
		if (input['body'] !== undefined) {
			const text = input['body'];
			if (typeof text === 'string' && text.length > 65536) {
				return this.custom422('Issue', 'body', 'body is too long (maximum is 65536 characters)');
			}
			patch.body = typeof text === 'string' ? text : null;
		}
		if (input['state'] !== undefined) {
			if (input['state'] !== 'open' && input['state'] !== 'closed') {
				return this.invalid422([{ resource: 'Issue', code: 'invalid', field: 'state' }]);
			}
			patch.state = input['state'];
		}
		const reason = input['state_reason'];
		if (reason !== undefined && reason !== null) {
			if (!['completed', 'not_planned', 'duplicate', 'reopened'].includes(String(reason))) {
				return this.custom422('Issue', 'state_reason', 'Please specify a valid state reason.');
			}
			if (reason !== 'reopened') patch.stateReason = reason as 'completed' | 'not_planned' | 'duplicate';
		}
		if (input['duplicate_issue_id'] !== undefined) {
			const target = this.issueById(input['duplicate_issue_id']);
			if (target === undefined) {
				return this.invalid422([{ resource: 'Issue', code: 'invalid', field: 'duplicate_issue_id' }]);
			}
			patch.duplicateIssueId = target.id;
		}
		if (input['labels'] !== undefined) {
			const problem = this.issueLabelProblem(input['labels']);
			if (problem !== undefined) return problem;
			patch.labels = this.labelNamesOf(input['labels'] as unknown[]);
			if (patch.labels.length > 100) {
				return this.custom422('Issue', 'labels', 'Issues cannot have more than 100 labels');
			}
		}
		if (input['type'] !== undefined) {
			if (input['type'] !== null && typeof input['type'] !== 'string') {
				return this.invalid422([{ resource: 'Issue', code: 'invalid', field: 'type' }]);
			}
			patch.type = input['type'];
		}
		this.frozenAt = this.stamp();
		try {
			this.updateIssue(issue.number, patch);
		} finally {
			this.frozenAt = undefined;
		}
		return { status: 200, body: this.issueJson(issue) };
	}

	private writeIssueLabels(method: string, issue: FakeIssue, input: Record<string, unknown>): WriteAnswer {
		if (method !== 'POST' && method !== 'PUT') return this.notFound404();
		const given = input['labels'];
		const problem = this.issueLabelProblem(given);
		if (problem !== undefined) return problem;
		const names = this.labelNamesOf(given as unknown[]);
		if (method === 'PUT') {
			if (names.length > 100) return this.custom422('Issue', 'labels', 'Issues cannot have more than 100 labels');
			this.updateIssue(issue.number, { labels: names });
			return { status: 200, body: this.labelsJson(issue) };
		}
		const fresh = names.filter(name => !issue.labels.some(held => held.toLowerCase() === name.toLowerCase()));
		if (issue.labels.length + fresh.length > 100) {
			return this.custom422('Issue', 'labels', 'Issues cannot have more than 100 labels');
		}
		const created = fresh.filter(
			name => ![...this.repoLabels.keys()].some(known => known.toLowerCase() === name.toLowerCase())
		);
		// Measured: one POST that creates 100 labels times out and applies nothing; one that creates 50 times out with all applied.
		if (created.length >= 100) return { status: 502, body: { message: 'Server Error' } };
		this.addLabelsTo(issue, names);
		if (created.length >= 50) return { status: 502, body: { message: 'Server Error' } };
		return { status: 200, body: this.labelsJson(issue) };
	}

	private createComment(issue: FakeIssue, input: Record<string, unknown>): WriteAnswer {
		const text = input['body'];
		if (typeof text !== 'string' || text === '') {
			return this.invalid422([{ resource: 'IssueComment', code: 'missing_field', field: 'body' }]);
		}
		if (text.length > 65536)
			return this.custom422('IssueComment', 'body', 'Body is too long (maximum is 65536 characters)');
		const id = this.addComment(issue.number, text, 'fake-user');
		return {
			status: 201,
			body: this.commentJson(
				issue,
				issue.comments.find(comment => comment.id === id)!
			),
		};
	}

	private writeComment(method: string, id: number, input: Record<string, unknown>): WriteAnswer {
		const owner = [...this.issues.values()].find(issue => issue.comments.some(comment => comment.id === id));
		if (owner === undefined) return this.notFound404();
		if (method === 'DELETE') {
			this.removeComment(owner.number, id);
			return { status: 204, body: undefined };
		}
		if (method !== 'PATCH') return this.notFound404();
		const text = input['body'];
		if (typeof text !== 'string' || text === '') {
			return this.invalid422([{ resource: 'IssueComment', code: 'missing_field', field: 'body' }]);
		}
		if (text.length > 65536)
			return this.custom422('IssueComment', 'body', 'Body is too long (maximum is 65536 characters)');
		this.editComment(owner.number, id, text);
		return {
			status: 200,
			body: this.commentJson(
				owner,
				owner.comments.find(comment => comment.id === id)!
			),
		};
	}

	private addSubIssue(parent: FakeIssue, input: Record<string, unknown>): WriteAnswer {
		const child = this.issueById(input['sub_issue_id']);
		// Measured: the body takes the numeric id; a number is no id, so 404.
		if (child === undefined) return this.notFound404();
		const replace = input['replace_parent'] === true;
		if (child.number === parent.number) {
			return this.subIssue422('Sub issue may not create a circular dependency');
		}
		if (child.parent !== null && !replace) {
			return this.subIssue422(
				child.parent === parent.number
					? 'Issue may not contain duplicate sub-issues and Sub issue may only have one parent'
					: 'Sub issue may only have one parent'
			);
		}
		for (let current: FakeIssue | undefined = parent; current !== undefined;) {
			if (current.number === child.number) {
				return this.subIssue422('Sub issue may not create a circular dependency');
			}
			current = current.parent === null ? undefined : this.require(current.parent);
		}
		if (this.levelOf(parent) + this.heightOf(child) > 8) {
			return this.subIssue422("You can't add more than 7 layers of sub-issues");
		}
		// Not measured live (needs 100 creates): the message is a guess, the limit is the documented one.
		if ([...this.issues.values()].filter(other => other.parent === parent.number).length >= 100) {
			return this.subIssue422('Issue may not contain more than 100 sub-issues');
		}
		this.setParent(child.number, parent.number);
		return { status: 201, body: this.issueJson(parent) };
	}

	private addDependency(issue: FakeIssue, input: Record<string, unknown>): WriteAnswer {
		const blocker = this.issueById(input['issue_id']);
		if (blocker === undefined) return this.notFound404();
		if (blocker.number === issue.number) {
			return this.dependency422('Target issue cannot be the same as the source issue');
		}
		if (issue.blockedBy.includes(blocker.number)) {
			return this.dependency422('Target issue has already been taken');
		}
		if (this.dependsOn(blocker, issue.number)) {
			return this.dependency422(
				'this dependency would create a cycle where the target is already blocked by the source'
			);
		}
		this.addBlockedBy(issue.number, blocker.number);
		return { status: 201, body: this.issueJson(issue) };
	}

	/** `page` pagination with `rel="next"` and `rel="last"` (labels, comments, timeline...). */
	private paged<T>(
		url: URL,
		all: readonly T[],
		map: (item: T) => unknown
	): { status: number; body: unknown; headers?: Record<string, string> } {
		const perPage = Math.min(Math.max(Number(url.searchParams.get('per_page') ?? 30), 1), 100);
		const page = Math.max(Number(url.searchParams.get('page') ?? 1), 1);
		const slice = all.slice((page - 1) * perPage, page * perPage);
		const last = Math.max(Math.ceil(all.length / perPage), 1);
		const links: string[] = [];
		const link = (target: number, rel: string): string => {
			const next = new URL(url.toString().replace(/^http:\/\/fake/, this.baseUrl));
			next.searchParams.set('page', String(target));
			return `<${next.toString()}>; rel="${rel}"`;
		};
		if (page < last) links.push(link(page + 1, 'next'), link(last, 'last'));
		return { status: 200, body: slice.map(map), headers: links.length === 0 ? {} : { link: links.join(', ') } };
	}

	/** The issue list: newest first by default, a cursor (`after`) in the Link header, pull requests included (as GitHub does). */
	private listIssues(url: URL): { status: number; body: unknown; headers?: Record<string, string> } {
		this.listCount += 1;
		const state = url.searchParams.get('state') ?? 'open';
		const direction = url.searchParams.get('direction') ?? 'desc';
		const labels = (url.searchParams.get('labels') ?? '')
			.split(',')
			.filter(label => label !== '')
			.map(label => label.toLowerCase());
		const perPage = Math.min(Math.max(Number(url.searchParams.get('per_page') ?? 30), 1), 100);
		const after = Number(url.searchParams.get('after') ?? 0);
		let list = [...this.issues.values()].filter(
			issue =>
				!issue.deleted &&
				issue.visibleAtList < this.listCount &&
				(state === 'all' || issue.state === state) &&
				labels.every(label => issue.labels.some(held => held.toLowerCase() === label))
		);
		list.sort((a, b) => a.number - b.number);
		if (direction === 'desc') list = list.reverse();
		const slice = list.slice(after, after + perPage);
		const headers: Record<string, string> = {};
		if (after + perPage < list.length) {
			const next = new URL(url.toString().replace(/^http:\/\/fake/, this.baseUrl));
			next.searchParams.set('after', String(after + perPage));
			next.searchParams.set('page', String(Math.floor((after + perPage) / perPage) + 1));
			headers['link'] = `<${next.toString()}>; rel="next"`;
		}
		return { status: 200, body: slice.map(issue => this.issueJson(issue)), headers };
	}

	private searchIssues(url: URL): { status: number; body: unknown; etag?: boolean } {
		this.searchCount += 1;
		const q = url.searchParams.get('q') ?? '';
		if (q.trim() === '') {
			return {
				status: 422,
				body: {
					message: 'Validation Failed',
					errors: [
						{
							message: 'Must include at least one user, organization, or repository',
							resource: 'Search',
							field: 'q',
							code: 'invalid',
						},
					],
					status: '422',
				},
			};
		}
		const terms = [...q.matchAll(/(\S*?"[^"]*"|\S+)/g)].map(match => match[1]!);
		let repo: string | undefined;
		let isPr = false;
		let state: string | undefined;
		const wantedLabels: string[] = [];
		const words: string[] = [];
		let titleOnly = false;
		for (const term of terms) {
			const [key, ...valueParts] = term.split(':');
			const value = valueParts.join(':').replace(/^"|"$/g, '');
			if (key === 'repo') repo = value.toLowerCase();
			else if (key === 'is' && value === 'pr') isPr = true;
			else if (key === 'is') continue;
			else if (key === 'state') state = value;
			else if (key === 'label') wantedLabels.push(value.toLowerCase());
			else if (key === 'in') titleOnly = value === 'title';
			else if (key === 'sort' || key === 'order') continue;
			else words.push(term.replace(/"/g, '').toLowerCase());
		}
		const matches =
			repo !== this.repo.toLowerCase()
				? []
				: [...this.issues.values()].filter(issue => {
						if (issue.deleted || issue.pull !== isPr) return false;
						// Hidden while fewer than `searchLagRequests` searches were made since the issue was created.
						if (this.searchCount - 1 < issue.visibleAtSearch) return false;
						if (state !== undefined && issue.state !== state) return false;
						if (!wantedLabels.every(label => issue.labels.some(held => held.toLowerCase() === label)))
							return false;
						const normalize = (text: string): string =>
							` ${text
								.toLowerCase()
								.split(/[^\p{L}\p{N}_-]+/u)
								.filter(Boolean)
								.join(' ')} `;
						const haystack = normalize(titleOnly ? issue.title : `${issue.title} ${issue.body ?? ''}`);
						// A term is a phrase: its words in a row, each a whole word.
						return words.every(word => haystack.includes(normalize(word)));
					});
		matches.sort((a, b) => (url.searchParams.get('order') === 'asc' ? a.number - b.number : b.number - a.number));
		const perPage = Math.min(Math.max(Number(url.searchParams.get('per_page') ?? 30), 1), 100);
		const page = Math.max(Number(url.searchParams.get('page') ?? 1), 1);
		return {
			status: 200,
			etag: false,
			body: {
				total_count: matches.length,
				incomplete_results: false,
				items: matches.slice((page - 1) * perPage, page * perPage).map(issue => this.issueJson(issue)),
			},
		};
	}
}
