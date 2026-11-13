// A fake GitLab REST API v4 + GraphQL server for tests: node:http on a free loopback port, state in memory (nothing on disk), the
// subset of endpoints the gitlab strategy uses. It models the Free tier ONLY. It is checked against the REAL gitlab.com Free:
// gitlabConformance.test.ts replays fixtures/live-conformance.json (597 steps recorded live on 2026-11-09, with the sanitized
// answers) against it and fails on any difference in status, key headers or body. The fixture is the ground truth: where it and this
// file disagree, this file is wrong.
//
// THE LEDGER. Every behaviour is listed in fakeGitLabLedger.testkit.ts (MOCK_LEDGER, printed by scripts/gitlab-ledger-md.mjs) with its
// status: 298 lines, 258 LIVE-VERIFIED (1 waits for the tail 2 of the scenario, see below), 13 DOCUMENTED-NOT-LIVE, 27 UNVERIFIABLE and
// ZERO ASSUMED (a test keeps it at zero). The comments below say "LIVE-VERIFIED (step ...)" with the fixture step that proves the code.
//
//   LIVE-VERIFIED        recorded: a step of the fixture replays it.
//   DOCUMENTED-NOT-LIVE  a docs.gitlab.com page states it and no live probe is possible: the CLASSIC token behaviours (scopes, access
//                        levels, the project / user / metadata / members shapes), a read-only token, another role, a disabled Issues
//                        feature. Only reachable through an option (`classicToken`, `permissions`, `readOnlyToken`, `canDelete`,
//                        `issuesEnabled`, `accessLevel`...).
//   UNVERIFIABLE         cannot be probed with the test token on a Free project (the 429 quota, group labels, a weaker token, the
//                        distance between two lists' instants, ...): the ledger says why. Where the mock would invent an answer it
//                        says 501 instead (below).
//
// NOT MODELLED. What the gitlab strategy never uses and no step proves is not implemented: such a request answers 501
// `{"message":"mock: not modelled: <what>"}` with the header `x-mock-not-modelled: 1` (time tracking, award emoji, subscriptions,
// discussions, moving an issue to the project it is in, the quick actions other than close / reopen / label / unlabel / relate /
// duplicate, the parameters assignee / milestone / severity, `order_by` other than created_at / updated_at, label priority and
// archiving, global search and the instance issue list for a classic token, changing a GROUP label through the project route, GraphQL
// fields outside the hierarchy, GraphQL over GET, subscriptions). A test never relies on an invented answer.
//
// UPDATED_AT. An issue has an `edited` flag, cleared by its first PUT of any content (a no-op one included): that PUT moves `updated_at`;
// the PUTs after it move it only for a real change (LIVE-VERIFIED 2026-11-09, steps of the fresh issues W and V1).
//
// Test-only: nothing in the shipped code imports this file. Every request is recorded in `requests` with the project segment
// normalised to its numeric id (`/projects/42/issues`), so assertions do not depend on the form of the project the client used.
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
	executeGraphql,
	GqlFieldError,
	GqlForbidden,
	GqlNotModelled,
	WORK_ITEM_TYPE_IDS,
} from './fakeGitLabGraphql.testkit.js';
import type { GqlHost, GqlWorkItem } from './fakeGitLabGraphql.testkit.js';

export type FakeIssueType = 'issue' | 'incident' | 'test_case' | 'task';
export type FakeLinkType = 'relates_to' | 'blocks' | 'is_blocked_by';

export interface FakeNote {
	id: number;
	body: string;
	author: string;
	system: boolean;
	createdAt: string;
	updatedAt: string;
	/** iid of the other issue a system note speaks about: the note is hidden when that issue is deleted (LIVE-VERIFIED). */
	ref?: number;
	/** Hidden from the lists but still counted by x-total (LIVE-VERIFIED, steps "notes of U2 after the deletion"). */
	gone?: boolean;
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
	closedBy: string | null;
	confidential: boolean;
	/** `YYYY-MM-DD` or null. */
	dueDate: string | null;
	/** `discussion_locked`: null until a person sets it. */
	discussionLocked: boolean | null;
	/** iid of the issue this one was marked a duplicate of (`/duplicate`). */
	duplicateOf: number | null;
	/** Has a PUT already been applied since the creation? The FIRST one moves updated_at even when it changes nothing (LIVE-VERIFIED). */
	edited: boolean;
	/** iid of the parent work item (hierarchy), or null. */
	parentIid: number | null;
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
	/** A label of the group the project belongs to (`is_project_label: false`). */
	group?: boolean;
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
	/** The parsed body of a write (JSON, or the form fields); absent for a read or a write without body. */
	body?: unknown;
}

/** The permissions of the live test token (LIVE-VERIFIED): every Work Item and Label permission, nothing else. */
export const LIVE_TOKEN_PERMISSIONS: readonly string[] = [
	'Work Item: Read',
	'Work Item: Create',
	'Work Item: Update',
	'Work Item: Delete',
	'Label: Read',
	'Label: Create',
	'Label: Update',
	'Label: Delete',
];

export interface FakeGitLabOptions {
	/** The project path served. Default `group/project`. */
	project?: string;
	/** Its numeric id. Default 42. */
	projectId?: number;
	/** The token the server accepts. Default `fake-gitlab-token-for-tests`. */
	token?: string;
	/**
	 * Fine-grained token permissions (names such as `Work Item: Read`, `Label: Create`, `Project: Read`, `Metadata: Read`,
	 * `User: Read`, `Personal Access Token: Read`, `Namespace: Read`, `Member: Read`; `Work Item: Read (instance)` for the instance
	 * route `GET /issues/:id`), or `'all'`. Default LIVE_TOKEN_PERMISSIONS: so /user, /version, /metadata, /projects/:id ... are 403,
	 * exactly like the live token (LIVE-VERIFIED).
	 */
	permissions?: readonly string[] | 'all';
	/** A classic personal access token (DOCUMENTED-NOT-LIVE): no per-resource permission, everything readable. Same as `permissions: 'all'`. */
	classicToken?: boolean;
	/**
	 * The quota. Without this option the headers are present (100 per 60 s window, counting like GitLab) but NOTHING is refused, so
	 * a test is never throttled by accident. With it, an exhausted window answers 429 until `ratelimit-reset` (LIVE-VERIFIED).
	 * `remaining` / `resetAt` (epoch seconds) set the state the window starts in (a test of a nearly spent quota).
	 */
	rateLimit?: {
		limit?: number;
		windowSeconds?: number;
		remaining?: number;
		resetAt?: number;
		retryAfterSeconds?: number;
	};
	/** The clock of the rate limit window, epoch ms. Default Date.now. */
	clock?: () => number;
	/** Added to every answer. */
	latencyMs?: number;
	/** Milliseconds the fake clock moves for each change (the events of one request share one instant). Default 5000; 0 = one instant. */
	clockStepMs?: number;
	/** DOCUMENTED-NOT-LIVE: the token has the read_api scope only: every write is a 403 insufficient_scope. */
	readOnlyToken?: boolean;
	/** DOCUMENTED-NOT-LIVE: the user may delete issues. Default true. */
	canDelete?: boolean;
	/** DOCUMENTED-NOT-LIVE: Issues enabled in the project. Default true; false: every issue endpoint is a 403. */
	issuesEnabled?: boolean;
	/** DOCUMENTED-NOT-LIVE: `permissions.project_access.access_level` of the project. Default 40 (Maintainer). */
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
	/** The content-type of a GraphQL answer carries a charset. */
	graphql?: boolean;
}

type Fault = { kind: 'respond'; response: ForcedResponse } | { kind: 'drop' } | { kind: 'hang' };

type Params = Record<string, unknown>;

interface Bucket {
	limit: number;
	name: string;
	observed: number;
	resetAt: number;
}

interface Needed {
	kind: 'project' | 'instance' | 'user' | 'group';
	permission: string;
}

// The first segments of the routes the mock knows outside a project: without a token they are 401, anything else is the route 404.
const KNOWN_ROOTS: readonly string[] = [
	'user',
	'version',
	'metadata',
	'personal_access_tokens',
	'namespaces',
	'search',
	'issues',
];

// The work item types GitLab has that a Free project cannot convert to (LIVE-VERIFIED), by type id.
const REFUSED_WORK_ITEM_TYPES: Record<string, string> = {
	'gid://gitlab/WorkItems::Type/3': 'Test Case',
	'gid://gitlab/WorkItems::Type/4': 'Requirement',
	'gid://gitlab/WorkItems::Type/6': 'Objective',
	'gid://gitlab/WorkItems::Type/7': 'Key Result',
	'gid://gitlab/WorkItems::Type/8': 'Epic',
};

const BASE_TIME = Date.parse('2026-11-09T10:00:00.000Z');
const API = '/api/v4';
const ISSUE_TYPES: readonly string[] = ['issue', 'incident', 'test_case', 'task'];
const UPDATE_ISSUE_TYPES: readonly string[] = ['issue', 'incident', 'test_case', 'task'];
// LIVE-VERIFIED (steps "create a label with the color name <x>"): the CSS names GitLab accepts, written the way it answers a hex.
// `cyan` and `magenta` are refused (400); the others of this list are accepted.
const CSS_COLORS: Record<string, string> = {
	red: '#FF0000',
	green: '#008000',
	blue: '#0000FF',
	black: '#000000',
	white: '#FFFFFF',
	yellow: '#FFFF00',
	orange: '#FFA500',
	purple: '#800080',
	gray: '#808080',
	grey: '#808080',
	pink: '#FFC0CB',
	brown: '#A52A2A',
	aqua: '#00FFFF',
	fuchsia: '#FF00FF',
	lime: '#00FF00',
	navy: '#000080',
	teal: '#008080',
	maroon: '#800000',
	olive: '#808000',
	silver: '#C0C0C0',
};
const DESCRIPTION_MAX = 1_048_576;
const TITLE_MAX = 255;
const LABELS_PER_ISSUE = 100;
const DEFAULT_LABEL_COLOR = '#6699cc';
// LIVE-VERIFIED (step "PUT no parameter"): the parameters of an update, in GitLab's order.
const UPDATE_PARAMS = [
	'assignee_id',
	'assignee_ids',
	'confidential',
	'created_at',
	'description',
	'discussion_locked',
	'due_date',
	'start_date',
	'labels',
	'add_labels',
	'remove_labels',
	'milestone_id',
	'milestone',
	'severity',
	'state_event',
	'title',
	'issue_type',
	'weight',
	'epic_id',
	'epic_iid',
];
const RATE_LIVE = { limit: 100, name: 'burst_traffic_per_user_free_plan' };
const RATE_UNAUTHENTICATED = { limit: 500, name: 'throttle_unauthenticated_api' };
const RATE_LIMITED_TEXT =
	'Rate limit exceeded; see https://docs.gitlab.com/user/gitlab_com/rate_limits/ for more details';
const MONTHS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
];

const ok = (body: unknown, headers?: Record<string, string>, status = 200): Answer => ({
	status,
	body,
	...(headers === undefined ? {} : { headers }),
});
const fail = (status: number, message: unknown): Answer => ({ status, body: { message } });
const failError = (status: number, error: string): Answer => ({ status, body: { error } });
const forbidden = (): Answer => fail(403, '403 Forbidden');
const notFound = (message = '404 Not found'): Answer => fail(404, message);
const routeNotFound = (): Answer => failError(404, '404 Not Found');

/**
 * What the mock does not implement because the gitlab strategy never uses it and nobody verified it against the real GitLab: a 501 that
 * says so, never an invented answer. The header lets a test (or a person reading the traffic) tell it from a GitLab answer.
 */
export const NOT_MODELLED_HEADER = 'x-mock-not-modelled';
const notModelled = (what: string): Answer => ({
	status: 501,
	body: { message: `mock: not modelled: ${what}` },
	headers: { [NOT_MODELLED_HEADER]: '1' },
});

// Sub-resources of an issue that exist on GitLab and are not modelled (time tracking, reactions, subscriptions, discussions...).
const UNMODELLED_ISSUE_ROUTES: Record<string, string> = {
	time_stats: 'time tracking (time_stats)',
	time_estimate: 'time tracking (time_estimate)',
	reset_time_estimate: 'time tracking (reset_time_estimate)',
	add_spent_time: 'time tracking (add_spent_time)',
	reset_spent_time: 'time tracking (reset_spent_time)',
	award_emoji: 'award emoji',
	subscribe: 'subscriptions (subscribe)',
	unsubscribe: 'subscriptions (unsubscribe)',
	discussions: 'discussions',
	participants: 'participants',
	todo: 'to-do items',
	related_merge_requests: 'related merge requests',
	closed_by: 'closing merge requests (closed_by)',
	reorder: 'reordering issues',
	clone: 'cloning an issue',
	promote: 'promoting an issue',
	metric_images: 'metric images',
	designs: 'designs',
};

