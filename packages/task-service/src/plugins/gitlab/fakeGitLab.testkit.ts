// A fake GitLab REST API v4 server for tests: node:http on a free loopback port, state in memory (nothing on disk), the subset of
// endpoints the gitlab strategy uses. THERE IS NO REAL GITLAB BEHIND IT: it is modelled on docs.gitlab.com, so a passing test proves
// the strategy agrees with the documentation as we read it, not with GitLab. Each behaviour below is tagged:
//
//   DOCUMENTED  a docs.gitlab.com page states it (the page is in the "GitLab verification log" of the storage plan)
//   ASSUMED     the docs are silent or unclear and this is our guess; the strategy must not lean on it without saying so
//
// DOCUMENTED: PRIVATE-TOKEN / Bearer auth and `{"message":"401 Unauthorized"}`; project `:id` as numeric id or URL-encoded path;
//   iid per project with a distinct global id; state `opened`/`closed`; list filters state, labels (all required, None, Any), iids[],
//   issue_type, order_by/sort (default created_at desc), updated_after, per_page (default 20, max 100), page, Link header with
//   rel first/prev/next/last and x-* page headers; create requires `title` (`400 (Bad request) "title" not given`), description at
//   most 1048576 characters, unknown labels are created, `state`/`state_event` are not create parameters, create `issue_type` is one
//   of issue|incident|test_case|task, update `issue_type` one of issue|incident|test_case; update `labels` replaces ('' clears),
//   `add_labels` / `remove_labels` are deltas, `state_event` close|reopen; scoped labels (scope = everything before the last `::`)
//   exist on Premium/Ultimate only; DELETE issue 204 (Planner/Owner, else 403); notes: fields, `activity_filter`, `sort`,
//   `order_by`, quick actions in a note body are run and removed, carriage returns and trailing whitespace stripped; resource label
//   events (action add|remove) and resource state events (the initial state is not recorded); issue links: `link_type` relates_to |
//   blocks | is_blocked_by, POST needs target_project_id and target_issue_iid, DELETE answers the link; project labels need name AND
//   color; project fields, namespace `plan`, /version, /metadata, /personal_access_tokens/self; RateLimit-Limit/Remaining/Reset
//   headers (Reset = Unix timestamp), 429 with Retry-After and a plain text body; 403 insufficient_scope with a WWW-Authenticate
//   challenge for a read_api token.
// ASSUMED: search is a case-insensitive substring of title and description; closing a closed issue is a no-op that answers 200;
//   when `labels`, `add_labels` and `remove_labels` are all sent they apply in that order; the API params `add_labels`/`labels` swap
//   a scoped label natively (the UI does); `labels` with two labels of one scope keeps the last; label events exist for the labels
//   given at creation; a quick action in a DESCRIPTION runs too; a note holding only quick actions answers 202 and creates no note;
//   a system note cannot be edited or deleted (403); the list of links shows `link_type` as seen from the issue the list belongs to;
//   a link between a pair that already has one (any type, any direction) is a 409 `Issue already related`; blocks/is_blocked_by on
//   the free tier is a 403 `403 Forbidden`; a link to itself is a 400; a duplicate project label (case-insensitive) is a 409
//   `Label already exists`; counts only come with `with_counts`; error texts of validation failures (labels, issue_type, blank title,
//   no parameter); 404 texts `404 Not found` / `404 Label Not Found`; system notes for title/description changes; ETag/304 (off unless
//   `etags: true`: whether GitLab sends ETags on its REST API is UNVERIFIED).
// Test-only: nothing in the shipped code imports this file. Every request is recorded in `requests` with the project segment
// normalised to its numeric id (`/projects/42/issues`), so assertions do not depend on the form of the project the client used.
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeTier = 'free' | 'premium' | 'ultimate';
export type FakeIssueType = 'issue' | 'incident' | 'test_case' | 'task';
export type FakeLinkType = 'relates_to' | 'blocks' | 'is_blocked_by';

