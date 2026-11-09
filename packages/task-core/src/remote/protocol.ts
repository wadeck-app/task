// The wire protocol of `task serve` and the remote strategy (design 3, stage 4): version 1, HTTP + JSON, one route per operation of
// the TaskBackend port. This file is the single source of the route table: the server matches requests with it and the client builds
// them with it, so the two cannot drift. No Node module is imported (the port files must stay free of it; architecture.test.ts).
//
//   request headers   Authorization: Bearer <token>        always (401 otherwise)
//                     X-Task-Protocol: 1                    always (426 when the server does not speak it)
//                     If-Match: "<revision>"                a write that must not overwrite a newer task (412 = stale)
//                     X-Task-Events: suppress               a write whose events the CALLER does not want raised (a migration)
//                     Content-Type: application/json        when there is a body (JSON only)
//   response headers  X-Task-Protocol: 1                    on every answer, errors included
//   answers           200 (201 for create) with the JSON result; a WRITE answers { result, events } (see WriteEnvelope);
//                     an error answers { error: { type, message, hint?, ... } } (wireErrors.ts)
import type { BackendCapabilities } from '../backend/capabilities.js';
import type { TaskBackend } from '../backend/TaskBackend.js';

export const PROTOCOL_VERSION = 1;
/** The versions this build speaks, inclusive. The server answers 426 with this range for any other. */
export const PROTOCOL_MIN = 1;
export const PROTOCOL_MAX = 1;

export const PROTOCOL_HEADER = 'X-Task-Protocol';
export const EVENTS_HEADER = 'X-Task-Events';
/** The one value of {@link EVENTS_HEADER}: the writer asks the server not to raise the events of this write. */
export const EVENTS_SUPPRESS = 'suppress';
export const API_PREFIX = '/v1';

/** The operations of the port the protocol carries, by port method name. */
export const PORT_OPERATIONS = [
	'list',
	'listPage',
	'get',
	'getMany',
	'findByPrefix',
	'listLabels',
	'getLinks',
	'getLinksLenient',
	'getChildren',
	'getTree',
	'getForest',
	'getDescendants',
	'getFullTree',
	'getAncestors',
	'create',
	'updateStatus',
	'setTitle',
	'setDescription',
	'setType',
	'clearType',
	'addLabel',
	'removeLabel',
	'setMeta',
	'removeMeta',
	'setParent',
	'removeParent',
	'addLink',
	'removeLink',
	'addComment',
	'editComment',
	'removeComment',
	'deleteTask',
] as const satisfies readonly (keyof TaskBackend)[];

export type PortOperation = (typeof PORT_OPERATIONS)[number];
export type ProtocolOperation = PortOperation | 'info';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RouteSpec {
	op: ProtocolOperation;
	method: HttpMethod;
	/** `:name` segments are parameters, percent-encoded on the wire. */
	path: string;
	/** True for an operation that changes a task: the server runs it alone in the write queue and answers a WriteEnvelope. */
	write: boolean;
}

const read = (op: ProtocolOperation, method: HttpMethod, path: string): RouteSpec => ({
	op,
	method,
	path,
	write: false,
});
const write = (op: ProtocolOperation, method: HttpMethod, path: string): RouteSpec => ({
	op,
	method,
	path,
	write: true,
});

export const ROUTES: readonly RouteSpec[] = Object.freeze([
	read('info', 'GET', '/v1/info'),
	// ---- reads ----
	read('list', 'GET', '/v1/tasks'),
	read('listPage', 'POST', '/v1/query/page'),
	read('getMany', 'POST', '/v1/query/many'),
	read('findByPrefix', 'GET', '/v1/query/prefix/:prefix'),
	read('get', 'GET', '/v1/tasks/:id'),
	read('listLabels', 'GET', '/v1/labels'),
	read('getLinks', 'GET', '/v1/tasks/:id/links'),
	read('getLinksLenient', 'GET', '/v1/tasks/:id/links/lenient'),
	read('getChildren', 'GET', '/v1/tasks/:id/children'),
	read('getTree', 'GET', '/v1/tasks/:id/tree'),
	read('getForest', 'GET', '/v1/forest'),
	read('getDescendants', 'GET', '/v1/tasks/:id/descendants'),
	read('getFullTree', 'GET', '/v1/tasks/:id/full-tree'),
	read('getAncestors', 'GET', '/v1/tasks/:id/ancestors'),
	// ---- writes ----
	write('create', 'POST', '/v1/tasks'),
	write('updateStatus', 'PUT', '/v1/tasks/:id/status'),
	write('setTitle', 'PUT', '/v1/tasks/:id/title'),
	write('setDescription', 'PUT', '/v1/tasks/:id/description'),
	write('setType', 'PUT', '/v1/tasks/:id/type'),
	write('clearType', 'DELETE', '/v1/tasks/:id/type'),
	write('addLabel', 'POST', '/v1/tasks/:id/labels'),
	write('removeLabel', 'DELETE', '/v1/tasks/:id/labels/:label'),
	write('setMeta', 'PUT', '/v1/tasks/:id/meta/:key'),
	write('removeMeta', 'DELETE', '/v1/tasks/:id/meta/:key'),
	write('setParent', 'PUT', '/v1/tasks/:id/parent'),
	write('removeParent', 'DELETE', '/v1/tasks/:id/parent'),
	write('addLink', 'POST', '/v1/tasks/:id/links'),
	write('removeLink', 'DELETE', '/v1/tasks/:id/links/:type/:target'),
	write('addComment', 'POST', '/v1/tasks/:id/comments'),
	write('editComment', 'PUT', '/v1/tasks/:id/comments/:commentId'),
	write('removeComment', 'DELETE', '/v1/tasks/:id/comments/:commentId'),
	write('deleteTask', 'DELETE', '/v1/tasks/:id'),
]);

