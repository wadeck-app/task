// The client side of the remote strategy: a TaskBackend whose every operation is one request of the protocol (task-core/remote) sent
// through a transport plugin. The server stores the tasks (the LOCAL backend behind `task serve`), so what a caller sees is what a local
// project gives: the typed errors come back as the same classes (wireErrors.decodeWireError), `revision` / `expectedRevision` travel as
// the record field and the If-Match header, and the queue events are raised by the server (capabilities.events: 'server').
// Nothing here parses a URL, opens a socket or reads a token: that is the transport's.
import {
	EVENTS_HEADER,
	EVENTS_SUPPRESS,
	PROTOCOL_MAX,
	PROTOCOL_MIN,
	PROTOCOL_VERSION,
	REMOTE_CAPABILITIES,
	RemoteIncompatibleError,
	RemoteProjectMismatchError,
	RemoteUnreachableError,
	TaskNotFoundError,
	buildRequest,
	decodeWireError,
	routeFor,
} from '@wadeck-app/task-core';
import type {
	BackendCapabilities,
	BackendCommentChange,
	BackendCommentEdit,
	CreateTaskInput,
	EventsOutcome,
	LabelCount,
	LinkType,
	ListQuery,
	Page,
	ProtocolOperation,
	ServerInfo,
	TaskBackend,
	TaskLink,
	TaskLinks,
	TaskStatus,
	TaskSummary,
	TaskTreeNode,
	VersionedRecord,
	WriteEnvelope,
	WriteOptions,
} from '@wadeck-app/task-core';

import type { ReadNotice, TransportInstance } from '../kinds.js';

export interface RemoteBackendOptions {
	transport: TransportInstance;
	/** The project the config expects the server to serve (id, unique id prefix of 4+ characters, or name). Checked at the first call. */
	expectedProject?: string;
	/** Ask the server not to raise the events of the writes (a migration). */
	suppressEvents?: boolean;
	/** Receives what the user should know without a failure (an event the server could not deliver). */
	notice?: (notice: ReadNotice) => void;
	/** Names the project in messages. */
	projectName?: string;
}

/** The project reference of the config against what the server answers: id, id prefix (4+ characters) or name, case-insensitive. */
export function serverServes(expected: string, served: { id?: string; name: string }): boolean {
	const wanted = expected.trim().toLowerCase();
	if (wanted === served.name.toLowerCase()) return true;
	const id = served.id?.toLowerCase();
	return id !== undefined && (wanted === id || (wanted.length >= 4 && id.startsWith(wanted)));
}

interface CallInput {
	params?: Record<string, string>;
	query?: Record<string, string | undefined>;
	body?: unknown;
	expectedRevision?: string;
}

function isInfo(value: unknown): value is ServerInfo {
	if (typeof value !== 'object' || value === null) return false;
	const { protocol, project, capabilities } = value as Partial<ServerInfo>;
	return (
		typeof protocol === 'object' &&
		protocol !== null &&
		typeof protocol.version === 'number' &&
		typeof project === 'object' &&
		project !== null &&
		typeof project.name === 'string' &&
		typeof capabilities === 'object' &&
		capabilities !== null
	);
}

export class RemoteBackend implements TaskBackend {
	readonly kind = 'remote' as const;
	readonly capabilities: BackendCapabilities = REMOTE_CAPABILITIES;
	private handshake: Promise<void> | undefined;

	constructor(private readonly options: RemoteBackendOptions) {}

	// ---- the one request path ----

	/** One exchange: build, send, check the answer is a task server's, decode a failure into its class, unwrap a write. */
	private async call<T>(op: ProtocolOperation, input: CallInput = {}): Promise<T> {
		if (op !== 'info') await this.checkProject();
		return this.exchange<T>(op, input);
	}

	private async exchange<T>(op: ProtocolOperation, input: CallInput): Promise<T> {
		const { transport } = this.options;
		const route = routeFor(op);
		const { method, path } = buildRequest(op, input.params, input.query);
		const headers: Record<string, string> = {};
		if (input.body !== undefined) headers['Content-Type'] = 'application/json';
		if (route.write && input.expectedRevision !== undefined) headers['If-Match'] = `"${input.expectedRevision}"`;
		if (route.write && this.options.suppressEvents === true) headers[EVENTS_HEADER] = EVENTS_SUPPRESS;

		const response = await transport.fetch(path, {
			method,
			headers,
			...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
		});
		const text = await response.text();
		let parsed: unknown;
		try {
			parsed = text === '' ? undefined : (JSON.parse(text) as unknown);
		} catch {
			parsed = undefined;
		}
		if (!response.ok) {
			throw decodeWireError(response.status, parsed, { url: transport.baseUrl, operation: op });
		}
		const version = Number(response.headers.get('x-task-protocol'));
		if (!Number.isInteger(version) || version < PROTOCOL_MIN || version > PROTOCOL_MAX) {
			throw response.headers.get('x-task-protocol') === null
				? new RemoteUnreachableError(
						transport.baseUrl,
						'the answer carries no X-Task-Protocol header: this is not a task server (another service answers at this address?)'
					)
				: new RemoteIncompatibleError(transport.baseUrl, PROTOCOL_VERSION, undefined);
		}
		if (!route.write) return parsed as T;
		const envelope = parsed as WriteEnvelope<T> | undefined;
		if (envelope === undefined || typeof envelope !== 'object' || !('result' in envelope)) {
			throw new RemoteIncompatibleError(transport.baseUrl, PROTOCOL_VERSION, undefined);
		}
		this.relayEvents(envelope.events, op);
		return envelope.result;
	}