export interface FakeNote {
	id: number;
	body: string;
	author: string;
	system: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface FakeLabelEvent {
	id: number;
	createdAt: string;
	user: string;
	label: { id: number; name: string };
	action: 'add' | 'remove';
}

export interface FakeStateEvent {
	id: number;
	createdAt: string;
	user: string;
	state: 'opened' | 'closed';
}

export interface FakeIssue {
	/** The global id: distinct from the iid. */
	id: number;
	iid: number;
	title: string;
	description: string | null;
	state: 'opened' | 'closed';
	labels: string[];
	issueType: FakeIssueType;
	author: string;
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
	notes: FakeNote[];
	labelEvents: FakeLabelEvent[];
	stateEvents: FakeStateEvent[];
}

export interface FakeProjectLabel {
	id: number;
	name: string;
	color: string;
	description: string | null;
	priority: number | null;
}

interface FakeLink {
	id: number;
	/** Stored in the canonical direction: `blocks` goes source -> target, `is_blocked_by` is stored swapped. */
	source: number;
	target: number;
	type: 'relates_to' | 'blocks';
	createdAt: string;
}

export interface NewFakeIssue {
	title: string;
	description?: string | null;
	labels?: string[];
	state?: 'opened' | 'closed';
	issueType?: FakeIssueType;
	/** ISO instant of the creation; default: the fake clock. */
	createdAt?: string;
	author?: string;
}

export interface RequestRecord {
	method: string;
	/** Path without query, relative to the API root, the project segment normalised to `/projects/<id>`. */
	path: string;
	/** The path as the client sent it. */
	rawPath: string;
	query: string;
	status: number;
	auth: 'ok' | 'missing' | 'bad';
	conditional: boolean;
	/** Epoch ms at which the request arrived (real time). */
	at: number;
	/** The parsed JSON body of a write; absent for a read or a write without body. */
	body?: unknown;
}

export interface FakeGitLabOptions {
	/** The project path served. Default `group/project`. */
	project?: string;
	/** Its numeric id. Default 42. */
	projectId?: number;
	/** The token the server accepts. Default `fake-gitlab-token-for-tests`. */
	token?: string;
	/** The plan: decides scoped-label exclusivity and whether blocks/is_blocked_by links exist. Default `free`. */
	tier?: FakeTier;
	/** The quota bucket. Default 2000 remaining, resetting in a minute. */
	rateLimit?: { limit: number; remaining: number; resetAt: number; retryAfterSeconds?: number };
	/** Added to every answer. */
	latencyMs?: number;
	/** Milliseconds the fake clock moves for each change (the events of one request share one instant). Default 5000; 0 = one instant. */
	clockStepMs?: number;
	/** The token has the read_api scope only: every write is a 403 insufficient_scope. */
	readOnlyToken?: boolean;
	/** The user may delete issues. Default true. */
	canDelete?: boolean;
	/** Issues enabled in the project. Default true; false: every issue endpoint is a 403. */
	issuesEnabled?: boolean;
	/** Weak ETag on GETs and 304 on If-None-Match. Default false (UNVERIFIED that GitLab does it). */
	etags?: boolean;
	/** The `plan` the namespace endpoint reports (to make it disagree with the declared tier). Default: the tier. */
	namespacePlan?: string;
	/** The `plan` of /metadata; absent by default (the field arrived in GitLab 19.6). */
	instancePlan?: string;
	/** `permissions.project_access.access_level` of the project. Default 40 (Maintainer). */
	accessLevel?: number;
	archived?: boolean;
	tokenScopes?: string[];
	/** `expires_at` of /personal_access_tokens/self. Default null (no expiry). */
	tokenExpiresAt?: string | null;
}

export interface ForcedResponse {
	status: number;
	headers?: Record<string, string>;
	/** An object is sent as JSON, a string as plain text. */
	body?: unknown;
	/** Only for requests whose (normalised) path starts with this. */
	pathPrefix?: string;
	/** A write is APPLIED first and the forced answer is sent anyway (a 502 for something that did happen). */
	applyWrite?: boolean;
	method?: string;
	/** Let this many matching requests through first (the fault hits the one after them). */
	skip?: number;
}

interface Answer {
	status: number;
	body?: unknown;
	headers?: Record<string, string>;
	/** Plain text instead of JSON. */
	text?: string;
}

type Fault = { kind: 'respond'; response: ForcedResponse } | { kind: 'drop' } | { kind: 'hang' };

const BASE_TIME = Date.parse('2026-11-09T10:00:00.000Z');
const API = '/api/v4';
const ISSUE_TYPES: readonly string[] = ['issue', 'incident', 'test_case', 'task'];
const UPDATE_ISSUE_TYPES: readonly string[] = ['issue', 'incident', 'test_case'];
const CSS_COLORS = new Set(['red', 'blue', 'green', 'black', 'white', 'yellow', 'orange', 'purple', 'gray', 'grey']);
const DESCRIPTION_MAX = 1_048_576;
const LABELS_PER_ISSUE = 100;
const UPDATE_KEYS = [
	'title',
	'description',
	'labels',
	'add_labels',
	'remove_labels',
	'state_event',
	'issue_type',
	'discussion_locked',
	'confidential',
	'due_date',
	'assignee_ids',
	'milestone_id',
	'updated_at',
	'weight',
];

const ok = (body: unknown, headers?: Record<string, string>, status = 200): Answer => ({
	status,
	body,
	...(headers === undefined ? {} : { headers }),
});
const fail = (status: number, message: unknown): Answer => ({ status, body: { message } });
const forbidden = (): Answer => fail(403, '403 Forbidden');
const notFound = (message = '404 Not found'): Answer => fail(404, message);

async function readBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

function labelList(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	const items = Array.isArray(value) ? value.map(String) : String(value).split(',');
	return items.map(item => item.trim()).filter(item => item !== '');
}

function scopeOf(name: string): string | undefined {
	const at = name.lastIndexOf('::');
	return at > 0 ? name.slice(0, at) : undefined;
}

export class FakeGitLab {
	readonly requests: RequestRecord[] = [];
	readonly token: string;
	readonly project: string;
	readonly projectId: number;
	readonly tier: FakeTier;
	baseUrl = '';
	/** Quick actions executed in a note or a description (a test asserts none ran when it sends text that looks like one). */
	quickActionsRun = 0;
	private readonly issues = new Map<number, FakeIssue>();
	private labels: FakeProjectLabel[] = [];
	private linkRows: FakeLink[] = [];
	private server: http.Server | undefined;
	private nextIid = 1;
	private nextId = 1_000;
	private clockMs = BASE_TIME;
	private frozenAt: string | undefined;
	private rate: { limit: number; remaining: number; resetAt: number; retryAfterSeconds: number };
	private readonly faults: Fault[] = [];
	private readonly sockets = new Set<import('node:net').Socket>();
	private readonly held: http.ServerResponse[] = [];
	private readonly options: FakeGitLabOptions;
	private readonly user = 'tester';
	private readonly namespaceId = 7;

	private constructor(options: FakeGitLabOptions) {
		this.options = options;
		this.token = options.token ?? 'fake-gitlab-token-for-tests';
		this.project = options.project ?? 'group/project';
		this.projectId = options.projectId ?? 42;
		this.tier = options.tier ?? 'free';
		const rate = options.rateLimit;
		this.rate = {
			limit: rate?.limit ?? 2000,
			remaining: rate?.remaining ?? 2000,
			resetAt: rate?.resetAt ?? Math.floor(BASE_TIME / 1000) + 60,
			retryAfterSeconds: rate?.retryAfterSeconds ?? 30,
		};
	}

	static async start(options: FakeGitLabOptions = {}): Promise<FakeGitLab> {
		const fake = new FakeGitLab(options);
		fake.server = http.createServer((req, res) => void fake.handle(req, res));
		fake.server.on('connection', socket => {
			fake.sockets.add(socket);
			socket.on('close', () => fake.sockets.delete(socket));
		});
		await new Promise<void>((resolve, reject) => {
			fake.server!.once('error', reject);
			fake.server!.listen(0, '127.0.0.1', () => resolve());
		});
		fake.baseUrl = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}${API}`;
		return fake;
	}

	async stop(): Promise<void> {
		for (const res of this.held) res.destroy();
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>(resolve => this.server?.close(() => resolve()));
	}

	// ---------------------------------------------------------------- the clock

	/** The instant of a change: frozen for the length of one request (the events of one PUT share it), else the clock moves on. */
	private stamp(): string {
		if (this.frozenAt !== undefined) return this.frozenAt;
		this.clockMs += this.options.clockStepMs ?? 5000;
		return new Date(this.clockMs).toISOString();
	}

	private atOneInstant<T>(run: () => T): T {
		const outer = this.frozenAt;
		this.frozenAt ??= this.stamp();
		try {
			return run();
		} finally {
			this.frozenAt = outer;
		}
	}

	// ---------------------------------------------------------------- state, the way a person changes it on GitLab

	private get scoped(): boolean {
		return this.tier !== 'free';
	}

	private require(iid: number): FakeIssue {
		const issue = this.issues.get(iid);
		if (issue === undefined) throw new Error(`The fake server has no issue #${iid}`);
		return issue;
	}