// Parameters of an issue create / update that GitLab honours and the mock does not (it would silently ignore them).
const UNMODELLED_PARAMS: readonly string[] = [
	'assignee_id',
	'assignee_ids',
	'milestone_id',
	'milestone',
	'severity',
	'created_at',
	'start_date',
	'iid',
	'move_after_id',
	'move_before_id',
	'discussion_to_resolve',
	'merge_request_to_resolve_discussions_of',
];

// Quick actions GitLab runs and the mock does not. Not in this list and not run (`/bogus`): kept as text (see the ledger).
const UNMODELLED_COMMANDS =
	/^\/(assign|unassign|reassign|milestone|remove_milestone|title|confidential|due|remove_due_date|estimate|remove_estimate|spend|remove_time_spent|weight|clear_weight|blocks|blocked_by|set_parent|remove_parent|epic|remove_epic|move|copy_metadata|create_merge_request|lock|unlock|subscribe|unsubscribe|todo|done|shrug|tableflip|award|react|cc|tag|promote|iteration|health_status|clear_health_status|severity|zoom|remove_zoom|invite_email|publish|unpublish)(?:[ \t].*)?$/;

/** The first unmodelled quick action of a text (same fence rules as the ones that run), or undefined. */
function unmodelledCommand(text: string): string | undefined {
	let fence: string | undefined;
	for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
		const fenced = /^ {0,3}(```|~~~)/.exec(line);
		if (fenced !== null) {
			fence = fence === undefined ? fenced[1] : fence === fenced[1] ? undefined : fence;
			continue;
		}
		if (fence !== undefined) continue;
		const match = UNMODELLED_COMMANDS.exec(line.trimEnd());
		if (match !== null) return `the quick action /${match[1]}`;
	}
	return undefined;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

function safeDecode(part: string): string {
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
}

/** A label list the way GitLab reads it: a comma separated string or an array whose elements may hold commas too (LIVE-VERIFIED: it SPLITS). */
function labelList(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	const items = Array.isArray(value) ? value.flatMap(item => String(item).split(',')) : String(value).split(',');
	return items.map(item => item.trim()).filter(item => item !== '');
}

/** Names sorted by plain code unit order (LIVE-VERIFIED: `CONF-DUP` before `conf-a`) without duplicates (exact case kept). */
function sortedNames(names: Iterable<string>): string[] {
	return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const escapeHtml = (text: string): string =>
	text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** LIVE-VERIFIED (step "notes of F, oldest first"): the HTML of the system note of a title change. */
function titleChangeHtml(from: string, to: string): string {
	const shortest = Math.min(from.length, to.length);
	let prefix = 0;
	while (prefix < shortest && from[prefix] === to[prefix]) prefix += 1;
	let suffix = 0;
	while (suffix < shortest - prefix && from[from.length - 1 - suffix] === to[to.length - 1 - suffix]) suffix += 1;
	const side = (text: string, kind: string): string => {
		const middle = text.slice(prefix, text.length - suffix);
		if (middle === '') return escapeHtml(text);
		return `${escapeHtml(text.slice(0, prefix))}<span class="idiff left right ${kind}">${escapeHtml(middle)}</span>${escapeHtml(
			text.slice(text.length - suffix)
		)}`;
	};
	return `<p>changed title from <code class="idiff">${side(from, 'deletion')}</code> to <code class="idiff">${side(to, 'addition')}</code></p>`;
}

/** The date of a `YYYY-MM-DD` text that is a real day, else null (LIVE-VERIFIED: anything else is ignored, not refused). */
function realDate(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (match === null) return null;
	const moment = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
	return moment.toISOString().slice(0, 10) === value ? value : null;
}

/** `2030-01-02` -> `January 02, 2030` (LIVE-VERIFIED). */
function longDate(iso: string): string {
	const [year, month, day] = iso.split('-');
	return `${MONTHS[Number(month) - 1] ?? month} ${day}, ${year}`;
}

/** The text of a description / note the way GitLab stores it: CRLF -> LF, trailing blanks of the whole text stripped (LIVE-VERIFIED). */
const cleanText = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');

function parseBool(value: unknown): boolean | undefined {
	if (value === true || value === 'true' || value === '1' || value === 1) return true;
	if (value === false || value === 'false' || value === '0' || value === 0) return false;
	return undefined;
}

function paramsFromSearch(search: URLSearchParams): Params {
	const out: Params = {};
	for (const [rawKey, value] of search) {
		const isList = rawKey.endsWith('[]');
		const key = isList ? rawKey.slice(0, -2) : rawKey;
		const previous = out[key];
		if (isList || previous !== undefined) {
			out[key] = [...(Array.isArray(previous) ? previous : previous === undefined ? [] : [previous]), value];
		} else out[key] = value;
	}
	return out;
}

/** The words of a text, lower case: runs of letters, digits and underscores. */
function wordsOf(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}_]+/u)
		.filter(word => word !== '');
}

function taskStatus(description: string | null): { count: number; completed: number; text: string } {
	if (description === null || description.trim() === '') return { count: 0, completed: 0, text: '' };
	const boxes = [...description.matchAll(/^\s*(?:[-*+]|\d+\.)\s+\[([ xX])\]/gm)];
	const completed = boxes.filter(box => box[1] !== ' ').length;
	// LIVE-VERIFIED (step "create with a checklist"): with checkboxes the issue says has_tasks false and has no task_status key at all.
	return { count: boxes.length, completed, text: boxes.length === 0 ? '0 of 0 checklist items completed' : '' };
}

function textColor(color: string): string {
	const hex = /^#([0-9a-fA-F]{6})$/.exec(color)?.[1];
	if (hex === undefined) return '#FFFFFF';
	const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
	// LIVE-VERIFIED (steps "create a label with the color ..."): the dark text is #1F1E24, and the cut is on the luminosity
	// 0.2126 R + 0.7152 G + 0.0722 B (#00FF00 is dark, #999999 is not) over 255, above 0.6.
	return (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255 > 0.6 ? '#1F1E24' : '#FFFFFF';
}

export class FakeGitLab {
	readonly requests: RequestRecord[] = [];
	readonly token: string;
	readonly project: string;
	readonly projectId: number;
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
	private readonly faults: Fault[] = [];
	private readonly sockets = new Set<import('node:net').Socket>();
	private readonly held: http.ServerResponse[] = [];
	private readonly options: FakeGitLabOptions;
	private readonly user = 'tester';
	private readonly namespaceId = 7;
	private permissions: readonly string[] | 'all';
	private readonly bucket: Bucket;
	private readonly anonymousBucket: Bucket;
	private readonly enforceRateLimit: boolean;
	private readonly windowSeconds: number;
	private retryAfterSeconds: number;

	private constructor(options: FakeGitLabOptions) {
		this.options = options;
		this.token = options.token ?? 'fake-gitlab-token-for-tests';
		this.project = options.project ?? 'group/project';
		this.projectId = options.projectId ?? 42;
		this.permissions = options.permissions ?? (options.classicToken === true ? 'all' : LIVE_TOKEN_PERMISSIONS);
		const rate = options.rateLimit;
		this.enforceRateLimit = rate !== undefined;
		this.windowSeconds = rate?.windowSeconds ?? 60;
		this.retryAfterSeconds = rate?.retryAfterSeconds ?? 2;
		const limit = rate?.limit ?? RATE_LIVE.limit;
		this.bucket = {
			limit,
			name: RATE_LIVE.name,
			observed: rate?.remaining === undefined ? 0 : Math.max(0, limit - rate.remaining),
			resetAt: rate?.resetAt ?? 0,
		};
		this.anonymousBucket = {
			limit: RATE_UNAUTHENTICATED.limit,
			name: RATE_UNAUTHENTICATED.name,
			observed: 0,
			resetAt: 0,
		};
	}

	static async start(options: FakeGitLabOptions = {}): Promise<FakeGitLab> {
		return await FakeGitLab.startOn(options, 0);
	}

	/** Like start() on a given port (0 = a free one): the standalone script uses a port the user chose. */
	static async startOn(options: FakeGitLabOptions, port: number): Promise<FakeGitLab> {
		const fake = new FakeGitLab(options);
		fake.server = http.createServer((req, res) => void fake.handle(req, res));
		fake.server.on('connection', socket => {
			fake.sockets.add(socket);
			socket.on('close', () => fake.sockets.delete(socket));
		});
		await new Promise<void>((resolve, reject) => {
			fake.server!.once('error', reject);
			fake.server!.listen(port, '127.0.0.1', () => resolve());
		});
		fake.baseUrl = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}${API}`;
		return fake;
	}

	async stop(): Promise<void> {
		for (const res of this.held) res.destroy();
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>(resolve => this.server?.close(() => resolve()));
	}

	/** Replaces the token's permissions (a test that takes a permission away in the middle of a run). */
	setPermissions(permissions: readonly string[] | 'all'): void {
		this.permissions = permissions;
	}

	// ---------------------------------------------------------------- the clock

	private now(): number {
		return (this.options.clock ?? Date.now)();
	}

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

	private static before(instant: string, ms: number): string {
		return new Date(Date.parse(instant) - ms).toISOString();
	}

	// ---------------------------------------------------------------- state, the way a person changes it on GitLab

	private require(iid: number): FakeIssue {
		const issue = this.issues.get(iid);
		if (issue === undefined) throw new Error(`The fake server has no issue #${iid}`);
		return issue;
	}

	private findLabel(name: string): FakeProjectLabel | undefined {
		return this.labels.find(label => label.name === name);
	}

	/** A label by name; unknown names are created by GitLab with its default colour (LIVE-VERIFIED: "creating labels through an issue works"). */
	private ensureLabel(name: string): FakeProjectLabel {
		const known = this.findLabel(name);
		if (known !== undefined) return known;
		const label: FakeProjectLabel = {
			id: this.nextId++,
			name,
			color: DEFAULT_LABEL_COLOR,
			description: null,
			priority: null,
		};
		this.labels.push(label);
		return label;
	}

	/** Gives an issue this label set, recording the label events (add before remove, one instant). Returns whether anything changed. */
	private setLabels(issue: FakeIssue, labels: Iterable<string>, at: string, user = this.user): boolean {
		const next = sortedNames(labels);
		const removed = issue.labels.filter(name => !next.includes(name));
		const added = next.filter(name => !issue.labels.includes(name));
		for (const name of added) {
			const label = this.ensureLabel(name);
			issue.labelEvents.push({
				id: this.nextId++,
				createdAt: at,
				user,
				label: { id: label.id, name },
				action: 'add',
			});
		}
		for (const name of removed) {
			const label = this.findLabel(name);
			if (label === undefined) continue;
			issue.labelEvents.push({
				id: this.nextId++,
				createdAt: at,
				user,
				label: { id: label.id, name },
				action: 'remove',
			});
		}
		issue.labels = next;
		return removed.length + added.length > 0;
	}

	/** LIVE-VERIFIED: closing a closed issue (or reopening an open one) records nothing and changes nothing. */
	private setState(issue: FakeIssue, state: 'opened' | 'closed', at: string, user = this.user): boolean {
		if (issue.state === state) return false;
		issue.state = state;
		issue.closedAt = state === 'closed' ? at : null;
		issue.closedBy = state === 'closed' ? user : null;
		issue.stateEvents.push({ id: this.nextId++, createdAt: at, user, state });
		return true;
	}

	private addNote(
		issue: FakeIssue,
		body: string,
		author: string,
		system: boolean,
		at = this.stamp(),
		ref?: number
	): FakeNote {
		const note: FakeNote = {
			id: this.nextId++,
			body,
			author,
			system,
			createdAt: at,
			updatedAt: at,
			...(ref === undefined ? {} : { ref }),
		};
		issue.notes.push(note);
		return note;
	}

	private systemNote(issue: FakeIssue, body: string, ref?: number): void {
		this.addNote(issue, body, this.user, true, this.stamp(), ref);
	}

	/**
	 * Runs and removes the quick actions of a text; the rest of the text is returned. LIVE-VERIFIED (steps "note with ...", "quick action
	 * ..."): not run in a code fence, in backticks or after a backslash; the command is case insensitive; `/label ~unknown` is ignored;
	 * `/reopen` on an open issue and `/close` on a closed one say "Could not apply <command> command."; `/relate` writes its note on the
	 * source issue only; `/duplicate` writes the duplicate note before the relation note on both issues. `failed` is the 400 GitLab
	 * answers when a command cannot be applied at all (`/relate` with no issue).
	 */
	private runQuickActions(
		issue: FakeIssue,
		text: string
	): {
		text: string;
		ran: number;
		changes: Record<string, unknown>;
		summary: string[];
		failed?: Answer;
	} {
		const kept: string[] = [];
		const changes: Record<string, unknown> = {};
		const summary: string[] = [];
		let ran = 0;
		let fence: string | undefined;
		for (const line of text.split('\n')) {
			const fenced = /^ {0,3}(```|~~~)/.exec(line);
			if (fenced !== null) {
				fence = fence === undefined ? fenced[1] : fence === fenced[1] ? undefined : fence;
				kept.push(line);
				continue;
			}
			const match =
				fence !== undefined
					? null
					: /^\/(close|reopen|label|unlabel|relate|duplicate)(?:[ \t]+(.*))?$/i.exec(line.trimEnd());
			if (match === null) {
				kept.push(line);
				continue;
			}
			ran += 1;
			this.quickActionsRun += 1;
			const command = match[1]!.toLowerCase();
			const argument = match[2] ?? '';
			const names = [...argument.matchAll(/~(?:"([^"]+)"|(\S+))/g)].map(m => m[1] ?? m[2]!);
			const at = this.stamp();
			switch (command) {
				case 'close':
				case 'reopen': {
					const target = command === 'close' ? 'closed' : 'opened';
					if (!this.setState(issue, target, at)) {
						summary.push(`Could not apply ${command} command.`);
						break;
					}
					issue.updatedAt = at;
					changes['state_event'] = command;
					summary.push(command === 'close' ? 'Closed this issue.' : 'Reopened this issue.');
					break;
				}
				case 'label': {
					// LIVE-VERIFIED: a label that does not exist is ignored, no label is created.
					const existing = names.filter(name => this.findLabel(name) !== undefined);
					this.setLabels(issue, [...issue.labels, ...existing], at);
					if (existing.length > 0) {
						changes['add_label_ids'] = existing.map(name => this.findLabel(name)!.id);
						summary.push(
							`Added ${existing.map(name => `~"${name}"`).join(' ')} ${existing.length === 1 ? 'label' : 'labels'}.`
						);
					}
					break;
				}
				case 'unlabel': {
					if (names.length === 0) {
						this.setLabels(issue, [], at);
						changes['label_ids'] = [];
						summary.push('Removed all labels.');
						break;
					}
					// LIVE-VERIFIED: the answer names the labels asked for, whether the issue held them or not.
					const named = names.filter(name => this.findLabel(name) !== undefined);
					this.setLabels(
						issue,
						issue.labels.filter(held => !named.includes(held)),
						at
					);
					if (named.length > 0) {
						changes['remove_label_ids'] = named.map(name => this.findLabel(name)!.id);
						summary.push(
							`Removed ${named.map(name => `~"${name}"`).join(' ')} ${named.length === 1 ? 'label' : 'labels'}.`
						);
					}
					break;
				}
				case 'relate': {
					if (argument.trim() === '')
						return {
							text,
							ran,
							changes,
							summary,
							failed: fail(400, '400 Bad request - Failed to apply commands.'),
						};
					const other = this.issues.get(Number(/#(\d+)/.exec(argument)?.[1]));
					if (other === undefined) {
						summary.push('Added  as a linked item related to this issue.');
						break;
					}
					if (other !== issue && !this.linked(issue.iid, other.iid)) {
						this.storeLink(issue.iid, other.iid, 'relates_to');
						this.systemNote(issue, `marked as related to #${other.iid}`, other.iid);
					}
					summary.push(`Added #${other.iid} as a linked item related to this issue.`);
					break;
				}
				default: {
					const other = this.issues.get(Number(/#(\d+)/.exec(argument)?.[1]));
					if (other === issue) {
						summary.push('Failed to mark the Issue as duplicate of itself.');
						break;
					}
					if (other === undefined) break;
					if (this.setState(issue, 'closed', at)) issue.updatedAt = at;
					issue.duplicateOf = other.iid;
					this.systemNote(issue, `marked this issue as a duplicate of #${other.iid}`, other.iid);
					this.systemNote(other, `marked #${issue.iid} as a duplicate of this issue`, issue.iid);
					if (!this.linked(issue.iid, other.iid)) this.relate(issue, other);
					changes['canonical_issue_id'] = other.id;
					summary.push(`Closed this Issue. Marked as related to, and a duplicate of, ${this.webUrl(other)}.`);
				}
			}
		}
		return { text: ran === 0 ? text : kept.join('\n').replace(/\s+$/, ''), ran, changes, summary };
	}

	private linked(a: number, b: number): boolean {
		return this.linkRows.some(
			link => (link.source === a && link.target === b) || (link.source === b && link.target === a)
		);
	}

	/** Makes a relates_to link with the system notes GitLab writes on both issues (LIVE-VERIFIED: "marked as related to #N"). */
	private relate(from: FakeIssue, to: FakeIssue, type: FakeLinkType = 'relates_to'): FakeLink {
		const link = this.storeLink(from.iid, to.iid, type);
		this.systemNote(from, `marked as related to #${to.iid}`, to.iid);
		this.systemNote(to, `marked as related to #${from.iid}`, from.iid);
		return link;
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
				this.setState(issue, 'closed', this.stamp());
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
		confidential?: boolean;
		dueDate?: string | null;
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
			closedBy: null,
			confidential: input.confidential ?? false,
			dueDate: input.dueDate ?? null,
			discussionLocked: null,
			duplicateOf: null,
			edited: false,
			parentIid: null,
			notes: [],
			labelEvents: [],
			stateEvents: [],
		};
		this.issues.set(issue.iid, issue);
		this.setLabels(issue, input.labels, createdAt, input.author);
		// LIVE-VERIFIED (step "notes of DD after the creation"): a due date given at creation writes its system note.
		if (issue.dueDate !== null) this.systemNote(issue, `changed due date to ${longDate(issue.dueDate)}`);
		if (input.description !== null && input.description !== '') {
			issue.description = this.runQuickActions(issue, input.description).text;
		}
		return issue;
	}

	seedNote(iid: number, body: string, author = this.user): number {
		const issue = this.require(iid);
		// LIVE-VERIFIED: a note does not move `updated_at` of the issue.
		return this.addNote(issue, body, author, false).id;
	}

	seedLabel(name: string, color = '#428BCA', description: string | null = null): number {
		const label = this.ensureLabel(name);
		label.color = color;
		label.description = description;
		return label.id;
	}

	/** A label of the group the project belongs to (`is_project_label: false`; a project label of the same name is then refused). */
	seedGroupLabel(name: string, color = '#428BCA', description: string | null = null): number {
		const label: FakeProjectLabel = {
			id: this.nextId++,
			name,
			color,
			description,
			priority: null,
			group: true,
		};
		this.labels.push(label);
		return label.id;
	}

	/** A link as a person made it in the UI (no license check): `a` is the issue the link is made FROM. */
	seedLink(a: number, b: number, type: FakeLinkType = 'relates_to'): number {
		return this.relate(this.require(a), this.require(b), type).id;
	}

	/** Puts `child` under `parent` in the work item hierarchy (no type rule: what a person can do through the UI). */
	seedParent(child: number, parent: number): void {
		const item = this.require(child);
		const target = this.require(parent);
		item.parentIid = target.iid;
		this.systemNote(target, `added #${item.iid} as child item`);
		this.systemNote(item, `added #${target.iid} as parent item`);
	}

	/** A small realistic project for a human (the standalone script): one issue per status and type, labels, a child task, a link, comments. */
	seedDemo(): void {
		this.seedLabel('status:in-progress', '#F0AD4E', 'Being worked on');
		this.seedLabel('status:cancelled', '#D9534F', 'Will not be done');
		this.seedLabel('bug', '#D9534F');
		this.seedLabel('docs', '#428BCA');
		const backlog = this.seedIssue({
			title: 'Write the onboarding guide',
			description: 'Explain the first steps.',
			labels: ['docs'],
		});
		const doing = this.seedIssue({
			title: 'Fix the login redirect',
			description: 'After a login the user lands on a blank page.',
			labels: ['bug', 'status:in-progress'],
		});
		const done = this.seedIssue({ title: 'Set up the CI pipeline', state: 'closed' });
		this.seedIssue({ title: 'Support a second payment provider', state: 'closed', labels: ['status:cancelled'] });
		const incident = this.seedIssue({ title: 'Checkout is down', issueType: 'incident', labels: ['bug'] });
		const child = this.seedIssue({ title: 'Add a regression test for the redirect', issueType: 'task' });
		this.seedParent(child, doing);
		this.seedLink(doing, incident);
		this.seedNote(doing, 'Reproduced on Firefox, not on Chrome.', 'ann');
		this.seedNote(doing, 'The session cookie is dropped by the redirect.', 'bob');
		this.seedNote(done, 'Pipeline is green on main.', 'ann');
		void backlog;
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
		return this.require(iid).notes.filter(note => !note.system && note.gone !== true);
	}

	systemNotes(iid: number): FakeNote[] {
		return this.require(iid).notes.filter(note => note.system && note.gone !== true);
	}

	/** The links of an issue, the type seen from it. */
	links(iid: number): Array<{ iid: number; type: FakeLinkType }> {
		return this.linkRows.flatMap((link): Array<{ iid: number; type: FakeLinkType }> => {
			if (link.source === iid) return [{ iid: link.target, type: link.type }];
			if (link.target === iid) return [{ iid: link.source, type: this.typeSeenFrom(link, iid) }];
			return [];
		});
	}

	/** The project labels (group labels excluded; see groupLabels()). */
	projectLabels(): FakeProjectLabel[] {
		return this.labels.filter(label => label.group !== true).map(label => ({ ...label }));
	}

	groupLabels(): FakeProjectLabel[] {
		return this.labels.filter(label => label.group === true).map(label => ({ ...label }));
	}

	/** Requests other than GET (a read-only strategy must send none). */
	writes(): RequestRecord[] {
		return this.requests.filter(request => request.method !== 'GET');
	}

	requestsTo(pathPrefix: string): RequestRecord[] {
		return this.requests.filter(request => request.path.startsWith(pathPrefix));
	}

	get remaining(): number {
		return Math.max(0, this.bucket.limit - this.bucket.observed);
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

	/**
	 * The next `times` requests get GitLab's rate limiter answer (LIVE-VERIFIED shape): 429, the plain text body, `Retry-After`
	 * (live: 2, which is misleading: the window ends later, at `ratelimit-reset`).
	 */
	forceRateLimit(options: { retryAfterSeconds?: number; times?: number } = {}): void {
		this.failNext(
			{
				status: 429,
				body: RATE_LIMITED_TEXT,
				headers: { 'retry-after': String(options.retryAfterSeconds ?? 2) },
			},
			options.times ?? 1
		);
	}

	setRateLimit(value: { limit?: number; remaining?: number; resetAt?: number; retryAfterSeconds?: number }): void {
		if (value.limit !== undefined) this.bucket.limit = value.limit;
		if (value.remaining !== undefined) this.bucket.observed = Math.max(0, this.bucket.limit - value.remaining);
		if (value.resetAt !== undefined) this.bucket.resetAt = value.resetAt;
		if (value.retryAfterSeconds !== undefined) this.retryAfterSeconds = value.retryAfterSeconds;
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

	private get webRoot(): string {
		return this.baseUrl.replace(API, '');
	}

	private webUrl(issue: FakeIssue): string {
		// LIVE-VERIFIED: `/-/work_items/N`, `/-/issues/N` for an incident.
		return `${this.webRoot}/${this.project}/-/${issue.issueType === 'incident' ? 'issues' : 'work_items'}/${issue.iid}`;
	}

	private userJson(name: string): Record<string, unknown> {
		return {
			id: name === this.user ? 1 : 2,
			username: name,
			public_email: null,
			name,
			state: 'active',
			locked: false,
			avatar_url: null,
			web_url: `${this.webRoot}/${name}`,
		};
	}

	/**
	 * The issue as GitLab sends it. LIVE-VERIFIED: `full` is 39 keys (a single issue, a create, an update), `list` 38 (no `subscribed`;
	 * the list, the issues of a link listing), `link` 29 (the issues inside a link answer: no has_tasks, task_status, _links,
	 * references, severity, subscribed, moved_to_id, imported, imported_from, service_desk_reply_to).
	 */
	private issueJson(
		issue: FakeIssue,
		shape: 'full' | 'list' | 'link' = 'full',
		detailedLabels = false
	): Record<string, unknown> {
		const tasks = taskStatus(issue.description);
		const api = `${this.baseUrl}/projects/${this.projectId}/issues/${issue.iid}`;
		const base: Record<string, unknown> = {
			id: issue.id,
			iid: issue.iid,
			project_id: this.projectId,
			title: issue.title,
			description: issue.description,
			state: issue.state,
			created_at: issue.createdAt,
			updated_at: issue.updatedAt,
			closed_at: issue.closedAt,
			closed_by: issue.closedBy === null ? null : this.userJson(issue.closedBy),
			labels: detailedLabels
				? issue.labels.map(name => this.labelDetails(this.findLabel(name)))
				: [...issue.labels],
			milestone: null,
			assignees: [],
			author: this.userJson(issue.author),
			type: issue.issueType.toUpperCase(),
			assignee: null,
			user_notes_count: issue.notes.filter(note => !note.system).length,
			merge_requests_count: 0,
			upvotes: 0,
			downvotes: 0,
			start_date: null,
			due_date: issue.dueDate,
			confidential: issue.confidential,
			discussion_locked: issue.discussionLocked,
			issue_type: issue.issueType,
			web_url: this.webUrl(issue),
			time_stats: this.timeStats(),
			task_completion_status: { count: tasks.count, completed_count: tasks.completed },
			blocking_issues_count: 0,
		};
		if (shape === 'link') return base;
		return {
			...base,
			has_tasks: tasks.count === 0,
			...(tasks.count === 0 ? { task_status: tasks.text } : {}),
			_links: {
				self: api,
				notes: `${api}/notes`,
				award_emoji: `${api}/award_emoji`,
				project: `${this.baseUrl}/projects/${this.projectId}`,
				closed_as_duplicate_of:
					issue.duplicateOf === null
						? null
						: `${this.baseUrl}/projects/${this.projectId}/issues/${issue.duplicateOf}`,
			},
			references: { short: `#${issue.iid}`, relative: `#${issue.iid}`, full: `${this.project}#${issue.iid}` },
			severity: 'UNKNOWN',
			...(shape === 'full' ? { subscribed: true } : {}),
			moved_to_id: null,
			imported: false,
			imported_from: 'none',
			service_desk_reply_to: null,
		};
	}

	private noteJson(issue: FakeIssue, note: FakeNote, changes: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			id: note.id,
			type: null,
			body: note.body,
			author: this.userJson(note.author),
			created_at: note.createdAt,
			updated_at: note.updatedAt,
			system: note.system,
			noteable_id: issue.id,
			noteable_type: 'Issue',
			project_id: this.projectId,
			resolvable: false,
			confidential: false,
			internal: false,
			imported: false,
			imported_from: 'none',
			noteable_iid: issue.iid,
			commands_changes: changes,
		};
	}

	/** LIVE-VERIFIED (steps "label events of A", "create label"): the keys of a label inside an event. */
	private labelDetails(label: FakeProjectLabel | undefined): Record<string, unknown> | null {
		if (label === undefined) return null;
		return {
			id: label.id,
			name: label.name,
			description: label.description,
			text_color: textColor(label.color),
			description_html: label.description === null ? '' : escapeHtml(label.description),
			color: label.color,
			archived: false,
		};
	}

	private labelJson(label: FakeProjectLabel, counts: boolean): Record<string, unknown> {
		const held = [...this.issues.values()].filter(issue => issue.labels.includes(label.name));
		return {
			...this.labelDetails(label),
			...(counts
				? {
						open_issues_count: held.filter(issue => issue.state === 'opened').length,
						closed_issues_count: held.filter(issue => issue.state === 'closed').length,
						open_merge_requests_count: 0,
					}
				: {}),
			subscribed: false,
			priority: label.priority,
			is_project_label: label.group !== true,
		};
	}

	private linkIssueJson(link: FakeLink, from: number): Record<string, unknown> {
		const other = link.source === from ? link.target : link.source;
		return {
			...this.issueJson(this.require(other), 'list'),
			issue_link_id: link.id,
			link_type: this.typeSeenFrom(link, from),
			link_created_at: link.createdAt,
			link_updated_at: link.createdAt,
		};
	}

	private typeSeenFrom(link: FakeLink, from: number): FakeLinkType {
		return link.type === 'blocks' && link.target === from ? 'is_blocked_by' : link.type;
	}

	/** DOCUMENTED-NOT-LIVE: the shape of a project for a token that may read it (the live token could not). */
	private projectJson(): Record<string, unknown> {
		const enabled = this.options.issuesEnabled !== false;
		return {
			id: this.projectId,
			name: this.project.split('/').at(-1),
			path_with_namespace: this.project,
			web_url: `${this.webRoot}/${this.project}`,
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

	/**
	 * LIVE-VERIFIED: offset pagination (`per_page` 0 is 400, above 100 clamps to 100, `page` 0 is page 1, beyond the end is `[]` 200 with
	 * no `prev`), headers x-*, and a `Link` whose parameters are the declared ones of the route plus `page` / `per_page`, sorted by name,
	 * the project written as the client wrote it.
	 */
	private paginate(
		items: unknown[],
		url: URL,
		linkBase: string,
		declared: Array<[string, string]>,
		hide?: (item: unknown) => boolean
	): Answer {
		const rawPer = url.searchParams.get('per_page');
		const rawPage = url.searchParams.get('page');
		let perPage = 20;
		if (rawPer !== null) {
			if (!/^-?\d+$/.test(rawPer)) return failError(400, 'per_page is invalid');
			if (Number(rawPer) === 0) return failError(400, 'per_page has a value not allowed');
			// LIVE-VERIFIED (step "list per_page -1"): a negative per_page is the default 20.
			perPage = Number(rawPer) < 0 ? 20 : Math.min(100, Number(rawPer));
		}
		let page = 1;
		if (rawPage !== null) {
			if (!/^-?\d+$/.test(rawPage)) return failError(400, 'page is invalid');
			page = Math.max(1, Number(rawPage));
		}
		const total = items.length;
		const pages = Math.max(1, Math.ceil(total / perPage));
		const slice = items.slice((page - 1) * perPage, page * perPage).filter(item => hide?.(item) !== true);
		const at = (target: number): string => {
			const pairs = [...declared, ['page', String(target)], ['per_page', String(perPage)]] as Array<
				[string, string]
			>;
			const encoded = pairs.map(([key, value]) => new URLSearchParams([[key, value]]).toString()).sort();
			return `${linkBase}?${encoded.join('&')}`;
		};
		const next = page < pages ? page + 1 : undefined;
		const previous = page > 1 && page <= pages ? page - 1 : undefined;
		const links: string[] = [];
		// LIVE-VERIFIED (steps "label events of A, one per page", "notes of F, two per page"): prev comes before next.
		if (previous !== undefined) links.push(`<${at(previous)}>; rel="prev"`);
		if (next !== undefined) links.push(`<${at(next)}>; rel="next"`);
		links.push(`<${at(1)}>; rel="first"`, `<${at(pages)}>; rel="last"`);
		return ok(slice, {
			link: links.join(', '),
			'x-total': String(total),
			'x-total-pages': String(pages),
			'x-page': String(page),
			'x-per-page': String(perPage),
			'x-next-page': next === undefined ? '' : String(next),
			'x-prev-page': previous === undefined ? '' : String(previous),
		});
	}

	// ---------------------------------------------------------------- HTTP

	/**
	 * `/api/v4/projects/group%2Fproject/issues` -> `/projects/42/issues`; undefined when the path is not under the API root.
	 * `rawProject` is the project segment as the client wrote it (the `Link` header echoes it).
	 */
	private normalise(
		pathname: string
	): { path: string; segments: string[]; unknownProject: boolean; rawProject: string | undefined } | undefined {
		if (!pathname.startsWith(`${API}/`)) return undefined;
		const raw = pathname
			.slice(API.length + 1)
			.split('/')
			.filter(part => part !== '');
		const segments = raw.map(safeDecode);
		let unknownProject = false;
		let rawProject: string | undefined;
		if (segments[0] === 'projects' && segments[1] !== undefined) {
			rawProject = raw[1];
			const id = segments[1];
			if (id === String(this.projectId) || id.toLowerCase() === this.project.toLowerCase())
				segments[1] = String(this.projectId);
			else unknownProject = true;
		}
		return { path: `/${segments.join('/')}`, segments, unknownProject, rawProject };
	}

	private rateHeaders(bucket: Bucket): Record<string, string> {
		return {
			'ratelimit-limit': String(bucket.limit),
			'ratelimit-name': bucket.name,
			'ratelimit-observed': String(bucket.observed),
			'ratelimit-remaining': String(Math.max(0, bucket.limit - bucket.observed)),
			'ratelimit-reset': String(bucket.resetAt),
		};
	}

	/** Counts a request in the fixed window of the bucket; true when it exceeds the quota. */
	private count(bucket: Bucket): boolean {
		const nowSeconds = Math.floor(this.now() / 1000);
		if (bucket.resetAt <= nowSeconds) {
			bucket.observed = 0;
			bucket.resetAt = nowSeconds + this.windowSeconds;
		}
		bucket.observed += 1;
		return bucket.observed > bucket.limit;
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://fake');
		const method = req.method ?? 'GET';
		const isGraphql = url.pathname === '/api/graphql' || url.pathname === `${API}/graphql`;
		const normalised = this.normalise(url.pathname);
		const record: RequestRecord = {
			method,
			path: normalised?.path ?? (url.pathname === `${API}/graphql` ? '/graphql' : url.pathname),
			rawPath: url.pathname,
			query: url.search.replace(/^\?/, ''),
			status: 0,
			auth: 'missing',
			conditional: req.headers['if-none-match'] !== undefined,
			at: Date.now(),
		};
		this.requests.push(record);
		const rawBody = await readBody(req);
		const contentType = String(req.headers['content-type'] ?? '')
			.split(';')[0]!
			.trim()
			.toLowerCase();
		let body: Params = {};
		let badJson = false;
		let noTypeNotJson = false;
		let unsupportedType: string | undefined;
		if (rawBody !== '') {
			if (contentType === 'application/x-www-form-urlencoded') {
				body = paramsFromSearch(new URLSearchParams(rawBody));
				record.body = body;
			} else if (contentType === 'application/json' || contentType === '') {
				try {
					const parsed: unknown = JSON.parse(rawBody);
					record.body = parsed;
					if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
						body = parsed as Params;
				} catch {
					// A body without any content-type that is not JSON: what GitLab does is unknown (the recorder, fetch, always sends a type).
					if (contentType === '') noTypeNotJson = true;
					else badJson = true;
				}
			} else unsupportedType = contentType;
		}
		if ((this.options.latencyMs ?? 0) > 0)
			await new Promise(resolve => setTimeout(resolve, this.options.latencyMs));

		const send = (answer: Answer, rate: Bucket | undefined): void => {
			record.status = answer.status;
			const isText = answer.text !== undefined;
			const text = isText ? answer.text! : answer.body === undefined ? '' : JSON.stringify(answer.body);
			const headers: Record<string, string> = {
				'x-gitlab-meta': JSON.stringify({
					correlation_id: crypto.randomBytes(12).toString('hex'),
					version: '1',
				}),
				...(rate === undefined ? {} : this.rateHeaders(rate)),
			};
			const json = answer.graphql === true ? 'application/json; charset=utf-8' : 'application/json';
			const conditional = method === 'GET' && answer.status === 200 && !isText && answer.body !== undefined;
			if (answer.status === 204) headers['cache-control'] = 'no-cache';
			else if (answer.status === 202) {
				headers['cache-control'] = 'no-cache';
				headers['content-type'] = json;
			} else if (answer.status >= 400) {
				headers['cache-control'] = 'no-store, private, max-age=0';
				headers['content-type'] = isText ? 'text/plain' : json;
			} else {
				headers['cache-control'] = 'max-age=0, private, must-revalidate';
				headers['content-type'] = isText ? 'text/plain' : json;
				if (!isText && answer.body !== undefined) {
					headers['etag'] = `W/"${crypto.createHash('md5').update(text).digest('hex')}"`;
				}
			}
			Object.assign(headers, answer.headers);
			if (conditional) {
				const given = String(req.headers['if-none-match'] ?? '')
					.split(',')
					.map(part => part.trim());
				// LIVE-VERIFIED (step "get A with If-None-Match star"): `*` is NOT a match, the answer is a normal 200.
				if (given.includes(headers['etag']!)) {
					record.status = 304;
					delete headers['content-type'];
					res.writeHead(304, headers);
					res.end();
					return;
				}
			}
			res.writeHead(answer.status, headers);
			res.end(text);
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
				this.atOneInstant(() =>
					this.route(
						method,
						normalised.segments,
						normalised.unknownProject,
						url,
						{ ...paramsFromSearch(url.searchParams), ...body },
						normalised.rawProject
					)
				);
			}
			send(
				typeof forced === 'string' ? { status, text: forced, headers } : { status, body: forced, headers },
				undefined
			);
			return;
		}

		// LIVE-VERIFIED (step "invalid json"): refused before authentication and before the rate limit, so no ratelimit header.
		if (badJson) {
			send(failError(400, 'Invalid JSON format'), undefined);
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
			this.count(this.anonymousBucket);
			// LIVE-VERIFIED: no token on a private project is 404 (its existence is not revealed), a bad token 401; both with the
			// unauthenticated quota. LIVE-VERIFIED (steps "GET version without a token", "GET an unknown route without a token"): no token on
			// a known route that is not a project route is 401, on an unknown route the route 404. GraphQL answers an anonymous request
			// (it only sees what is public, so no work item) and a bad token with {errors:[{message:"Invalid token"}]}.
			if (isGraphql && method === 'POST') {
				if (given !== undefined) {
					send(
						{ status: 401, body: { errors: [{ message: 'Invalid token' }] }, graphql: true },
						this.anonymousBucket
					);
					return;
				}
				send(this.graphqlRoute(body, true), this.anonymousBucket);
				return;
			}
			const head = normalised?.segments[0];
			const hidden = given === undefined && head === 'projects';
			const unknownRoute =
				given === undefined && head !== undefined && !KNOWN_ROOTS.includes(head) && head !== 'projects';
			send(
				hidden
					? notFound('404 Project Not Found')
					: unknownRoute
						? routeNotFound()
						: fail(401, '401 Unauthorized'),
				this.anonymousBucket
			);
			return;
		}
		record.auth = 'ok';

		// LIVE-VERIFIED: quota counted per window; during an exhausted window every request is 429, `retry-after` is misleading.
		if (this.count(this.bucket) && this.enforceRateLimit) {
			send(
				{
					status: 429,
					text: RATE_LIMITED_TEXT,
					headers: {
						'ratelimit-resettime': new Date(this.bucket.resetAt * 1000).toUTCString(),
						'retry-after': String(this.retryAfterSeconds),
					},
				},
				this.bucket
			);
			return;
		}
		if (unsupportedType !== undefined) {
			send(failError(415, `The provided content-type '${unsupportedType}' is not supported.`), this.bucket);
			return;
		}
		if (noTypeNotJson) {
			send(notModelled('a body without a content-type that is not JSON'), this.bucket);
			return;
		}
		// DOCUMENTED-NOT-LIVE: a read_api token cannot write.
		if (method !== 'GET' && this.options.readOnlyToken === true) {
			send(
				{
					status: 403,
					headers: {
						'www-authenticate':
							'Bearer realm="Protected by OAuth 2.0", error="insufficient_scope", scope="api read_api"',
					},
					body: {
						error: 'insufficient_scope',
						error_description: 'The request requires higher privileges than provided by the access token.',
						scope: 'api',
					},
				},
				this.bucket
			);
			return;
		}
		if (isGraphql) {
			if (method !== 'POST') {
				send(notModelled(`GraphQL over ${method} (the strategy only POSTs)`), this.bucket);
				return;
			}
			send(this.graphqlRoute(body), this.bucket);
			return;
		}
		if (normalised === undefined) {
			send(routeNotFound(), this.bucket);
			return;
		}
		// LIVE-VERIFIED (step "unknown project"): the project is looked up before the permission is checked.
		const needed = this.neededPermission(method, normalised.segments);
		if (needed !== undefined && needed.kind === 'project' && normalised.unknownProject) {
			send(this.unknownProjectAnswer(method, normalised.segments[2]), this.bucket);
			return;
		}
		if (needed !== undefined && !this.holds(needed)) {
			send(this.deniedAnswer(needed), this.bucket);
			return;
		}
		const params: Params = { ...paramsFromSearch(url.searchParams), ...body };
		const answer = this.atOneInstant(() =>
			this.route(method, normalised.segments, normalised.unknownProject, url, params, normalised.rawProject)
		);
		send(answer, this.bucket);
	}

	/**
	 * LIVE-VERIFIED: reading the issues of a project that does not exist is 404 "Project Not Found" (steps "unknown project", "list in an
	 * unknown project by its numeric id"); every other request on it (a create, the labels, the project itself) is the plain "404 Not Found"
	 * (steps "create in an unknown project", "labels of an unknown project", "GET an unknown project (denied route)").
	 */
	private unknownProjectAnswer(method: string, third: string | undefined): Answer {
		return method === 'GET' && (third === 'issues' || third === 'issues_statistics')
			? notFound('404 Project Not Found')
			: notFound('404 Not Found');
	}

	// ---------------------------------------------------------------- fine-grained permissions

	/** The permission a route needs and the word GitLab prints for it. LIVE-VERIFIED by the steps "GET <route> (denied)". */
	private neededPermission(method: string, segments: string[]): Needed | undefined {
		const action =
			method === 'GET' ? 'Read' : method === 'POST' ? 'Create' : method === 'DELETE' ? 'Delete' : 'Update';
		const [head, second, third] = segments;
		if (head === 'user') return { kind: 'user', permission: 'User: Read' };
		if (head === 'version' || head === 'metadata') return { kind: 'instance', permission: 'Metadata: Read' };
		if (head === 'personal_access_tokens') return { kind: 'user', permission: 'Personal Access Token: Read' };
		// LIVE-VERIFIED (steps "GET <route> (denied)"): the word before "permissions" is user for the namespace, the search and the
		// instance issue list, instance for the metadata and the issue by global id.
		if (head === 'namespaces') return { kind: 'user', permission: 'Namespace: Read' };
		if (head === 'search') return { kind: 'user', permission: 'Global Search: Use' };
		if (head === 'issues' && second === undefined) return { kind: 'user', permission: 'Work Item: Read' };
		if (head === 'issues') return { kind: 'instance', permission: 'Work Item: Read' };
		if (head !== 'projects' || second === undefined) return undefined;
		if (third === undefined) return method === 'GET' ? { kind: 'project', permission: 'Project: Read' } : undefined;
		if (third === 'issues' || third === 'issues_statistics')
			return { kind: 'project', permission: `Work Item: ${action}` };
		if (third === 'labels') return { kind: 'project', permission: `Label: ${action}` };
		if (third === 'members') return { kind: 'project', permission: 'Member: Read' };
		// LIVE-VERIFIED (step "GET languages (denied)"): the languages need the project read.
		if (third === 'languages') return { kind: 'project', permission: 'Project: Read' };
		if (third === 'hooks') return { kind: 'project', permission: 'Webhook: Read' };
		return undefined;
	}

	private holds(needed: Needed): boolean {
		if (this.permissions === 'all') return true;
		// The instance-wide Work Item read is a different grant from the project one the live token had.
		const name =
			(needed.kind === 'instance' || needed.kind === 'user') && needed.permission === 'Work Item: Read'
				? 'Work Item: Read (instance)'
				: needed.permission;
		return this.permissions.includes(name);
	}

	/** LIVE-VERIFIED shape. */
	private deniedAnswer(needed: Needed): Answer {
		return {
			status: 403,
			body: {
				error: 'insufficient_granular_scope',
				error_description: `Access denied: This operation requires a fine-grained personal access token with the following ${needed.kind} permissions: [${needed.permission}].`,
			},
		};
	}

	// ---------------------------------------------------------------- routes

	private route(
		method: string,
		segments: string[],
		unknownProject: boolean,
		url: URL,
		params: Params,
		rawProject: string | undefined
	): Answer {
		const [head, second, third] = segments;
		// DOCUMENTED-NOT-LIVE: the instance and token endpoints exist for a token that may read them (the live one could not).
		if (method === 'GET' && segments.length === 1 && head === 'version') {
			return ok({ version: '18.0.0-ee', revision: 'fake0000' });
		}
		if (method === 'GET' && segments.length === 1 && head === 'metadata') {
			return ok({
				version: '18.0.0-ee',
				revision: 'fake0000',
				kas: { enabled: false, externalUrl: null, version: null },
				enterprise: true,
			});
		}
		if (method === 'GET' && segments.length === 1 && head === 'user') {
			return ok({ ...this.userJson(this.user), is_admin: false });
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
			if (second !== String(this.namespaceId) && second !== this.namespacePath())
				return notFound('404 Namespace Not Found');
			return ok({
				id: this.namespaceId,
				name: this.namespacePath(),
				path: this.namespacePath(),
				kind: 'group',
				full_path: this.namespacePath(),
				parent_id: null,
				plan: 'free',
			});
		}
		if (method === 'GET' && head === 'search')
			return notModelled('global search (the strategy lists with the project route)');
		if (method === 'GET' && head === 'issues' && second === undefined)
			return notModelled('the instance-wide issue list (the strategy lists with the project route)');
		if (method === 'GET' && head === 'issues' && second !== undefined && segments.length === 2) {
			const found = [...this.issues.values()].find(issue => String(issue.id) === second);
			return found === undefined ? notFound() : ok(this.issueJson(found));
		}
		if (head !== 'projects' || second === undefined) return routeNotFound();
		if (unknownProject) return this.unknownProjectAnswer(method, third);
		const projectRef = rawProject ?? String(this.projectId);
		const linkRoot = `${this.baseUrl}/projects/${projectRef}`;
		const idParam: [string, string] = ['id', safeDecode(projectRef)];
		if (third === undefined) return method === 'GET' ? ok(this.projectJson()) : routeNotFound();
		if (third === 'labels') return this.labelsRoute(method, segments.slice(3), url, params, linkRoot, idParam);
		if (third === 'members' && method === 'GET')
			return ok([{ id: 1, username: this.user, access_level: this.options.accessLevel ?? 40 }]);
		if (third === 'languages' && method === 'GET') return ok({});
		if (third === 'hooks' && method === 'GET') return ok([]);
		if (third !== 'issues' && third !== 'issues_statistics') return routeNotFound();
		if (this.options.issuesEnabled === false) return forbidden();
		if (third === 'issues_statistics') return method === 'GET' ? this.statistics(params) : routeNotFound();
		return this.issuesRoute(method, segments.slice(3), url, params, linkRoot, idParam);
	}

	private issuesRoute(
		method: string,
		rest: string[],
		url: URL,
		params: Params,
		linkRoot: string,
		idParam: [string, string]
	): Answer {
		if (rest.length === 0) {
			if (method === 'GET') return this.listIssues(url, params, linkRoot, idParam);
			if (method === 'POST') return this.createIssueRoute(params);
			return routeNotFound();
		}
		// LIVE-VERIFIED: a non numeric iid is a 400, an unknown one a 404 (the route takes ONLY the iid, not the global id).
		// LIVE-VERIFIED (step "events of a non numeric issue"): under a sub-resource the same mistake is the plain 404.
		if (!/^\d+$/.test(rest[0]!)) return rest.length > 1 ? notFound() : failError(400, 'issue_iid is invalid');
		const issue = this.issues.get(Number(rest[0]));
		const tail = rest.slice(1);
		if (issue === undefined) {
			if (tail.length === 0 && method === 'DELETE') return notFound('404 Issue Not Found');
			return notFound();
		}
		const issueLink = `${linkRoot}/issues/${issue.iid}`;
		if (tail.length === 0) {
			if (method === 'GET') return ok(this.issueJson(issue));
			if (method === 'PUT') return this.updateIssue(issue, params);
			if (method === 'DELETE') {
				if (this.options.canDelete === false) return forbidden();
				this.deleteIssue(issue);
				return { status: 204 };
			}
			return routeNotFound();
		}
		switch (tail[0]) {
			case 'notes':
				return this.notesRoute(method, issue, tail.slice(1), url, params, issueLink, idParam);
			case 'resource_label_events':
				return method === 'GET'
					? this.paginate(
							issue.labelEvents.map(event => ({
								id: event.id,
								user: this.userJson(event.user),
								created_at: event.createdAt,
								resource_type: 'Issue',
								resource_id: issue.id,
								label: this.labelDetails(this.labels.find(label => label.id === event.label.id)),
								action: event.action,
							})),
							url,
							`${issueLink}/resource_label_events`,
							[['eventable_id', String(issue.iid)], idParam]
						)
					: routeNotFound();
			case 'resource_state_events':
				return method === 'GET'
					? this.paginate(
							issue.stateEvents.map(event => ({
								id: event.id,
								user: this.userJson(event.user),
								created_at: event.createdAt,
								resource_type: 'Issue',
								resource_id: issue.id,
								source_commit: null,
								source_merge_request_id: null,
								// LIVE-VERIFIED: `closed` and `reopened`, never `opened`.
								state: event.state === 'opened' ? 'reopened' : 'closed',
							})),
							url,
							`${issueLink}/resource_state_events`,
							[['eventable_id', String(issue.iid)], idParam]
						)
					: routeNotFound();
			case 'links':
				return this.linksRoute(method, issue, tail.slice(1), params);
			case 'move': {
				if (method !== 'POST') return routeNotFound();
				// Only the two refusals a one-project mock can answer: the target is required, and any other project is unknown. A move
				// to the project itself, or a real move (a copy with a new iid), is not modelled.
				const missing = this.missingParams(params, ['to_project_id']);
				if (missing !== undefined) return missing;
				return String(params['to_project_id']) === String(this.projectId)
					? notModelled('moving an issue to the project it is already in')
					: notFound('404 Project Not Found');
			}
			default: {
				const unmodelled = tail[0] === undefined ? undefined : UNMODELLED_ISSUE_ROUTES[tail[0]];
				return unmodelled === undefined ? routeNotFound() : notModelled(unmodelled);
			}
		}
	}

	/** The `time_stats` object of an issue: time tracking is not modelled, so it always says "nothing tracked" (LIVE-VERIFIED shape). */
	private timeStats(): Record<string, unknown> {
		return {
			time_estimate: 0,
			total_time_spent: 0,
			human_time_estimate: null,
			human_total_time_spent: null,
		};
	}

	private deleteIssue(issue: FakeIssue): void {
		this.issues.delete(issue.iid);
		this.linkRows = this.linkRows.filter(link => link.source !== issue.iid && link.target !== issue.iid);
		// LIVE-VERIFIED (steps "notes of U2 after the deletion", "notes of DK after its parent was deleted"): the system notes of the other
		// issues that speak about the deleted one go with it.
		for (const other of this.issues.values()) {
			if (other.parentIid === issue.iid) other.parentIid = null;
			for (const note of other.notes) if (note.system && note.ref === issue.iid) note.gone = true;
		}
	}

	/** The filters shared by the list and the statistics. */
	private filterIssues(params: Params, withState: boolean): FakeIssue[] | Answer {
		let items = [...this.issues.values()];
		const state = params['state'];
		if (state !== undefined && !['opened', 'closed', 'all'].includes(String(state)))
			return failError(400, 'state does not have a valid value');
		if (withState && (state === 'opened' || state === 'closed'))
			items = items.filter(issue => issue.state === state);
		const type = params['issue_type'];
		if (type !== undefined) {
			if (!ISSUE_TYPES.includes(String(type))) return failError(400, 'issue_type does not have a valid value');
			items = items.filter(issue => issue.issueType === type);
		}
		const labels = params['labels'];
		if (labels === 'None') items = items.filter(issue => issue.labels.length === 0);
		else if (labels === 'Any') items = items.filter(issue => issue.labels.length > 0);
		else if (labels !== undefined && labels !== '') {
			const wanted = labelList(labels);
			items = items.filter(issue => wanted.every(name => issue.labels.includes(name)));
		}
		// LIVE-VERIFIED (steps "list Z not ..."): not[labels] leaves out an issue holding ANY of the labels.
		const notNested =
			typeof params['not'] === 'object' && params['not'] !== null
				? (params['not'] as Params)['labels']
				: undefined;
		const unwanted = labelList(params['not[labels]'] ?? notNested);
		if (unwanted.length > 0) items = items.filter(issue => !unwanted.some(name => issue.labels.includes(name)));
		// LIVE-VERIFIED (steps "list search ..."): the search words must ALL start a word of the title or of the description (any order,
		// case-insensitive, one character is enough, the middle of a word is not); `in=` takes title and/or description, any other value
		// is ignored and both are searched.
		const search = params['search'];
		if (search !== undefined && search !== '') {
			const terms = wordsOf(String(search));
			const asked = labelList(params['in']).filter(field => field === 'title' || field === 'description');
			const fields = asked.length === 0 ? ['title', 'description'] : asked;
			items = items.filter(issue => {
				const words = [
					...(fields.includes('title') ? wordsOf(issue.title) : []),
					...(fields.includes('description') ? wordsOf(issue.description ?? '') : []),
				];
				return terms.every(term => words.some(word => word.startsWith(term)));
			});
		}
		// LIVE-VERIFIED (step "list a non numeric iid"): an iid that is not a number counts as 0.
		const iids = (
			Array.isArray(params['iids']) ? params['iids'] : params['iids'] === undefined ? [] : [params['iids']]
		).map(value => parseInt(String(value), 10) || 0);
		if (iids.length > 0) items = items.filter(issue => iids.includes(issue.iid));
		for (const [key, field, sign] of [
			['updated_after', 'updatedAt', 1],
			['updated_before', 'updatedAt', -1],
			['created_after', 'createdAt', 1],
			['created_before', 'createdAt', -1],
		] as const) {
			const bound = params[key];
			if (bound === undefined) continue;
			const limit = Date.parse(String(bound));
			// LIVE-VERIFIED (step "list created_after not a date"): 400 "<name> is invalid".
			if (Number.isNaN(limit)) return failError(400, `${key} is invalid`);
			items = items.filter(issue => sign * (Date.parse(issue[field]) - limit) >= 0);
		}
		return items;
	}

	private listIssues(url: URL, params: Params, linkRoot: string, idParam: [string, string]): Answer {
		const orderBy = params['order_by'] ?? 'created_at';
		const sortParam = params['sort'] ?? 'desc';
		// Only created_at and updated_at are modelled: the other orders GitLab has (priority, due_date, ...) answer 501, not an order
		// the mock would make up. LIVE-VERIFIED (step "list bad order_by"): anything else is a 400.
		const otherOrders = [
			'priority',
			'due_date',
			'relative_position',
			'label_priority',
			'milestone_due',
			'popularity',
			'weight',
		];
		if (otherOrders.includes(String(orderBy))) return notModelled(`order_by=${String(orderBy)}`);
		if (!['created_at', 'updated_at'].includes(String(orderBy)))
			return failError(400, 'order_by does not have a valid value');
		if (!['asc', 'desc'].includes(String(sortParam))) return failError(400, 'sort does not have a valid value');
		const filtered = this.filterIssues(params, true);
		if (!Array.isArray(filtered)) return filtered;
		const key = orderBy === 'updated_at' ? 'updatedAt' : 'createdAt';
		const direction = sortParam === 'asc' ? 1 : -1;
		const items = [...filtered].sort(
			(a, b) => direction * (Date.parse(a[key]) - Date.parse(b[key]) || a.iid - b.iid)
		);
		const detailed = parseBool(params['with_labels_details']) === true;
		// The declared parameters GitLab echoes: the client's own plus the defaults, lists written `name[]`.
		const declared: Array<[string, string]> = [idParam];
		const given = new Set<string>();
		for (const [rawKey, value] of url.searchParams) {
			const key2 = rawKey.replace(/\[\]$/, '');
			if (['page', 'per_page', 'private_token', 'id', 'cursor'].includes(key2)) continue;
			given.add(key2);
			if (key2 === 'labels' || key2 === 'not[labels]') {
				for (const name of labelList(value)) declared.push([`${key2}[]`, name]);
			} else if (key2 === 'iids') {
				// LIVE-VERIFIED (step "list a non numeric iid"): the Link echoes the iid as a number (abc is 0).
				declared.push([rawKey, String(parseInt(value, 10) || 0)]);
			} else if (['created_after', 'created_before', 'updated_after', 'updated_before'].includes(key2)) {
				// LIVE-VERIFIED (step "list created_after in the future"): a date is echoed as 2999-01-01T00:00:00+00:00.
				const parsed = Date.parse(value);
				declared.push([
					rawKey,
					Number.isNaN(parsed) ? value : new Date(parsed).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
				]);
			} else if (rawKey.endsWith('[]')) declared.push([rawKey, value]);
			else declared.push([rawKey, value]);
		}
		for (const [key2, value] of [
			['order_by', 'created_at'],
			['sort', 'desc'],
			['state', 'all'],
			['with_labels_details', 'false'],
		] as const) {
			if (!given.has(key2)) declared.push([key2, value]);
		}
		if (params['pagination'] === 'keyset')
			return this.keysetPage(items, url, `${linkRoot}/issues`, declared, issue =>
				this.issueJson(issue, 'list', detailed)
			);
		return this.paginate(
			items.map(issue => this.issueJson(issue, 'list', detailed)),
			url,
			`${linkRoot}/issues`,
			declared
		);
	}

	/**
	 * LIVE-VERIFIED (step "list keyset pagination"): with pagination=keyset there is no x-* header, and only a next link holding an opaque
	 * cursor (and page=1); the last page has no link. The cursor here is the base64 of the iid of the last item sent.
	 */
	private keysetPage(
		items: FakeIssue[],
		url: URL,
		linkBase: string,
		declared: Array<[string, string]>,
		render: (issue: FakeIssue) => Record<string, unknown>
	): Answer {
		const rawPer = url.searchParams.get('per_page');
		const perPage = rawPer === null || Number(rawPer) < 1 ? 20 : Math.min(100, Number(rawPer));
		const cursor = url.searchParams.get('cursor');
		let start = 0;
		if (cursor !== null) {
			try {
				const last = (JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as { i: number }).i;
				start = items.findIndex(issue => issue.iid === last) + 1;
			} catch {
				return failError(400, 'cursor is invalid');
			}
		}
		const slice = items.slice(start, start + perPage);
		if (start + perPage >= items.length) return ok(slice.map(render));
		const next = Buffer.from(JSON.stringify({ i: slice.at(-1)!.iid, _kd: 'n' })).toString('base64');
		const pairs: Array<[string, string]> = [
			...declared,
			['cursor', next],
			['page', '1'],
			['per_page', String(perPage)],
		];
		const encoded = pairs.map(([key, value]) => new URLSearchParams([[key, value]]).toString()).sort();
		return ok(slice.map(render), { link: `<${linkBase}?${encoded.join('&')}>; rel="next"` });
	}

	private statistics(params: Params): Answer {
		const items = this.filterIssues(params, false);
		if (!Array.isArray(items)) return items;
		const opened = items.filter(issue => issue.state === 'opened').length;
		return ok({ statistics: { counts: { all: items.length, closed: items.length - opened, opened } } });
	}

	private titleProblems(title: string, errors: Record<string, string[]>): void {
		if (title === '') errors['title'] = ["can't be blank"];
		else if (title.length > TITLE_MAX) errors['title'] = [`is too long (maximum is ${TITLE_MAX} characters)`];
	}

	private descriptionProblems(description: string | null, errors: Record<string, string[]>): void {
		// LIVE-VERIFIED (steps "create with a description of 1048577 characters", "... 600000 two-byte characters"): the limit is 1 MiB of
		// BYTES; the text says the size in MiB with two decimals at most ("1.14 MiB").
		const bytes = description === null ? 0 : Buffer.byteLength(description, 'utf8');
		if (bytes > DESCRIPTION_MAX) {
			const size = Number((bytes / DESCRIPTION_MAX).toFixed(2));
			errors['description'] = [`is too long (${size} MiB). The maximum size is 1 MiB.`];
		}
	}

	/** The parse-level checks both create and update share (Grape's `{"error": ...}`); undefined when fine. */
	private parseProblem(params: Params): Answer | undefined {
		const type = params['issue_type'];
		// LIVE-VERIFIED (step "create with a null issue_type"): null is the same as no type.
		if (type !== undefined && type !== null && !UPDATE_ISSUE_TYPES.includes(String(type)))
			return failError(400, 'issue_type does not have a valid value');
		if (params['confidential'] !== undefined && parseBool(params['confidential']) === undefined)
			return failError(400, 'confidential is invalid');
		return undefined;
	}

	/** The 501 for a create / update asking for something the mock does not model (a parameter, a quick action). */
	private unmodelledWrite(params: Params): Answer | undefined {
		const param = UNMODELLED_PARAMS.find(name => params[name] !== undefined);
		if (param !== undefined) return notModelled(`the parameter ${param}`);
		const description = params['description'];
		const command = typeof description === 'string' ? unmodelledCommand(description) : undefined;
		return command === undefined ? undefined : notModelled(command);
	}

	private createIssueRoute(params: Params): Answer {
		// LIVE-VERIFIED (steps "create without title", "create with an empty title", "create with a title of 256 characters").
		if (params['title'] === undefined || params['title'] === null) return failError(400, 'title is missing');
		const unmodelled = this.unmodelledWrite(params);
		if (unmodelled !== undefined) return unmodelled;
		const parseProblem = this.parseProblem(params);
		if (parseProblem !== undefined) return parseProblem;
		const errors: Record<string, string[]> = {};
		const title = String(params['title']).trim();
		this.titleProblems(title, errors);
		const description =
			params['description'] === undefined || params['description'] === null
				? null
				: cleanText(String(params['description']));
		this.descriptionProblems(description, errors);
		if (Object.keys(errors).length > 0) return fail(400, errors);
		const labels = labelList(params['labels']);
		if (new Set(labels).size > LABELS_PER_ISSUE)
			return fail(400, 'Cannot add more than 100 labels to a work item.');
		// LIVE-VERIFIED: `test_case` silently becomes `issue`; `state` and `state_event` are ignored.
		const requested =
			params['issue_type'] === undefined || params['issue_type'] === null
				? 'issue'
				: String(params['issue_type']);
		const issueType: FakeIssueType = requested === 'test_case' ? 'issue' : (requested as FakeIssueType);
		const issue = this.createIssue({
			title,
			description,
			labels,
			issueType,
			author: this.user,
			confidential: parseBool(params['confidential']) ?? false,
			// LIVE-VERIFIED (step "create with a bad due_date"): a date that is not a date is ignored (201, no due date).
			dueDate: realDate(params['due_date']),
		});
		return ok(this.issueJson(issue), undefined, 201);
	}

	private updateIssue(issue: FakeIssue, params: Params): Answer {
		// LIVE-VERIFIED (steps "PUT no parameter", "PUT an unknown parameter", "PUT a state (not a parameter)").
		// LIVE-VERIFIED (step "PUT updated_at in the future on U1"): updated_at is not a parameter, it is the same 400.
		if (!UPDATE_PARAMS.some(key => params[key] !== undefined)) {
			return failError(400, `${UPDATE_PARAMS.join(', ')} are missing, at least one parameter must be provided`);
		}
		const unmodelled = this.unmodelledWrite(params);
		if (unmodelled !== undefined) return unmodelled;
		const event = params['state_event'];
		if (event !== undefined && event !== 'close' && event !== 'reopen')
			return failError(400, 'state_event does not have a valid value');
		const parseProblem = this.parseProblem(params);
		if (parseProblem !== undefined) return parseProblem;
		// LIVE-VERIFIED: an epic does not exist on Free, whatever the id.
		if (params['epic_id'] !== undefined) return notFound();
		if (params['epic_iid'] !== undefined) return notFound('404 Epic Not Found');
		const errors: Record<string, string[]> = {};
		const title = params['title'] === undefined ? undefined : String(params['title'] ?? '').trim();
		if (title !== undefined) this.titleProblems(title, errors);
		const description =
			params['description'] === undefined
				? undefined
				: params['description'] === null
					? null
					: cleanText(String(params['description']));
		if (description !== undefined) this.descriptionProblems(description, errors);
		const requestedType = params['issue_type'] === undefined ? undefined : String(params['issue_type']);
		// LIVE-VERIFIED: `task` is refused, `test_case` silently ignored.
		if (requestedType === 'task' && issue.issueType !== 'task')
			errors['work_item_type_id'] = ['can not be changed to Task'];
		if (Object.keys(errors).length > 0) return fail(400, errors);
		// LIVE-VERIFIED order: labels (replace), add_labels, remove_labels.
		let labels = issue.labels;
		if ('labels' in params) labels = labelList(params['labels']);
		if (params['add_labels'] !== undefined) labels = [...labels, ...labelList(params['add_labels'])];
		if (params['remove_labels'] !== undefined) {
			const gone = labelList(params['remove_labels']);
			labels = labels.filter(name => !gone.includes(name));
		}
		if (new Set(labels).size > LABELS_PER_ISSUE)
			return fail(400, 'Cannot add more than 100 labels to a work item.');

		const at = this.stamp();
		// LIVE-VERIFIED (steps "updated order after ...", "updated order after the same title on a fresh issue"): updated_at moves with a
		// new title, a description, the type, the due date, the lock, confidentiality and a real change of state; NOT with labels, a repeated
		// close, the same title or the same description. EXCEPT the first PUT after the creation, which moves it even with nothing changed.
		let changed = !issue.edited;
		issue.edited = true;
		if (title !== undefined && title !== issue.title) {
			this.systemNote(issue, titleChangeHtml(issue.title, title));
			issue.title = title;
			changed = true;
		}
		if (description !== undefined && description !== issue.description) {
			issue.description = description;
			this.systemNote(issue, 'changed the description');
			changed = true;
			if (description !== null) issue.description = this.runQuickActions(issue, description).text;
		}
		if (requestedType !== undefined && requestedType !== 'test_case' && requestedType !== issue.issueType) {
			this.setType(issue, requestedType as FakeIssueType);
			changed = true;
		}
		if (params['due_date'] !== undefined) {
			// LIVE-VERIFIED (steps "notes of DD after the due date changes", "PUT due_date with an invalid date"): a date that is not a date
			// removes the due date like null or ""; the removal says which date went.
			const due = realDate(params['due_date']);
			if (due !== issue.dueDate) {
				this.systemNote(
					issue,
					due === null
						? `removed due date ${longDate(issue.dueDate!)}`
						: `changed due date to ${longDate(due)}`
				);
				issue.dueDate = due;
				changed = true;
			}
		}
		const locked = parseBool(params['discussion_locked']);
		if (locked !== undefined && locked !== issue.discussionLocked) {
			// LIVE-VERIFIED (step "notes of DD after the lock"): locking and unlocking write a system note.
			if (locked || issue.discussionLocked === true)
				this.systemNote(
					issue,
					locked ? 'locked the discussion in this issue' : 'unlocked the discussion in this issue'
				);
			issue.discussionLocked = locked;
			changed = true;
		}
		const confidential = parseBool(params['confidential']);
		if (confidential !== undefined && confidential !== issue.confidential) {
			this.systemNote(issue, confidential ? 'made the item confidential' : 'made the item visible to everyone');
			issue.confidential = confidential;
			changed = true;
		}
		this.setLabels(issue, labels, at);
		// LIVE-VERIFIED: the state event of a PUT is about 0.5 s EARLIER than its label events.
		const stateAt = FakeGitLab.before(at, 500);
		if (event === 'close' && this.setState(issue, 'closed', stateAt)) changed = true;
		if (event === 'reopen' && this.setState(issue, 'opened', stateAt)) changed = true;
		if (changed) issue.updatedAt = at;
		return ok(this.issueJson(issue));
	}

	private setType(issue: FakeIssue, type: FakeIssueType): void {
		issue.issueType = type;
		const name = type === 'incident' ? 'Incident' : type === 'task' ? 'Task' : 'Issue';
		this.systemNote(issue, `changed type to **${name}**`);
	}

	private noteBodyProblem(params: Params): Answer | undefined {
		if (params['body'] === undefined || params['body'] === null) return failError(400, 'body is missing');
		if (String(params['body']).trim() === '')
			return fail(400, '400 Bad request - Note {:note=>["can\'t be blank"]}');
		return undefined;
	}

	private notesRoute(
		method: string,
		issue: FakeIssue,
		rest: string[],
		url: URL,
		params: Params,
		issueLink: string,
		idParam: [string, string]
	): Answer {
		if (rest.length === 0) {
			if (method === 'GET') {
				const filter = String(params['activity_filter'] ?? 'all_notes');
				if (!['all_notes', 'only_comments', 'only_activity'].includes(filter))
					return failError(400, 'activity_filter does not have a valid value');
				const orderBy = String(params['order_by'] ?? 'created_at');
				const sort = String(params['sort'] ?? 'desc');
				if (!['created_at', 'updated_at'].includes(orderBy))
					return failError(400, 'order_by does not have a valid value');
				if (!['asc', 'desc'].includes(sort)) return failError(400, 'sort does not have a valid value');
				const notes = issue.notes.filter(note =>
					filter === 'only_comments' ? !note.system : filter === 'only_activity' ? note.system : true
				);
				const key = orderBy === 'updated_at' ? 'updatedAt' : 'createdAt';
				const direction = sort === 'asc' ? 1 : -1;
				const sorted = [...notes].sort(
					(a, b) => direction * (Date.parse(a[key]) - Date.parse(b[key]) || a.id - b.id)
				);
				// LIVE-VERIFIED: the pages are cut and counted first, then the notes of a deleted issue are left out of the page.
				const hidden = new Set(sorted.filter(note => note.gone === true).map(note => note.id));
				return this.paginate(
					sorted.map(note => this.noteJson(issue, note)),
					url,
					`${issueLink}/notes`,
					[
						['activity_filter', filter],
						idParam,
						['noteable_id', String(issue.iid)],
						['order_by', orderBy],
						['sort', sort],
					],
					item => hidden.has((item as { id: number }).id)
				);
			}
			if (method === 'POST') {
				// LIVE-VERIFIED (steps "note without body", "note with an empty body").
				const problem = this.noteBodyProblem(params);
				if (problem !== undefined) return problem;
				const command = unmodelledCommand(String(params['body']));
				if (command !== undefined) return notModelled(command);
				const { text, ran, changes, summary, failed } = this.runQuickActions(
					issue,
					cleanText(String(params['body']))
				);
				if (failed !== undefined) return failed;
				// LIVE-VERIFIED: a note holding only quick actions creates no note and answers 202.
				if (ran > 0 && text === '') return ok({ commands_changes: changes, summary }, undefined, 202);
				const note = this.addNote(issue, text, this.user, false);
				// LIVE-VERIFIED (step "note with text and two quick actions"): the note carries what its commands changed.
				return ok(this.noteJson(issue, note, changes), undefined, 201);
			}
			return routeNotFound();
		}
		const note = issue.notes.find(candidate => String(candidate.id) === rest[0]);
		if (note === undefined) return notFound();
		// A sub-resource of a note (reactions, ...): not modelled.
		if (rest.length > 1) return notModelled(`the ${rest[1]} of a note`);
		if (method === 'PUT') {
			// LIVE-VERIFIED: a system note cannot be edited.
			if (note.system) return forbidden();
			// LIVE-VERIFIED: a PUT with no body is a 200 that changes nothing, an empty body is 400 {"error":"body is empty"}.
			if (params['body'] === undefined || params['body'] === null) return ok(this.noteJson(issue, note));
			if (String(params['body']).trim() === '') return failError(400, 'body is empty');
			const command = unmodelledCommand(String(params['body']));
			if (command !== undefined) return notModelled(command);
			// LIVE-VERIFIED (steps "edit a note into a quick action", "Q2 after the note edit"): the commands of an edited note run, and a
			// note left with nothing but commands is removed and answered like a new one (202).
			const edited = this.runQuickActions(issue, cleanText(String(params['body'])));
			if (edited.failed !== undefined) return edited.failed;
			if (edited.ran > 0 && edited.text === '') {
				issue.notes = issue.notes.filter(candidate => candidate !== note);
				return ok({ commands_changes: edited.changes, summary: edited.summary }, undefined, 202);
			}
			note.body = edited.text;
			note.updatedAt = this.stamp();
			return ok(this.noteJson(issue, note, edited.changes));
		}
		if (method === 'DELETE') {
			if (note.system) return forbidden();
			issue.notes = issue.notes.filter(candidate => candidate !== note);
			return { status: 204 };
		}
		return method === 'GET' ? ok(this.noteJson(issue, note)) : routeNotFound();
	}

	private missingParams(params: Params, names: string[]): Answer | undefined {
		const missing = names.filter(name => params[name] === undefined || params[name] === null);
		if (missing.length === 0) return undefined;
		return failError(400, `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing`);
	}

	private linksRoute(method: string, issue: FakeIssue, rest: string[], params: Params): Answer {
		if (rest.length === 0) {
			if (method === 'GET') {
				const mine = this.linkRows.filter(link => link.source === issue.iid || link.target === issue.iid);
				// LIVE-VERIFIED: the list has no pagination headers.
				return ok(mine.map(link => this.linkIssueJson(link, issue.iid)));
			}
			if (method !== 'POST') return routeNotFound();
			const missing = this.missingParams(params, ['target_project_id', 'target_issue_iid']);
			if (missing !== undefined) return missing;
			const type = String(params['link_type'] ?? 'relates_to');
			if (!['relates_to', 'blocks', 'is_blocked_by'].includes(type))
				return failError(400, 'link_type does not have a valid value');
			// LIVE-VERIFIED: a numeric id or the path as written (an URL-encoded path is a 404).
			const targetProject = String(params['target_project_id']);
			if (targetProject !== String(this.projectId) && targetProject.toLowerCase() !== this.project.toLowerCase())
				return notFound('404 Project Not Found');
			// LIVE-VERIFIED: the blocking link types answer a 403 on Free.
			if (type !== 'relates_to') return fail(403, 'Blocked issues not available for current license');
			const targetIid = Number(params['target_issue_iid']);
			const target = this.issues.get(targetIid);
			if (target === undefined) return notFound();
			if (target === issue) return fail(422, `#${issue.iid} cannot be added: cannot be related to itself`);
			if (this.linked(issue.iid, targetIid)) return fail(409, 'Issue(s) already assigned');
			const link = this.relate(issue, target, type as FakeLinkType);
			return ok(
				{
					id: link.id,
					source_issue: this.issueJson(issue, 'link'),
					target_issue: this.issueJson(target, 'link'),
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
			this.systemNote(issue, `removed the relation with #${other.iid}`, other.iid);
			this.systemNote(other, `removed the relation with #${issue.iid}`, issue.iid);
			// LIVE-VERIFIED (step "delete the link from the other end"): source and target are the link's own, whichever end deletes it.
			return ok({
				id: link.id,
				source_issue: this.issueJson(this.require(link.source), 'link'),
				target_issue: this.issueJson(this.require(link.target), 'link'),
				link_type: this.typeSeenFrom(link, issue.iid),
			});
		}
		return routeNotFound();
	}

	private labelsRoute(
		method: string,
		rest: string[],
		url: URL,
		params: Params,
		linkRoot: string,
		idParam: [string, string]
	): Answer {
		if (rest.length === 0) {
			if (method === 'GET') {
				const search = params['search'] === undefined ? undefined : String(params['search']);
				const counts = parseBool(params['with_counts']) === true;
				// LIVE-VERIFIED: project and group labels together, sorted by name.
				const found = this.labels
					.filter(label => search === undefined || label.name.toLowerCase().includes(search.toLowerCase()))
					.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
				const declared: Array<[string, string]> = [
					idParam,
					['include_ancestor_groups', String(params['include_ancestor_groups'] ?? 'true')],
					['with_counts', String(counts)],
				];
				if (search !== undefined) declared.push(['search', search]);
				return this.paginate(
					found.map(label => this.labelJson(label, counts)),
					url,
					`${linkRoot}/labels`,
					declared
				);
			}
			if (method !== 'POST') return routeNotFound();
			const missing = this.missingParams(params, ['name', 'color']);
			if (missing !== undefined) return missing;
			if (params['priority'] !== undefined) return notModelled('label priority');
			const name = String(params['name']).trim();
			const errors: Record<string, string[]> = {};
			if (name === '') errors['title'] = ["can't be blank", 'is invalid'];
			else if (name.includes(',')) errors['title'] = ['is invalid'];
			else if (name.length > TITLE_MAX) errors['title'] = [`is too long (maximum is ${TITLE_MAX} characters)`];
			const color = this.normalColor(String(params['color']));
			if (color === undefined) errors['color'] = ['must be a valid color code'];
			if (Object.keys(errors).length > 0) return fail(400, errors);
			if (this.findLabel(name) !== undefined) return fail(409, 'Label already exists');
			const label: FakeProjectLabel = {
				id: this.nextId++,
				name,
				color: color!,
				description:
					params['description'] === undefined || params['description'] === null
						? null
						: String(params['description']),
				priority: null,
			};
			this.labels.push(label);
			return ok(this.labelJson(label, false), undefined, 201);
		}
		const wanted = rest[0]!;
		const label =
			this.labels.find(candidate => String(candidate.id) === wanted) ??
			this.labels.find(candidate => candidate.name === wanted);
		if (label === undefined) return notFound('404 Label Not Found');
		if (method === 'GET') return ok(this.labelJson(label, false));
		if (method === 'PUT') {
			if (!['new_name', 'color', 'description', 'priority', 'archived'].some(key => params[key] !== undefined)) {
				return failError(
					400,
					'new_name, color, description, priority, archived are missing, at least one parameter must be provided'
				);
			}
			// A group label: changing it through the project route would be a change of group data, which the fixture cannot probe.
			if (label.group === true) return notModelled('changing a group label through the project route');
			if (params['priority'] !== undefined) return notModelled('label priority');
			if (params['archived'] !== undefined) return notModelled('archiving a label');
			const errors: Record<string, string[]> = {};
			const color = params['color'] === undefined ? undefined : this.normalColor(String(params['color']));
			if (params['color'] !== undefined && color === undefined) errors['color'] = ['must be a valid color code'];
			const newName = typeof params['new_name'] === 'string' ? params['new_name'].trim() : undefined;
			if (newName !== undefined) {
				if (newName === '') errors['title'] = ["can't be blank", 'is invalid'];
				else if (newName.includes(',')) errors['title'] = ['is invalid'];
				else if (newName.length > TITLE_MAX)
					errors['title'] = [`is too long (maximum is ${TITLE_MAX} characters)`];
				else if (newName !== label.name && this.findLabel(newName) !== undefined)
					errors['title'] = ['has already been taken'];
			}
			if (Object.keys(errors).length > 0) return fail(400, errors);
			if (newName !== undefined && newName !== label.name) {
				const from = label.name;
				label.name = newName;
				for (const issue of this.issues.values())
					issue.labels = sortedNames(issue.labels.map(name => (name === from ? newName : name)));
			}
			if (color !== undefined) label.color = color;
			if (params['description'] !== undefined)
				label.description = params['description'] === null ? null : String(params['description']);
			return ok(this.labelJson(label, false));
		}
		if (method === 'DELETE') {
			if (label.group === true) return notModelled('deleting a group label through the project route');
			this.labels = this.labels.filter(candidate => candidate !== label);
			for (const issue of this.issues.values()) issue.labels = issue.labels.filter(name => name !== label.name);
			return { status: 204 };
		}
		return routeNotFound();
	}

	/** LIVE-VERIFIED: `#FF0000` and a CSS name (`red` -> `#FF0000`) are valid, `red!` is not. */
	private normalColor(color: string): string | undefined {
		if (/^#[0-9a-fA-F]{6}$/.test(color) || /^#[0-9a-fA-F]{3}$/.test(color)) return color;
		return CSS_COLORS[color.toLowerCase()];
	}

	// ---------------------------------------------------------------- GraphQL

	private graphqlRoute(body: Params, anonymous = false): Answer {
		try {
			return { status: 200, body: executeGraphql(body, this.graphqlHost(anonymous)), graphql: true };
		} catch (error) {
			if (error instanceof GqlForbidden)
				return this.deniedAnswer({ kind: 'project', permission: `${error.resource}: ${error.action}` });
			if (error instanceof GqlNotModelled) return notModelled(error.message);
			throw error;
		}
	}

	private workItemView(issue: FakeIssue): GqlWorkItem {
		return {
			id: issue.id,
			iid: issue.iid,
			title: issue.title,
			description: issue.description,
			state: issue.state,
			typeName: issue.issueType === 'incident' ? 'Incident' : issue.issueType === 'task' ? 'Task' : 'Issue',
			confidential: issue.confidential,
			webUrl: this.webUrl(issue),
			createdAt: issue.createdAt,
			updatedAt: issue.updatedAt,
			closedAt: issue.closedAt,
		};
	}

	/** `anonymous`: no token, so nothing private is visible (LIVE-VERIFIED: an anonymous `{ __typename }` is answered). */
	private graphqlHost(anonymous = false): GqlHost {
		const byGid = (gid: string): FakeIssue | undefined => {
			const match = /^gid:\/\/gitlab\/WorkItem\/(\d+)$/.exec(gid);
			if (match === null) throw new GqlFieldError(`"${gid}" is not a valid Global ID`);
			return [...this.issues.values()].find(issue => issue.id === Number(match[1]));
		};
		const wrap = (issue: FakeIssue | undefined): GqlWorkItem | undefined =>
			issue === undefined ? undefined : this.workItemView(issue);
		const issueOf = (view: GqlWorkItem): FakeIssue =>
			[...this.issues.values()].find(issue => issue.id === view.id)!;
		return {
			workItem: gid => (anonymous ? undefined : wrap(byGid(gid))),
			parentOf: view => {
				const parent = issueOf(view).parentIid;
				return parent === null ? undefined : wrap(this.issues.get(parent));
			},
			childrenOf: view =>
				[...this.issues.values()]
					.filter(issue => issue.parentIid === view.iid)
					.map(issue => this.workItemView(issue)),
			setParent: (child, parent) =>
				this.atOneInstant(() => this.setParentLink(issueOf(child), parent === null ? null : issueOf(parent))),
			convert: (view, typeGid) => this.atOneInstant(() => this.convertType(issueOf(view), typeGid)),
			project: fullPath =>
				this.holds({ kind: 'project', permission: 'Project: Read' }) &&
				fullPath.toLowerCase() === this.project.toLowerCase()
					? { id: this.projectId, fullPath: this.project, name: this.project.split('/').at(-1)! }
					: undefined,
			namespace: fullPath =>
				this.holds({ kind: 'group', permission: 'Namespace: Read' }) &&
				fullPath.toLowerCase() === this.namespacePath().toLowerCase()
					? { id: this.namespaceId, fullPath: this.namespacePath(), name: this.namespacePath() }
					: undefined,
			can: action =>
				this.holds({
					kind: 'project',
					permission: action === 'read' ? 'Work Item: Read' : 'Work Item: Update',
				}),
		};
	}

	/** LIVE-VERIFIED rules (steps "task C under ...", "notes of HJ after the removal", "notes of HI after the replace"). */
	private setParentLink(child: FakeIssue, parent: FakeIssue | null): string[] {
		if (parent === null) {
			const previous = child.parentIid === null ? undefined : this.issues.get(child.parentIid);
			child.parentIid = null;
			if (previous !== undefined) {
				this.systemNote(child, `removed parent item #${previous.iid}`, previous.iid);
				this.systemNote(previous, `removed child item #${child.iid}`, child.iid);
			}
			return [];
		}
		const reasons: string[] = [];
		if (!(child.issueType === 'task' && (parent.issueType === 'issue' || parent.issueType === 'incident')))
			reasons.push("it's not allowed to add this type of parent item");
		if (child === parent) reasons.push('is not allowed to point to itself');
		if (reasons.length > 0) return [`#${child.iid} cannot be added: ${reasons.join(' and ')}`];
		if (child.parentIid === parent.iid) return [];
		const previous = child.parentIid === null ? undefined : this.issues.get(child.parentIid);
		if (previous !== undefined) {
			// LIVE-VERIFIED (step "notes of HI after the replace"): the old parent says where the child went.
			this.systemNote(previous, `moved child task #${child.iid} to #${parent.iid}`, child.iid);
		}
		child.parentIid = parent.iid;
		this.systemNote(parent, `added #${child.iid} as child item`, child.iid);
		this.systemNote(child, `added #${parent.iid} as parent item`, parent.iid);
		return [];
	}

	private convertType(issue: FakeIssue, typeGid: string): string[] {
		// LIVE-VERIFIED (steps "convert ... to the work item type N"): the types GitLab has and Free cannot use are field errors naming
		// them; an id that is no type at all is "was not found".
		const refused = REFUSED_WORK_ITEM_TYPES[typeGid];
		if (refused !== undefined)
			throw new GqlFieldError(`You are not allowed to change the Work Item type to ${refused}.`);
		const name = WORK_ITEM_TYPE_IDS[typeGid];
		if (name === undefined) throw new GqlFieldError(`Work Item type ${typeGid} was not found`);
		const type: FakeIssueType = name === 'Incident' ? 'incident' : name === 'Task' ? 'task' : 'issue';
		if (type === issue.issueType) return [];
		const hasChildren = [...this.issues.values()].some(other => other.parentIid === issue.iid);
		// LIVE-VERIFIED (steps "convert HI (with a child) to task", "convert HT (a child) to issue"): refused in the payload.
		if (type === 'task' && hasChildren)
			return ['Work item type cannot be changed to Task with these child item types.'];
		if (type !== 'task' && issue.parentIid !== null)
			return [`Work item type cannot be changed to ${type} when linked to a parent issue.`];
		this.setType(issue, type);
		issue.updatedAt = this.stamp();
		return [];
	}
}