export function routeFor(op: ProtocolOperation): RouteSpec {
	const route = ROUTES.find(candidate => candidate.op === op);
	if (route === undefined) {
		throw new Error(`No route for operation "${String(op)}" (operations: ${ROUTES.map(r => r.op).join(', ')})`);
	}
	return route;
}

/** A path with a malformed percent sequence: a bad request, not a route that does not exist. */
export class ProtocolPathError extends Error {
	constructor(readonly path: string) {
		super(`The path "${path}" holds a malformed percent-encoding`);
		this.name = 'ProtocolPathError';
	}
}

/** The method and the target (path plus query) of the request for an operation. A missing path parameter is a bug of the caller. */
export function buildRequest(
	op: ProtocolOperation,
	params: Readonly<Record<string, string>> = {},
	query: Readonly<Record<string, string | undefined>> = {}
): { method: HttpMethod; path: string } {
	const route = routeFor(op);
	const path = route.path.replace(/:(\w+)/g, (_whole, name: string) => {
		const value = params[name];
		if (value === undefined || value === '') {
			throw new Error(`Operation ${op} needs the path parameter "${name}" (${route.method} ${route.path})`);
		}
		return encodeURIComponent(value);
	});
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined) search.set(key, value);
	}
	const text = search.toString();
	return { method: route.method, path: text === '' ? path : `${path}?${text}` };
}

export interface RouteMatch {
	op: ProtocolOperation;
	spec: RouteSpec;
	params: Record<string, string>;
	query: URLSearchParams;
}

interface Compiled {
	spec: RouteSpec;
	segments: string[];
}

const COMPILED: readonly Compiled[] = ROUTES.map(spec => ({ spec, segments: spec.path.split('/').slice(1) }));

/**
 * The route a request lands on. `undefined`: no such path. `{ methodNotAllowed }`: the path exists for other methods (sorted).
 * Throws ProtocolPathError for a malformed percent sequence in a segment of a path that has the right shape.
 */
export function matchRoute(method: string, target: string): RouteMatch | { methodNotAllowed: string[] } | undefined {
	const queryStart = target.indexOf('?');
	const rawPath = queryStart === -1 ? target : target.slice(0, queryStart);
	const query = new URLSearchParams(queryStart === -1 ? '' : target.slice(queryStart + 1));
	const rawSegments = rawPath.split('/').slice(1);
	const allowed = new Set<string>();
	let found: RouteMatch | undefined;
	for (const { spec, segments } of COMPILED) {
		if (segments.length !== rawSegments.length) continue;
		const params: Record<string, string> = {};
		let fits = true;
		for (let index = 0; index < segments.length; index++) {
			const wanted = segments[index]!;
			const actual = rawSegments[index]!;
			if (wanted.startsWith(':')) {
				if (actual === '') {
					fits = false;
					break;
				}
				params[wanted.slice(1)] = actual;
			} else if (wanted !== actual) {
				fits = false;
				break;
			}
		}
		if (!fits) continue;
		allowed.add(spec.method);
		if (spec.method === method && found === undefined) {
			found = { op: spec.op, spec, params, query };
		}
	}
	if (found === undefined) return allowed.size === 0 ? undefined : { methodNotAllowed: [...allowed].sort() };
	for (const [name, value] of Object.entries(found.params)) {
		try {
			found.params[name] = decodeURIComponent(value);
		} catch {
			throw new ProtocolPathError(rawPath);
		}
	}
	return found;
}

// ---- payloads ----

/** What the server answers to `GET /v1/info`: who it is, what it speaks, what it serves. */
export interface ServerInfo {
	protocol: { version: number; min: number; max: number };
	server: { name: 'task-serve'; version: string };
	/** The one project the server serves (its id in the registry of the SERVER machine, when registered there). */
	project: { id?: string; name: string };
	capabilities: BackendCapabilities;
	/** The server's own config, for `task strategy check` to compare with this machine's. */
	statuses: string[];
	terminalStatuses: string[];
	types: string[];
	/** Whether this server raises queue events (a sink is configured). */
	events: { enabled: boolean };
}

/** How the queue events of one write ended on the server: the writer relays what was not delivered as a warning. */
export interface EventsOutcome {
	enabled: boolean;
	delivered: number;
	undelivered: Array<{ event: string; reason: string; status: 'dropped' | 'unknown' }>;
}

/** The body of every write answer. */
export interface WriteEnvelope<T> {
	result: T;
	events: EventsOutcome;
}