	private ensureLabel(name: string): FakeProjectLabel {
		const known = this.labels.find(label => label.name.toLowerCase() === name.toLowerCase());
		if (known !== undefined) return known;
		const label: FakeProjectLabel = {
			id: this.nextId++,
			name,
			color: '#428BCA',
			description: null,
			priority: null,
		};
		this.labels.push(label);
		return label;
	}

	/** Adds labels the way a scoped-label tier does: a label of an occupied scope replaces the holder (ASSUMED for the API). */
	private withAdded(held: readonly string[], add: readonly string[]): string[] {
		let next = [...held];
		for (const name of add) {
			if (next.includes(name)) continue;
			const scope = this.scoped ? scopeOf(name) : undefined;
			if (scope !== undefined) next = next.filter(other => scopeOf(other) !== scope);
			next.push(name);
		}
		return next;
	}

	/** Gives an issue this label set, recording an event and a system note per difference. Returns whether anything changed. */
	private setLabels(issue: FakeIssue, labels: readonly string[], user = this.user): boolean {
		const at = this.stamp();
		const removed = issue.labels.filter(name => !labels.includes(name));
		const added = labels.filter(name => !issue.labels.includes(name));
		for (const name of removed) {
			const label = this.ensureLabel(name);
			issue.labelEvents.push({
				id: this.nextId++,
				createdAt: at,
				user,
				label: { id: label.id, name },
				action: 'remove',
			});
			this.addNote(issue, `removed ~${JSON.stringify(name)} label`, user, true);
		}
		for (const name of added) {
			const label = this.ensureLabel(name);
			issue.labelEvents.push({
				id: this.nextId++,
				createdAt: at,
				user,
				label: { id: label.id, name },
				action: 'add',
			});
			this.addNote(issue, `added ~${JSON.stringify(name)} label`, user, true);
		}
		issue.labels = [...labels];
		return removed.length + added.length > 0;
	}

	private setState(issue: FakeIssue, state: 'opened' | 'closed', user = this.user): boolean {
		if (issue.state === state) return false;
		const at = this.stamp();
		issue.state = state;
		issue.closedAt = state === 'closed' ? at : null;
		issue.stateEvents.push({ id: this.nextId++, createdAt: at, user, state });
		this.addNote(issue, state === 'closed' ? 'closed' : 'reopened', user, true);
		return true;
	}

	private addNote(issue: FakeIssue, body: string, author: string, system: boolean): FakeNote {
		const at = this.stamp();
		const note: FakeNote = { id: this.nextId++, body, author, system, createdAt: at, updatedAt: at };
		issue.notes.push(note);
		return note;
	}

