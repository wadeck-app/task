// A fake GitHub REST server for tests: node:http on a free loopback port, state in memory, the subset of endpoints the github
// strategy READS, with the behaviours measured on the real API (design 2.2.1 and the live smoke run): ETag and 304 without
// spending the quota, Link pagination (a cursor on the issue list, `page` elsewhere), rate-limit headers, 401 / 403 / 404 / 410 / 422,
// sub-issues, dependencies, the timeline, comments, labels, and the search index that lags behind a write.
//
// Reads only, like the strategy: every other method answers 405 and is recorded in `requests`, so a test asserts that no write
// was ever sent. State is changed through the methods of the class (the way a person would on GitHub), never over HTTP.
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
	/** The search index shows the issue once this many search requests have been made. */
	visibleAtSearch: number;
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
}

export interface RequestRecord {
	method: string;
	/** Path without query, relative to the server root. */
	path: string;
	query: string;
	status: number;
	auth: 'ok' | 'missing' | 'bad';
	conditional: boolean;
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
	/** Value of `github-authentication-token-expiration`. */
	tokenExpiration?: string;
	hasIssues?: boolean;
	/** Adds `x-accepted-github-permissions` and a 403 on the issue endpoints. */
	denyIssues?: boolean;
}

export interface ForcedResponse {
	status: number;
	headers?: Record<string, string>;
	body?: unknown;
	/** Only for requests whose path starts with this. */
	pathPrefix?: string;
}

type Fault = { kind: 'respond'; response: ForcedResponse } | { kind: 'drop' } | { kind: 'hang' };

const BASE_TIME = Date.parse('2026-11-08T10:00:00Z');

const ISSUE_BASE_PATH = /^\/repos\/([^/]+)\/([^/]+)\/issues(?:\/(.*))?$/;

function sha(text: string): string {
	return crypto.createHash('sha1').update(text).digest('hex');
}

export class FakeGitHub {
	readonly requests: RequestRecord[] = [];
	readonly token: string;
	readonly repo: string;
	readonly issues = new Map<number, FakeIssue>();
	/** Repository labels (name -> color), in creation order. */
	readonly repoLabels = new Map<string, string>();
	baseUrl = '';
	private server: http.Server | undefined;
	private nextNumber = 1;
	private nextId = 1_000_000;
	private clockMs = BASE_TIME;
	private searchCount = 0;
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
	private stamp(stepMs = 5000): string {
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
			visibleAtSearch: this.searchCount + this.options.searchLagRequests,
		};
		this.issues.set(issue.number, issue);
		// Measured on the real API: the events of an issue created with labels (or a type) all carry one instant, one second after
		// its creation.
		const creationEvents = this.stamp(1000);
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
		if (patch.body !== undefined) {
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
		if (patch.state !== undefined && patch.state !== issue.state) {
			if (patch.state === 'closed') {
				issue.state = 'closed';
				issue.stateReason = patch.stateReason ?? 'completed';
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

	addBlockedBy(blocked: number, blocker: number): void {
		const a = this.require(blocked);
		const b = this.require(blocker);
		a.blockedBy.push(blocker);
		this.event(a, 'blocked_by_added', { blocked_by: this.refJson(b) });
		this.event(b, 'blocking_added', { blocking: this.refJson(a) });
	}

	removeBlockedBy(blocked: number, blocker: number): void {
		const a = this.require(blocked);
		const b = this.require(blocker);
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
		const blocking = [...this.issues.values()].filter(other => other.blockedBy.includes(issue.number));
		const openBlockers = issue.blockedBy.filter(n => this.issues.get(n)?.state === 'open');
		return {
			url: this.issueUrl(issue),
			repository_url: `${this.baseUrl}/repos/${this.repo}`,
			html_url: `https://github.com/${this.repo}/issues/${issue.number}`,
			id: issue.id,
			node_id: `I_${issue.id}`,
			number: issue.number,
			title: issue.title,
			user: { login: issue.user },
			labels: issue.labels.map(name => ({
				id: sha(name).length,
				name,
				color: this.repoLabels.get(name) ?? 'ededed',
				description: null,
			})),
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
			issue_dependencies_summary: {
				blocked_by: openBlockers.length,
				total_blocked_by: issue.blockedBy.length,
				blocking: blocking.filter(other => other.state === 'open').length,
				total_blocking: blocking.length,
			},
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
		};
		this.requests.push(record);
		req.resume();

		if (this.options.latencyMs > 0) await new Promise(resolve => setTimeout(resolve, this.options.latencyMs));

		const fault = this.nextFault(url.pathname);
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
			const { status, headers = {}, body = { message: 'forced' } } = fault.response;
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
		if (req.method !== 'GET') {
			finish(405, { message: 'The fake GitHub server serves reads only' });
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

	private nextFault(pathname: string): Fault | undefined {
		const index = this.faults.findIndex(
			fault =>
				fault.kind !== 'respond' ||
				(fault.response.pathPrefix ?? '') === '' ||
				pathname.startsWith(fault.response.pathPrefix!)
		);
		return index < 0 ? undefined : this.faults.splice(index, 1)[0];
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
					permissions: { admin: false, push: true, pull: true },
				},
			};
		}
		if (rest === '/labels') {
			const all = [...this.repoLabels].map(([name, color], index) => ({
				id: index + 1,
				name,
				color,
				description: null,
				default: false,
			}));
			return this.paged(url, all, item => item);
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