	/** The server saved the change; an event it could not hand to its queue is the user's to know (and to replay on the server). */
	private relayEvents(events: EventsOutcome | undefined, op: ProtocolOperation): void {
		if (events === undefined || this.options.notice === undefined) return;
		for (const item of events.undelivered) {
			const where = RemoteUnreachableError.hostOf(this.options.transport.baseUrl);
			this.options.notice({
				kind: 'events',
				text: `the change is saved on ${where}, but the server could not deliver the event ${item.event} to its queue (${item.reason})${
					item.status === 'unknown'
						? '; it MAY have been recorded: check queue history on that machine before replaying it'
						: '; the event was not recorded: replay it on that machine (see its task log)'
				} [${op}]`,
			});
		}
	}

	/** With `expectedProject`, the first call asks the server which project it serves and refuses a different one. */
	private checkProject(): Promise<void> {
		const expected = this.options.expectedProject;
		if (expected === undefined) return Promise.resolve();
		this.handshake ??= this.exchange<ServerInfo>('info', {}).then(info => {
			if (!isInfo(info))
				throw new RemoteIncompatibleError(this.options.transport.baseUrl, PROTOCOL_VERSION, undefined);
			if (!serverServes(expected, info.project)) {
				throw new RemoteProjectMismatchError(this.options.transport.baseUrl, expected, info.project);
			}
		});
		// A failed handshake is not remembered: the next call asks again (the server may have been started meanwhile).
		this.handshake.catch(() => {
			this.handshake = undefined;
		});
		return this.handshake;
	}

	/** `GET /v1/info`, validated: who the server is, what it serves. Used by `strategy check`. */
	async info(): Promise<ServerInfo> {
		const info = await this.exchange<unknown>('info', {});
		if (!isInfo(info)) {
			throw new RemoteIncompatibleError(this.options.transport.baseUrl, PROTOCOL_VERSION, undefined);
		}
		return info;
	}

	// ---- reads: records ----
	async list(): Promise<TaskSummary[]> {
		return (await this.call<{ items: TaskSummary[] }>('list')).items;
	}

	listPage(query: ListQuery = {}): Promise<Page<TaskSummary>> {
		return this.call('listPage', { body: query });
	}

	get(id: string): Promise<VersionedRecord> {
		return this.call('get', { params: { id } });
	}

	async getMany(ids: readonly string[]): Promise<VersionedRecord[]> {
		if (ids.length === 0) return [];
		return (await this.call<{ items: VersionedRecord[] }>('getMany', { body: { ids } })).items;
	}

	findByPrefix(prefix: string): Promise<VersionedRecord> {
		return this.call('findByPrefix', { params: { prefix } });
	}

	resolve(prefix: string): Promise<VersionedRecord> {
		// One request either way (the server answers the whole record of its own backend): no route of its own in protocol v1.
		return this.findByPrefix(prefix);
	}

	async listLabels(): Promise<LabelCount[]> {
		return (await this.call<{ items: LabelCount[] }>('listLabels')).items;
	}

	// ---- reads: graph ----
	getLinks(id: string): Promise<TaskLinks> {
		return this.call('getLinks', { params: { id } });
	}

	getLinksLenient(id: string): Promise<{ links: TaskLinks; dangling: TaskLink[] }> {
		return this.call('getLinksLenient', { params: { id } });
	}

	/** Computed here from the links: a predicate cannot travel, and the answer is the same as the store's. */
	async getOpenBlockers(id: string, isTerminal: (status: TaskStatus) => boolean): Promise<TaskSummary[]> {
		// A dangling blockedBy link blocks nothing: the lenient read skips it.
		return (await this.getLinksLenient(id)).links.blockedBy.filter(task => !isTerminal(task.status));
	}

	/** Computed here from the index (a predicate cannot travel), by the store's own rule. */
	async getUnblockedBy(blockerId: string, isTerminal: (status: TaskStatus) => boolean): Promise<TaskSummary[]> {
		const tasks = await this.list();
		const byId = new Map(tasks.map(task => [task.id, task]));
		const blocker = byId.get(blockerId);
		if (blocker === undefined) throw new TaskNotFoundError(blockerId);
		if (!isTerminal(blocker.status)) return [];
		return tasks.filter(task => {
			const blockerIds = (task.links ?? [])
				.filter(link => link.type === ('blockedBy' as LinkType))
				.map(link => link.target);
			return (
				blockerIds.includes(blockerId) &&
				!isTerminal(task.status) &&
				blockerIds.every(other => {
					const found = byId.get(other);
					return found !== undefined && isTerminal(found.status);
				})
			);
		});
	}