	/** Runs and removes the quick actions (/close /reopen /label /unlabel) of a text; the rest of the text is returned. */
	private runQuickActions(issue: FakeIssue, text: string): { text: string; ran: number } {
		const kept: string[] = [];
		let ran = 0;
		for (const line of text.split('\n')) {
			const match = /^\/(close|reopen|label|unlabel)(?:[ \t]+(.*))?$/.exec(line.trimEnd());
			if (match === null) {
				kept.push(line);
				continue;
			}
			ran += 1;
			this.quickActionsRun += 1;
			const names = [...(match[2] ?? '').matchAll(/~(?:"([^"]+)"|(\S+))/g)].map(m => m[1] ?? m[2]!);
			switch (match[1]) {
				case 'close':
					this.setState(issue, 'closed');
					break;
				case 'reopen':
					this.setState(issue, 'opened');
					break;
				case 'label':
					this.setLabels(issue, this.withAdded(issue.labels, names));
					break;
				default:
					this.setLabels(
						issue,
						issue.labels.filter(held => !names.includes(held))
					);
			}
		}
		return { text: ran === 0 ? text : kept.join('\n').replace(/\s+$/, ''), ran };
	}

	/** An issue the way a person creates it on GitLab: labels get events at the creation instant, a closed one is closed right after. */
	seedIssue(input: NewFakeIssue): number {
		return this.atOneInstant(() => {
			const issue = this.createIssue({
				title: input.title,
				description: input.description ?? null,
				labels: input.labels ?? [],
				issueType: input.issueType ?? 'issue',
				author: input.author ?? this.user,
				...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
			});
			if (input.state === 'closed') {
				this.frozenAt = undefined;
				this.setState(issue, 'closed');
				issue.updatedAt = issue.closedAt!;
			}
			return issue.iid;
		});
	}

	private createIssue(input: {
		title: string;
		description: string | null;
		labels: readonly string[];
		issueType: FakeIssueType;
		author: string;
		createdAt?: string;
	}): FakeIssue {
		const createdAt = input.createdAt ?? this.stamp();
		const issue: FakeIssue = {
			id: this.nextId++,
			iid: this.nextIid++,
			title: input.title,
			description: input.description,
			state: 'opened',
			labels: [],
			issueType: input.issueType,
			author: input.author,
			createdAt,
			updatedAt: createdAt,
			closedAt: null,
			notes: [],
			labelEvents: [],
			stateEvents: [],
		};
		this.issues.set(issue.iid, issue);
		this.setLabels(issue, this.withAdded([], input.labels), input.author);
		if (input.description !== null && input.description !== '') {
			issue.description = this.runQuickActions(issue, input.description).text;
		}
		return issue;
	}

	seedNote(iid: number, body: string, author = this.user): number {
		const issue = this.require(iid);
		const note = this.addNote(issue, body, author, false);
		issue.updatedAt = note.createdAt;
		return note.id;
	}

	seedLabel(name: string, color = '#428BCA', description: string | null = null): number {
		const label = this.ensureLabel(name);
		label.color = color;
		label.description = description;
		return label.id;
	}

	/** A link as a person made it in the UI (no tier check): `a` is the issue the link is made FROM. */
	seedLink(a: number, b: number, type: FakeLinkType = 'relates_to'): number {
		this.require(a);
		this.require(b);
		return this.storeLink(a, b, type).id;
	}

	private storeLink(a: number, b: number, type: FakeLinkType): FakeLink {
		const link: FakeLink =
			type === 'is_blocked_by'
				? { id: this.nextId++, source: b, target: a, type: 'blocks', createdAt: this.stamp() }
				: { id: this.nextId++, source: a, target: b, type, createdAt: this.stamp() };
		this.linkRows.push(link);
		return link;
	}

	// ---------------------------------------------------------------- read-back, for assertions

	issue(iid: number): FakeIssue | undefined {
		return this.issues.get(iid);
	}

	labelsOf(iid: number): string[] {
		return [...this.require(iid).labels];
	}

	/** The comments of an issue (system notes excluded). */
	notes(iid: number): FakeNote[] {
		return this.require(iid).notes.filter(note => !note.system);
	}

	systemNotes(iid: number): FakeNote[] {
		return this.require(iid).notes.filter(note => note.system);
	}

	/** The links of an issue, the type seen from it. */
	links(iid: number): Array<{ iid: number; type: FakeLinkType }> {
		return this.linkRows.flatMap((link): Array<{ iid: number; type: FakeLinkType }> => {
			if (link.source === iid) return [{ iid: link.target, type: link.type }];
			if (link.target === iid) return [{ iid: link.source, type: this.typeSeenFrom(link, iid) }];
			return [];
		});
	}

	projectLabels(): FakeProjectLabel[] {
		return this.labels.map(label => ({ ...label }));
	}

	/** Requests other than GET (a read-only strategy must send none). */
	writes(): RequestRecord[] {
		return this.requests.filter(request => request.method !== 'GET');
	}

	requestsTo(pathPrefix: string): RequestRecord[] {
		return this.requests.filter(request => request.path.startsWith(pathPrefix));
	}

	get remaining(): number {
		return this.rate.remaining;
	}

	// ---------------------------------------------------------------- behaviours a test switches on

	/** The next `times` requests (matching method / pathPrefix when given) get this answer instead of the real one. */
	failNext(response: ForcedResponse, times = 1): void {
		for (let i = 0; i < times; i++) this.faults.push({ kind: 'respond', response: { ...response } });
	}

	/** The next request's connection is destroyed before any answer (a network failure). */
	dropNext(times = 1): void {
		for (let i = 0; i < times; i++) this.faults.push({ kind: 'drop' });
	}

	/** The next request never gets an answer (a timeout). */
	hangNext(times = 1): void {
		for (let i = 0; i < times; i++) this.faults.push({ kind: 'hang' });
	}

	/** The next `times` requests get GitLab's rate limiter answer: 429, `Retry-After`, the plain text body `Retry later`. */
	forceRateLimit(options: { retryAfterSeconds?: number; times?: number } = {}): void {
		this.failNext(
			{
				status: 429,
				body: 'Retry later',
				headers: { 'retry-after': String(options.retryAfterSeconds ?? 3) },
			},
			options.times ?? 1
		);
	}

	setRateLimit(value: { limit?: number; remaining?: number; resetAt?: number; retryAfterSeconds?: number }): void {
		Object.assign(this.rate, value);
	}

	private nextFault(path: string, method: string): Fault | undefined {
		const index = this.faults.findIndex(
			fault =>
				fault.kind !== 'respond' ||
				(((fault.response.pathPrefix ?? '') === '' || path.startsWith(fault.response.pathPrefix!)) &&
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

	// ---------------------------------------------------------------- JSON shapes

	private webUrl(issue: FakeIssue): string {
		return `https://gitlab.example/${this.project}/-/issues/${issue.iid}`;
	}

	private issueJson(issue: FakeIssue): Record<string, unknown> {
		return {
			id: issue.id,
			iid: issue.iid,
			project_id: this.projectId,
			title: issue.title,
			description: issue.description,
			state: issue.state,
			created_at: issue.createdAt,
			updated_at: issue.updatedAt,
			closed_at: issue.closedAt,
			closed_by: null,
			labels: [...issue.labels],
			type: issue.issueType.toUpperCase(),
			issue_type: issue.issueType,
			confidential: false,
			discussion_locked: null,
			author: { id: 1, username: issue.author, name: issue.author, state: 'active' },
			assignees: [],
			user_notes_count: issue.notes.filter(note => !note.system).length,
			web_url: this.webUrl(issue),
			has_tasks: false,
			references: { short: `#${issue.iid}`, relative: `#${issue.iid}`, full: `${this.project}#${issue.iid}` },
			_links: { self: `${this.baseUrl}/projects/${this.projectId}/issues/${issue.iid}` },
		};
	}

	private noteJson(issue: FakeIssue, note: FakeNote): Record<string, unknown> {
		return {
			id: note.id,
			type: null,
			body: note.body,
			author: { id: 1, username: note.author, name: note.author, state: 'active' },
			created_at: note.createdAt,
			updated_at: note.updatedAt,
			system: note.system,
			noteable_id: issue.id,
			noteable_type: 'Issue',
			project_id: this.projectId,
			noteable_iid: issue.iid,
			resolvable: false,
			confidential: false,
			internal: false,
			imported: false,
		};
	}

	private labelJson(label: FakeProjectLabel, counts: boolean): Record<string, unknown> {
		const held = [...this.issues.values()].filter(issue => issue.labels.includes(label.name));
		return {
			id: label.id,
			name: label.name,
			color: label.color,
			text_color: '#FFFFFF',
			description: label.description,
			description_html: label.description ?? '',
			...(counts
				? {
						open_issues_count: held.filter(issue => issue.state === 'opened').length,
						closed_issues_count: held.filter(issue => issue.state === 'closed').length,
						open_merge_requests_count: 0,
					}
				: {}),
			subscribed: false,
			priority: label.priority,
			is_project_label: true,
			archived: false,
		};
	}

	private linkJson(link: FakeLink, from: number): Record<string, unknown> {
		const other = link.source === from ? link.target : link.source;
		return {
			...this.issueJson(this.require(other)),
			issue_link_id: link.id,
			link_type: this.typeSeenFrom(link, from),
			link_created_at: link.createdAt,
			link_updated_at: link.createdAt,
		};
	}

	private typeSeenFrom(link: FakeLink, from: number): FakeLinkType {
		return link.type === 'blocks' && link.target === from ? 'is_blocked_by' : link.type;
	}

	private projectJson(): Record<string, unknown> {
		const enabled = this.options.issuesEnabled !== false;
		return {
			id: this.projectId,
			name: this.project.split('/').at(-1),
			path_with_namespace: this.project,
			web_url: `https://gitlab.example/${this.project}`,
			default_branch: 'main',
			archived: this.options.archived === true,
			issues_enabled: enabled,
			issues_access_level: enabled ? 'enabled' : 'disabled',
			namespace: {
				id: this.namespaceId,
				name: this.namespacePath(),
				path: this.namespacePath(),
				kind: 'group',
				full_path: this.namespacePath(),
				parent_id: null,
			},
			permissions: {
				project_access: { access_level: this.options.accessLevel ?? 40 },
				group_access: null,
			},
		};
	}

	private namespacePath(): string {
		return this.project.split('/').slice(0, -1).join('/');
	}

	// ---------------------------------------------------------------- pagination

	private paginate(items: unknown[], url: URL, rawPath: string): Answer {
		const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? 20) || 20));
		const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
		const total = items.length;
		const pages = Math.max(1, Math.ceil(total / perPage));
		const slice = items.slice((page - 1) * perPage, page * perPage);
		const at = (target: number): string => {
			const next = new URL(`${this.baseUrl.replace(API, '')}${rawPath}`);
			for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
			next.searchParams.set('page', String(target));
			next.searchParams.set('per_page', String(perPage));
			return next.toString();
		};
		const links: string[] = [];
		if (page < pages) links.push(`<${at(page + 1)}>; rel="next"`);
		if (page > 1) links.push(`<${at(page - 1)}>; rel="prev"`);
		links.push(`<${at(1)}>; rel="first"`, `<${at(pages)}>; rel="last"`);
		return ok(slice, {
			link: links.join(', '),
			'x-total': String(total),
			'x-total-pages': String(pages),
			'x-page': String(page),
			'x-per-page': String(perPage),
			'x-next-page': page < pages ? String(page + 1) : '',
			'x-prev-page': page > 1 ? String(page - 1) : '',
		});
	}

	// ---------------------------------------------------------------- HTTP

	/** `/api/v4/projects/group%2Fproject/issues` -> `/projects/42/issues`; undefined when the path is not under the API root. */
	private normalise(pathname: string): { path: string; segments: string[]; unknownProject: boolean } | undefined {
		if (!pathname.startsWith(`${API}/`)) return undefined;
		const segments = pathname
			.slice(API.length + 1)
			.split('/')
			.filter(part => part !== '');
		let unknownProject = false;
		if (segments[0] === 'projects' && segments[1] !== undefined) {
			const id = decodeURIComponent(segments[1]);
			if (id === String(this.projectId) || id === this.project) segments[1] = String(this.projectId);
			else unknownProject = true;
		}
		return { path: `/${segments.join('/')}`, segments, unknownProject };
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://fake');
		const method = req.method ?? 'GET';
		const normalised = this.normalise(url.pathname);
		const record: RequestRecord = {
			method,
			path: normalised?.path ?? url.pathname,
			rawPath: url.pathname,
			query: url.search.replace(/^\?/, ''),
			status: 0,
			auth: 'missing',
			conditional: req.headers['if-none-match'] !== undefined,
			at: Date.now(),
		};
		this.requests.push(record);
		const rawBody = await readBody(req);
		let body: Record<string, unknown> = {};
		let badJson = false;
		if (rawBody !== '') {
			try {
				const parsed: unknown = JSON.parse(rawBody);
				record.body = parsed;
				if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
					body = parsed as Record<string, unknown>;
				}
			} catch {
				badJson = true;
			}
		}
		if ((this.options.latencyMs ?? 0) > 0)
			await new Promise(resolve => setTimeout(resolve, this.options.latencyMs));

		const send = (answer: Answer): void => {
			record.status = answer.status;
			const isText = answer.text !== undefined;
			const text = isText ? answer.text! : answer.body === undefined ? '' : JSON.stringify(answer.body);
			const headers: Record<string, string> = {
				'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json',
				...answer.headers,
			};
			if (this.options.etags === true && method === 'GET' && answer.status === 200 && !isText) {
				const etag = `W/"${crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)}"`;
				headers['etag'] = etag;
				if (req.headers['if-none-match'] === etag) {
					record.status = 304;
					res.writeHead(304, headers);
					res.end();
					return;
				}
			}
			res.writeHead(answer.status, headers);
			res.end(answer.status === 304 ? undefined : text);
		};

		const fault = this.nextFault(record.path, method);
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
		if (fault?.kind === 'respond') {
			const { status, headers = {}, body: forced = { message: 'forced' }, applyWrite } = fault.response;
			if (applyWrite === true && method !== 'GET' && normalised !== undefined) {
				this.atOneInstant(() => this.route(method, normalised.segments, normalised.unknownProject, url, body));
			}
			send(typeof forced === 'string' ? { status, text: forced, headers } : { status, body: forced, headers });
			return;
		}

		const header = req.headers['private-token'];
		const bearer = req.headers['authorization'];
		const given =
			typeof header === 'string'
				? header
				: typeof bearer === 'string'
					? bearer.replace(/^Bearer /, '')
					: undefined;
		if (given === undefined || given !== this.token) {
			record.auth = given === undefined ? 'missing' : 'bad';
			send(fail(401, '401 Unauthorized'));
			return;
		}
		record.auth = 'ok';
		if (normalised === undefined) {
			send(notFound('404 Not Found'));
			return;
		}

		// DOCUMENTED: RateLimit-* on every response, a 429 with Retry-After and a plain text body when the quota is spent.
		const before = this.rate.remaining;
		this.rate.remaining = Math.max(0, before - 1);
		const rateHeaders = {
			'ratelimit-limit': String(this.rate.limit),
			'ratelimit-remaining': String(this.rate.remaining),
			'ratelimit-reset': String(this.rate.resetAt),
			'ratelimit-observed': String(this.rate.limit - this.rate.remaining),
		};
		if (before <= 0) {
			send({
				status: 429,
				text: 'Retry later',
				headers: {
					...rateHeaders,
					'ratelimit-resettime': new Date(this.rate.resetAt * 1000).toUTCString(),
					'retry-after': String(this.rate.retryAfterSeconds),
				},
			});
			return;
		}
		if (method !== 'GET' && this.options.readOnlyToken === true) {
			send({
				status: 403,
				headers: {
					...rateHeaders,
					'www-authenticate':
						'Bearer realm="Protected by OAuth 2.0", error="insufficient_scope", scope="api read_api"',
				},
				body: {
					error: 'insufficient_scope',
					error_description: 'The request requires higher privileges than provided by the access token.',
					scope: 'api',
				},
			});
			return;
		}
		if (method !== 'GET' && badJson) {
			send({ ...fail(400, '400 Bad request'), headers: rateHeaders });
			return;
		}
		const answer = this.atOneInstant(() =>
			this.route(method, normalised.segments, normalised.unknownProject, url, body)
		);
		send({ ...answer, headers: { ...rateHeaders, ...answer.headers } });
	}

	// ---------------------------------------------------------------- routes

	private route(
		method: string,
		segments: string[],
		unknownProject: boolean,
		url: URL,
		body: Record<string, unknown>
	): Answer {
		const [head, second, third] = segments;
		if (method === 'GET' && segments.length === 1 && head === 'version') {
			return ok({ version: '18.0.0-ee', revision: 'fake0000' });
		}
		if (method === 'GET' && segments.length === 1 && head === 'metadata') {
			return ok({
				version: '18.0.0-ee',
				revision: 'fake0000',
				kas: { enabled: false, externalUrl: null, version: null },
				enterprise: true,
				...(this.options.instancePlan === undefined ? {} : { plan: this.options.instancePlan }),
			});
		}
		if (method === 'GET' && head === 'personal_access_tokens' && second === 'self') {
			return ok({
				id: 1,
				name: 'fake token',
				revoked: false,
				created_at: new Date(BASE_TIME).toISOString(),
				scopes: this.options.tokenScopes ?? (this.options.readOnlyToken === true ? ['read_api'] : ['api']),
				user_id: 1,
				last_used_at: null,
				active: true,
				expires_at: this.options.tokenExpiresAt ?? null,
			});
		}
		if (method === 'GET' && head === 'namespaces' && second !== undefined && segments.length === 2) {
			const wanted = decodeURIComponent(second);
			if (wanted !== String(this.namespaceId) && wanted !== this.namespacePath())
				return notFound('404 Namespace Not Found');
			return ok({
				id: this.namespaceId,
				name: this.namespacePath(),
				path: this.namespacePath(),
				kind: 'group',
				full_path: this.namespacePath(),
				parent_id: null,
				plan: this.options.namespacePlan ?? this.tier,
			});
		}
		if (head !== 'projects' || second === undefined) return notFound('404 Not Found');
		if (unknownProject) return notFound('404 Project Not Found');
		const rawPath = `${API}/projects/${this.projectId}/${segments.slice(2).join('/')}`.replace(/\/$/, '');
		if (third === undefined) return method === 'GET' ? ok(this.projectJson()) : notFound('404 Not Found');
		if (third === 'labels') return this.labelsRoute(method, segments.slice(3), url, body, rawPath);
		if (third !== 'issues') return notFound('404 Not Found');
		if (this.options.issuesEnabled === false) return forbidden();
		return this.issuesRoute(method, segments.slice(3), url, body, rawPath);
	}