	async getChildren(id: string): Promise<TaskSummary[]> {
		return (await this.call<{ items: TaskSummary[] }>('getChildren', { params: { id } })).items;
	}

	getTree(id: string): Promise<TaskTreeNode> {
		return this.call('getTree', { params: { id } });
	}

	/** With a predicate the forest is read whole and pruned here, by the store's rule: a node stays if it matches or one of its descendants does. */
	async getForest(
		options: { parentId?: string; predicate?: (task: TaskSummary) => boolean } = {}
	): Promise<TaskTreeNode[]> {
		const { parentId, predicate } = options;
		const roots = (
			await this.call<{ items: TaskTreeNode[] }>('getForest', {
				query: { parentId },
			})
		).items;
		if (predicate === undefined) return roots;
		const prune = (node: TaskTreeNode): TaskTreeNode | undefined => {
			const children = node.children.map(prune).filter((child): child is TaskTreeNode => child !== undefined);
			return children.length > 0 || predicate(node) ? { ...node, children } : undefined;
		};
		return roots.map(prune).filter((node): node is TaskTreeNode => node !== undefined);
	}

	async getDescendants(id: string): Promise<TaskSummary[]> {
		return (await this.call<{ items: TaskSummary[] }>('getDescendants', { params: { id } })).items;
	}

	getFullTree(id: string): Promise<TaskTreeNode> {
		return this.call('getFullTree', { params: { id } });
	}

	async getAncestors(id: string): Promise<TaskSummary[]> {
		return (await this.call<{ items: TaskSummary[] }>('getAncestors', { params: { id } })).items;
	}

	// ---- writes: fields ----
	create(input: CreateTaskInput): Promise<VersionedRecord> {
		return this.call('create', { body: input });
	}

	updateStatus(id: string, status: TaskStatus, options?: WriteOptions): Promise<VersionedRecord> {
		return this.call('updateStatus', { params: { id }, body: { status }, ...revision(options) });
	}

	setTitle(id: string, title: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.call('setTitle', { params: { id }, body: { title }, ...revision(options) });
	}

	setDescription(id: string, description: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.call('setDescription', { params: { id }, body: { description }, ...revision(options) });
	}

	setType(id: string, type: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.call('setType', { params: { id }, body: { type }, ...revision(options) });
	}

	clearType(id: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.call('clearType', { params: { id }, ...revision(options) });
	}

	addLabel(id: string, label: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.call('addLabel', { params: { id }, body: { label }, ...revision(options) });
	}

	removeLabel(id: string, label: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.call('removeLabel', { params: { id, label }, ...revision(options) });
	}

	setMeta(id: string, key: string, value: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.call('setMeta', { params: { id, key }, body: { value }, ...revision(options) });
	}

	removeMeta(id: string, key: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.call('removeMeta', { params: { id, key }, ...revision(options) });
	}

	// ---- writes: graph ----
	setParent(id: string, parentId: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.call('setParent', { params: { id }, body: { parentId }, ...revision(options) });
	}

	removeParent(id: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.call('removeParent', { params: { id }, ...revision(options) });
	}

	addLink(id: string, type: LinkType, targetId: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.call('addLink', { params: { id }, body: { type, targetId }, ...revision(options) });
	}

	removeLink(id: string, type: LinkType, targetId: string, options?: WriteOptions): Promise<VersionedRecord> {
		return this.call('removeLink', { params: { id, type, target: targetId }, ...revision(options) });
	}

	// ---- writes: comments ----
	addComment(id: string, text: string, options?: WriteOptions & { author?: string }): Promise<BackendCommentChange> {
		return this.call('addComment', {
			params: { id },
			body: { text, ...(options?.author === undefined ? {} : { author: options.author }) },
			...revision(options),
		});
	}

	editComment(id: string, commentId: string, text: string, options?: WriteOptions): Promise<BackendCommentEdit> {
		return this.call('editComment', { params: { id, commentId }, body: { text }, ...revision(options) });
	}

	removeComment(id: string, commentId: string, options?: WriteOptions): Promise<BackendCommentChange> {
		return this.call('removeComment', { params: { id, commentId }, ...revision(options) });
	}

	// ---- delete ----
	async deleteTask(id: string, options?: WriteOptions): Promise<boolean> {
		return (await this.call<{ deleted: boolean }>('deleteTask', { params: { id }, ...revision(options) })).deleted;
	}
}

function revision(options: WriteOptions | undefined): { expectedRevision?: string } {
	return options?.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision };
}