	private issuesRoute(
		method: string,
		rest: string[],
		url: URL,
		body: Record<string, unknown>,
		rawPath: string
	): Answer {
		const params = { ...Object.fromEntries(url.searchParams), ...body };
		if (rest.length === 0) {
			if (method === 'GET') return this.listIssues(url, rawPath);
			if (method === 'POST') return this.createIssueRoute(params);
			return notFound('404 Not Found');
		}
		const issue = this.issues.get(Number(rest[0]));
		if (issue === undefined || !/^\d+$/.test(rest[0]!)) return notFound();
		const tail = rest.slice(1);
		if (tail.length === 0) {
			if (method === 'GET') return ok(this.issueJson(issue));
			if (method === 'PUT') return this.updateIssue(issue, params);
			if (method === 'DELETE') {
				if (this.options.canDelete === false) return forbidden();
				this.issues.delete(issue.iid);
				this.linkRows = this.linkRows.filter(link => link.source !== issue.iid && link.target !== issue.iid);
				return { status: 204 };
			}
			return notFound('404 Not Found');
		}
		switch (tail[0]) {
			case 'notes':
				return this.notesRoute(method, issue, tail.slice(1), url, params, rawPath);
			case 'resource_label_events':
				return method === 'GET'
					? this.paginate(
							issue.labelEvents.map(event => ({
								id: event.id,
								user: { id: 1, username: event.user, name: event.user },
								created_at: event.createdAt,
								resource_type: 'Issue',
								resource_id: issue.id,
								label: {
									id: event.label.id,
									name: event.label.name,
									color: '#428BCA',
									description: null,
								},
								action: event.action,
							})),
							url,
							rawPath
						)
					: notFound('404 Not Found');
			case 'resource_state_events':
				return method === 'GET'
					? this.paginate(
							issue.stateEvents.map(event => ({
								id: event.id,
								user: { id: 1, username: event.user, name: event.user },
								created_at: event.createdAt,
								resource_type: 'Issue',
								resource_id: issue.id,
								source_commit: null,
								source_merge_request_id: null,
								state: event.state,
							})),
							url,
							rawPath
						)
					: notFound('404 Not Found');
			case 'links':
				return this.linksRoute(method, issue, tail.slice(1), url, params, rawPath);
			default:
				return notFound('404 Not Found');
		}
	}

	private listIssues(url: URL, rawPath: string): Answer {
		const query = url.searchParams;
		let items = [...this.issues.values()];
		const state = query.get('state');
		if (state === 'opened' || state === 'closed') items = items.filter(issue => issue.state === state);
		const labels = query.get('labels');
		if (labels === 'None') items = items.filter(issue => issue.labels.length === 0);
		else if (labels === 'Any') items = items.filter(issue => issue.labels.length > 0);
		else if (labels !== null && labels !== '') {
			const wanted = labelList(labels);
			items = items.filter(issue => wanted.every(name => issue.labels.includes(name)));
		}
		const search = query.get('search');
		if (search !== null && search !== '') {
			const needle = search.toLowerCase();
			items = items.filter(
				issue =>
					issue.title.toLowerCase().includes(needle) ||
					(issue.description ?? '').toLowerCase().includes(needle)
			);
		}
		const iids = [...query.getAll('iids[]'), ...query.getAll('iids')].map(Number);
		if (iids.length > 0) items = items.filter(issue => iids.includes(issue.iid));
		const type = query.get('issue_type');
		if (type !== null) items = items.filter(issue => issue.issueType === type);
		const after = query.get('updated_after');
		if (after !== null) items = items.filter(issue => Date.parse(issue.updatedAt) >= Date.parse(after));
		const orderBy = query.get('order_by') === 'updated_at' ? 'updatedAt' : 'createdAt';
		const direction = query.get('sort') === 'asc' ? 1 : -1;
		items.sort((a, b) => direction * (Date.parse(a[orderBy]) - Date.parse(b[orderBy]) || a.iid - b.iid));
		return this.paginate(
			items.map(issue => this.issueJson(issue)),
			url,
			rawPath
		);
	}

	private createIssueRoute(params: Record<string, unknown>): Answer {
		if (typeof params['title'] !== 'string' || params['title'] === '') {
			return fail(400, '400 (Bad request) "title" not given');
		}
		const description = params['description'] === undefined ? null : String(params['description']);
		if (description !== null && description.length > DESCRIPTION_MAX) {
			return fail(400, { description: [`is too long (maximum is ${DESCRIPTION_MAX} characters)`] });
		}
		const type = params['issue_type'] === undefined ? 'issue' : String(params['issue_type']);
		if (!ISSUE_TYPES.includes(type)) return fail(400, 'issue_type does not have a valid value');
		const labels = this.withAdded([], labelList(params['labels']));
		if (labels.length > LABELS_PER_ISSUE) {
			return fail(400, { labels: [`Work items can have a maximum of ${LABELS_PER_ISSUE} labels`] });
		}
		// DOCUMENTED: `state` and `state_event` are not parameters of a create.
		const issue = this.createIssue({
			title: params['title'],
			description,
			labels,
			issueType: type as FakeIssueType,
			author: this.user,
		});
		return ok(this.issueJson(issue), undefined, 201);
	}

	private updateIssue(issue: FakeIssue, params: Record<string, unknown>): Answer {
		if (!UPDATE_KEYS.some(key => params[key] !== undefined)) {
			return fail(400, `400 (Bad request) "${UPDATE_KEYS.slice(0, 7).join(', ')}" not given`);
		}
		if (params['title'] !== undefined && (typeof params['title'] !== 'string' || params['title'].trim() === '')) {
			return fail(400, { title: ["can't be blank"] });
		}
		if (typeof params['description'] === 'string' && params['description'].length > DESCRIPTION_MAX) {
			return fail(400, { description: [`is too long (maximum is ${DESCRIPTION_MAX} characters)`] });
		}
		if (params['issue_type'] !== undefined && !UPDATE_ISSUE_TYPES.includes(String(params['issue_type']))) {
			return fail(400, 'issue_type does not have a valid value');
		}
		const event = params['state_event'];
		if (event !== undefined && event !== 'close' && event !== 'reopen') {
			return fail(400, 'state_event does not have a valid value');
		}
		// ASSUMED order: labels (replace), add_labels, remove_labels.
		let labels = issue.labels;
		if (params['labels'] !== undefined) labels = this.withAdded([], labelList(params['labels']));
		if (params['add_labels'] !== undefined) labels = this.withAdded(labels, labelList(params['add_labels']));
		if (params['remove_labels'] !== undefined) {
			const gone = labelList(params['remove_labels']);
			labels = labels.filter(name => !gone.includes(name));
		}
		if (labels.length > LABELS_PER_ISSUE) {
			return fail(400, { labels: [`Work items can have a maximum of ${LABELS_PER_ISSUE} labels`] });
		}
		let changed = false;
		if (typeof params['title'] === 'string' && params['title'] !== issue.title) {
			this.addNote(issue, `changed title from **${issue.title}** to **${params['title']}**`, this.user, true);
			issue.title = params['title'];
			changed = true;
		}
		if (params['description'] !== undefined && String(params['description']) !== (issue.description ?? '')) {
			issue.description = String(params['description']);
			this.addNote(issue, 'changed the description', this.user, true);
			changed = true;
			issue.description = this.runQuickActions(issue, issue.description).text;
		}
		if (params['issue_type'] !== undefined && params['issue_type'] !== issue.issueType) {
			issue.issueType = String(params['issue_type']) as FakeIssueType;
			changed = true;
		}
		if (this.setLabels(issue, labels)) changed = true;
		if (event === 'close' && this.setState(issue, 'closed')) changed = true;
		if (event === 'reopen' && this.setState(issue, 'opened')) changed = true;
		if (changed) issue.updatedAt = this.stamp();
		return ok(this.issueJson(issue));
	}

	private notesRoute(
		method: string,
		issue: FakeIssue,
		rest: string[],
		url: URL,
		params: Record<string, unknown>,
		rawPath: string
	): Answer {
		if (rest.length === 0) {
			if (method === 'GET') {
				const filter = url.searchParams.get('activity_filter') ?? 'all_notes';
				let notes = issue.notes.filter(note =>
					filter === 'only_comments' ? !note.system : filter === 'only_activity' ? note.system : true
				);
				const key = url.searchParams.get('order_by') === 'updated_at' ? 'updatedAt' : 'createdAt';
				const direction = url.searchParams.get('sort') === 'asc' ? 1 : -1;
				notes = [...notes].sort((a, b) => direction * (Date.parse(a[key]) - Date.parse(b[key]) || a.id - b.id));
				return this.paginate(
					notes.map(note => this.noteJson(issue, note)),
					url,
					rawPath
				);
			}
			if (method === 'POST') {
				if (typeof params['body'] !== 'string' || params['body'] === '') {
					return fail(400, '400 (Bad request) "body" not given');
				}
				// DOCUMENTED: carriage returns and trailing whitespace are stripped, quick actions are run and removed.
				const cleaned = params['body']
					.replace(/\r/g, '')
					.replace(/[ \t]+$/gm, '')
					.replace(/\s+$/, '');
				const { text, ran } = this.runQuickActions(issue, cleaned);
				if (ran > 0 && text === '')
					return ok({ commands_changes: {}, summary: ['Commands applied'] }, undefined, 202);
				const note = this.addNote(issue, text, this.user, false);
				issue.updatedAt = note.createdAt;
				return ok(this.noteJson(issue, note), undefined, 201);
			}
			return notFound('404 Not Found');
		}
		const note = issue.notes.find(candidate => String(candidate.id) === rest[0]);
		if (note === undefined) return notFound('404 Note Not Found');
		if (method === 'PUT') {
			if (note.system) return forbidden();
			if (typeof params['body'] !== 'string' || params['body'] === '') {
				return fail(400, '400 (Bad request) "body" not given');
			}
			note.body = params['body']
				.replace(/\r/g, '')
				.replace(/[ \t]+$/gm, '')
				.replace(/\s+$/, '');
			note.updatedAt = this.stamp();
			issue.updatedAt = note.updatedAt;
			return ok(this.noteJson(issue, note));
		}
		if (method === 'DELETE') {
			if (note.system) return forbidden();
			issue.notes = issue.notes.filter(candidate => candidate !== note);
			return { status: 204 };
		}
		return method === 'GET' ? ok(this.noteJson(issue, note)) : notFound('404 Not Found');
	}

	private linksRoute(
		method: string,
		issue: FakeIssue,
		rest: string[],
		url: URL,
		params: Record<string, unknown>,
		rawPath: string
	): Answer {
		if (rest.length === 0) {
			if (method === 'GET') {
				const mine = this.linkRows.filter(link => link.source === issue.iid || link.target === issue.iid);
				return this.paginate(
					mine.map(link => this.linkJson(link, issue.iid)),
					url,
					rawPath
				);
			}
			if (method !== 'POST') return notFound('404 Not Found');
			const type = String(params['link_type'] ?? 'relates_to');
			if (!['relates_to', 'blocks', 'is_blocked_by'].includes(type))
				return fail(400, 'link_type does not have a valid value');
			if (params['target_project_id'] === undefined || params['target_issue_iid'] === undefined) {
				return fail(400, '400 (Bad request) "target_project_id" not given');
			}
			if (Number(params['target_project_id']) !== this.projectId) return notFound('404 Project Not Found');
			// ASSUMED: the free tier refuses the blocking link types with a 403.
			if (type !== 'relates_to' && this.tier === 'free') return forbidden();
			const targetIid = Number(params['target_issue_iid']);
			if (targetIid === issue.iid) return fail(400, 'Cannot link an issue to itself');
			const target = this.issues.get(targetIid);
			if (target === undefined) return notFound();
			const exists = this.linkRows.some(
				link =>
					(link.source === issue.iid && link.target === targetIid) ||
					(link.source === targetIid && link.target === issue.iid)
			);
			if (exists) return fail(409, 'Issue already related');
			const link = this.storeLink(issue.iid, targetIid, type as FakeLinkType);
			issue.updatedAt = link.createdAt;
			target.updatedAt = link.createdAt;
			return ok(
				{
					id: link.id,
					source_issue: this.issueJson(issue),
					target_issue: this.issueJson(target),
					link_type: type,
				},
				undefined,
				201
			);
		}
		const link = this.linkRows.find(
			candidate =>
				String(candidate.id) === rest[0] && (candidate.source === issue.iid || candidate.target === issue.iid)
		);
		if (link === undefined) return notFound();
		if (method === 'DELETE') {
			this.linkRows = this.linkRows.filter(candidate => candidate !== link);
			const other = this.require(link.source === issue.iid ? link.target : link.source);
			return ok({
				id: link.id,
				source_issue: this.issueJson(issue),
				target_issue: this.issueJson(other),
				link_type: this.typeSeenFrom(link, issue.iid),
			});
		}
		return notFound('404 Not Found');
	}

	private labelsRoute(
		method: string,
		rest: string[],
		url: URL,
		body: Record<string, unknown>,
		rawPath: string
	): Answer {
		const params = { ...Object.fromEntries(url.searchParams), ...body };
		if (rest.length === 0) {
			if (method === 'GET') {
				const search = url.searchParams.get('search')?.toLowerCase();
				const counts = url.searchParams.get('with_counts') === 'true';
				const found = this.labels.filter(
					label => search === undefined || label.name.toLowerCase().includes(search)
				);
				return this.paginate(
					found.map(label => this.labelJson(label, counts)),
					url,
					rawPath
				);
			}
			if (method !== 'POST') return notFound('404 Not Found');
			if (typeof params['name'] !== 'string' || params['name'] === '')
				return fail(400, '400 (Bad request) "name" not given');
			if (typeof params['color'] !== 'string' || params['color'] === '')
				return fail(400, '400 (Bad request) "color" not given');
			if (!this.validColor(params['color'])) return fail(400, { color: ['must be a valid color code'] });
			if (this.labels.some(label => label.name.toLowerCase() === String(params['name']).toLowerCase())) {
				return fail(409, 'Label already exists');
			}
			const label: FakeProjectLabel = {
				id: this.nextId++,
				name: params['name'],
				color: params['color'],
				description: params['description'] === undefined ? null : String(params['description']),
				priority: params['priority'] === undefined ? null : Number(params['priority']),
			};
			this.labels.push(label);
			return ok(this.labelJson(label, false), undefined, 201);
		}
		const wanted = decodeURIComponent(rest[0]!);
		const label =
			this.labels.find(candidate => String(candidate.id) === wanted) ??
			this.labels.find(candidate => candidate.name === wanted);
		if (label === undefined) return notFound('404 Label Not Found');
		if (method === 'GET') return ok(this.labelJson(label, false));
		if (method === 'PUT') {
			if (!['new_name', 'color', 'description', 'priority'].some(key => params[key] !== undefined)) {
				return fail(400, '400 (Bad request) "new_name, color" not given');
			}
			if (params['color'] !== undefined && !this.validColor(String(params['color']))) {
				return fail(400, { color: ['must be a valid color code'] });
			}
			if (typeof params['new_name'] === 'string' && params['new_name'] !== label.name) {
				const from = label.name;
				label.name = params['new_name'];
				for (const issue of this.issues.values())
					issue.labels = issue.labels.map(name => (name === from ? label.name : name));
			}
			if (params['color'] !== undefined) label.color = String(params['color']);
			if (params['description'] !== undefined) label.description = String(params['description']);
			if (params['priority'] !== undefined) label.priority = Number(params['priority']);
			return ok(this.labelJson(label, false));
		}
		if (method === 'DELETE') {
			this.labels = this.labels.filter(candidate => candidate !== label);
			for (const issue of this.issues.values()) issue.labels = issue.labels.filter(name => name !== label.name);
			return { status: 204 };
		}
		return notFound('404 Not Found');
	}

	/** DOCUMENTED: a 6-digit hex with a leading `#`, or a CSS color name (only a few names are modelled). */
	private validColor(color: string): boolean {
		return /^#[0-9a-fA-F]{6}$/.test(color) || CSS_COLORS.has(color.toLowerCase());
	}
}
