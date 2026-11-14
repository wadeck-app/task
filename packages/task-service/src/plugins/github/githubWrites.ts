// The write path of the github strategy (stage 2 of the storage design): every TaskBackend write as official REST / GraphQL calls.
//
// How a write goes (design 1.6, 2.2.1):
//  1. the issue is read again (a conditional GET: free when nothing changed), and compared with the caller's expectedRevision on the
//     parts the write changes (githubRevision.ts) -- GitHub has no conditional write, so a short race remains between that read and
//     the write, and it is said so in `task strategy check`;
//  2. the write is a list of steps (remove the old label, add the new one, close the issue...), sent one after the other and in an
//     order that never leaves two status labels on an issue; a failure after the first step is a PartialWriteError that says what is
//     on GitHub now and how to finish; a 5xx or a lost connection is never trusted either way: the issue is read again to see;
//  3. the record is read again and returned, so what the caller gets is what GitHub holds, not what was asked.
// Nothing here is silent: an operation GitHub cannot do is an UnsupportedByBackendError naming the fill that would emulate it.
import {
	BackendAuthError,
	BackendDataError,
	BackendLimitError,
	BackendRejectedError,
	BackendTimeoutError,
	BackendUnreachableError,
	CommentNotFoundError,
	LINK_TYPES,
	PartialWriteError,
	StaleRevisionError,
	TaskConflictError,
	TaskNotFoundError,
	UnsupportedByBackendError,
	normalizeCommentText,
} from '@wadeck-app/task-core';
import type {
	BackendCommentChange,
	BackendCommentEdit,
	CreateTaskInput,
	LabelSyncReport,
	LinkType,
	VersionedRecord,
	WriteOptions,
} from '@wadeck-app/task-core';

import type { DeclaredFills } from '../kinds.js';
import { wantedLabels } from './githubLabels.js';
import { GitHubHttpError } from './githubClient.js';
import type { ClientResponse, GitHubClient } from './githubClient.js';
import { GITHUB_LABEL_MAX, labelProblem } from './githubOptions.js';
import type { GitHubSettings } from './githubOptions.js';
import { checkRevision, revisionOf } from './githubRevision.js';
import type { FieldGroup } from './githubRevision.js';
import {
	TOMBSTONE_LABEL,
	commentsOf,
	composeBody,
	isTombstone,
	labelNames,
	metaOf,
	parentNumber,
	splitBody,
	statusOfIssue,
	typeOf,
	typeOfLabel,
} from './issueMapping.js';
import type { ApiComment, ApiIssue, MapContext } from './issueMapping.js';
import type { StatusRepresentation } from './statusMapping.js';

/** GitHub refuses a body over this many characters (measured). */
export const BODY_MAX = 65536;
/** Labels sent in one call: 10 new labels take about 3 s, 50 time out with the labels applied, 100 time out with none (measured). */
const LABEL_BATCH = 10;
/** GitHub allows this many labels on an issue (measured: the 101st is a 422). */
const LABELS_PER_ISSUE = 100;
const MAX_DEPTH = 8;
const MAX_CHILDREN = 100;

/** What the writer needs from the backend that owns it. */
export interface WriteHost {
	readonly settings: GitHubSettings;
	readonly client: GitHubClient;
	readonly map: MapContext;
	readonly fills: DeclaredFills;
	readonly repoPath: string;
	readonly issueUrl: (number: number) => string;
	/** The issue as GitHub holds it; TaskNotFoundError for a missing, deleted, hidden or pull-request number. `revalidate`: skip the TTL. */
	loadIssue(
		id: string,
		options: { revalidate: boolean }
	): Promise<{ issue: ApiIssue; response: ClientResponse<ApiIssue> }>;
	/** The whole record, read again. */
	readRecord(id: string): Promise<VersionedRecord>;
	/** The issues on the other end of a relation list of this repository. */
	related(path: string): Promise<ApiIssue[]>;
	/** Whether the sub-issue list of the issue is worth reading: its count is above 0, or task attached a sub-issue to it a moment ago (the count lags). */
	mayHaveChildren(issue: ApiIssue): boolean;
}

type LabelKind = 'status' | 'type' | 'meta' | 'user' | 'deleted';

const LABEL_STYLE: Record<LabelKind, { color: string; description?: string }> = {
	status: { color: '1d76db', description: 'Task status (set by the task tool)' },
	type: { color: 'a2eeef', description: 'Task type (set by the task tool)' },
	meta: { color: 'd4c5f9', description: 'Task metadata (set by the task tool)' },
	user: { color: 'ededed' },
	deleted: { color: 'b60205', description: 'Deleted task, hidden by the task tool' },
};

/** One call of a multi-call write. `description` is the past tense: it is shown as applied or as not applied. */
interface Step {
	description: string;
	run: () => Promise<unknown>;
	applied: (issue: ApiIssue) => boolean;
	/** The command that finishes the job when this step is not applied. */
	repair?: string;
}

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const has = (issue: ApiIssue, label: string): boolean => labelNames(issue).some(name => eq(name, label));
const enc = encodeURIComponent;
const isUnknownOutcome = (error: unknown): boolean =>
	error instanceof BackendUnreachableError || error instanceof BackendTimeoutError;

function matches(issue: Pick<ApiIssue, 'state' | 'state_reason'>, rep: StatusRepresentation): boolean {
	return issue.state === rep.state && (rep.state === 'open' || (issue.state_reason ?? 'completed') === rep.reason);
}

export class GitHubWriter {
	/** Labels known to exist in the repository (lower case) -- checked once per process. */
	private readonly knownLabels = new Set<string>();

	constructor(private readonly host: WriteHost) {}

	private get map(): MapContext {
		return this.host.map;
	}

	private path(number: number, tail = ''): string {
		return `${this.host.repoPath}/issues/${number}${tail}`;
	}

	private fill(key: string): string | undefined {
		return this.host.fills[key]?.use;
	}

	private emulated(text: string): void {
		this.map.notice({ kind: 'emulated', text });
	}

	// ---------------------------------------------------------------- sending, translating

	private translate(error: unknown, operation: string, subject: string): unknown {
		if (!(error instanceof GitHubHttpError)) return error;
		const texts = [error.detail, ...error.errors].filter(text => text !== '').join('; ');
		const lower = texts.toLowerCase();
		if (error.status === 404 || error.status === 410) return new TaskNotFoundError(subject);
		if (error.status === 422) {
			if (/layers of sub-issues/.test(lower)) {
				return new BackendLimitError(
					'github',
					'sub-issue depth',
					MAX_DEPTH,
					`GitHub allows ${MAX_DEPTH} levels of sub-issues; attach the task higher in the tree`
				);
			}
			if (/more than 100 labels/.test(lower)) {
				return new BackendLimitError(
					'github',
					'labels per issue',
					LABELS_PER_ISSUE,
					`An issue holds ${LABELS_PER_ISSUE} labels at most, statuses, types and metadata included; remove some with: task remove-label ${subject} <label>`
				);
			}
			if (/more than 100 sub-issues/.test(lower)) {
				return new BackendLimitError(
					'github',
					'sub-issues per parent',
					MAX_CHILDREN,
					`GitHub allows ${MAX_CHILDREN} sub-issues per parent; use another parent`
				);
			}
			if (/cycle|circular/.test(lower)) {
				return new TaskConflictError(`${operation} on "${subject}" would create a cycle (GitHub: ${texts})`);
			}
			if (/already been taken|duplicate sub-issues|only have one parent/.test(lower)) {
				return new TaskConflictError(`${operation} on "${subject}" is refused: ${texts}`);
			}
		}
		return new BackendRejectedError(
			'github',
			operation,
			`GitHub refused ${operation} on ${subject} (${error.status}${texts === '' ? '' : `: ${texts}`})`,
			'Nothing was changed by this call. Check the values against what GitHub accepts (names, lengths, permissions of the token).'
		);
	}

	private async send<T>(
		operation: string,
		subject: string,
		method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
		path: string,
		body?: unknown
	): Promise<ClientResponse<T>> {
		try {
			return await this.host.client.write<T>(method, path, body);
		} catch (error) {
			throw this.translate(error, operation, subject);
		}
	}

	/** A call whose "it is not there" answer is the wanted result (removing a label the issue no longer has). */
	private async sendTolerant(
		operation: string,
		subject: string,
		method: 'DELETE',
		path: string,
		body?: unknown
	): Promise<void> {
		try {
			await this.send(operation, subject, method, path, body);
		} catch (error) {
			if (!(error instanceof TaskNotFoundError)) throw error;
		}
	}

	// ---------------------------------------------------------------- reading before writing

	private async prepare(
		id: string,
		options: WriteOptions | undefined,
		groups: readonly FieldGroup[]
	): Promise<{ issue: ApiIssue; etag: string | undefined }> {
		const { issue, response } = await this.host.loadIssue(id, { revalidate: true });
		const expected = options?.expectedRevision;
		if (expected !== undefined) {
			const actual = revisionOf(issue, response.etag, this.map);
			if (checkRevision(expected, actual, groups).length > 0) {
				throw new StaleRevisionError(String(issue.number), expected, actual);
			}
		}
		return { issue, etag: response.etag };
	}

	private read(number: number): Promise<VersionedRecord> {
		return this.host.readRecord(String(number));
	}

	// ---------------------------------------------------------------- steps

	/**
	 * Sends the steps in order. A step refused for good, with nothing before it applied, is that error (nothing changed). Any other
	 * failure -- a refusal after a first step, or a call whose outcome is unknown (5xx, lost connection) -- is checked against a fresh
	 * read: a step that did apply counts, and a write that stopped halfway is a PartialWriteError with both lists.
	 */
	private async runSteps(
		operation: string,
		number: number,
		steps: readonly Step[],
		alreadyApplied: readonly string[] = []
	): Promise<void> {
		for (let index = 0; index < steps.length; index++) {
			const step = steps[index]!;
			try {
				await step.run();
				continue;
			} catch (error) {
				const unknown = isUnknownOutcome(error);
				if (!unknown && index === 0 && alreadyApplied.length === 0) throw error;
				let current: ApiIssue | undefined;
				try {
					current = (await this.host.loadIssue(String(number), { revalidate: true })).issue;
				} catch {
					current = undefined;
				}
				if (current !== undefined && unknown && step.applied(current)) continue;
				const applied = [...alreadyApplied, ...steps.slice(0, index).map(done => done.description)];
				if (applied.length === 0) throw error;
				const pending = steps.slice(index);
				const repairs = [
					...new Set(
						pending.map(todo => todo.repair).filter((repair): repair is string => repair !== undefined)
					),
				];
				throw new PartialWriteError({
					backendKind: 'github',
					operation,
					taskId: String(number),
					applied,
					notApplied: pending.map(todo => todo.description),
					hint:
						repairs.length > 0
							? `Finish it with: ${repairs.join(' ; ')} (what GitHub holds now: ${this.host.issueUrl(number)})`
							: `Check the issue on GitHub and redo what is missing: ${this.host.issueUrl(number)}`,
					cause: error,
				});
			}
		}
	}

	private removeLabelStep(number: number, operation: string, label: string): Step {
		return {
			description: `removed the label ${label}`,
			run: () =>
				this.sendTolerant(operation, String(number), 'DELETE', this.path(number, `/labels/${enc(label)}`)),
			applied: issue => !has(issue, label),
		};
	}

	private addLabelsStep(number: number, operation: string, labels: readonly string[], kind: LabelKind): Step {
		return {
			description: `added the label${labels.length === 1 ? '' : 's'} ${labels.join(', ')}`,
			run: async () => {
				for (const label of labels) await this.ensureLabel(label, kind);
				for (let from = 0; from < labels.length; from += LABEL_BATCH) {
					await this.send(operation, String(number), 'POST', this.path(number, '/labels'), {
						labels: labels.slice(from, from + LABEL_BATCH),
					});
				}
			},
			applied: issue => labels.every(label => has(issue, label)),
		};
	}

	/** The labels of the issue after removing and adding some (a label is never twice, whatever its case). */
	private finalLabels(issue: ApiIssue, remove: readonly string[], add: readonly string[]): string[] {
		const kept = labelNames(issue).filter(name => !remove.some(gone => eq(gone, name)));
		for (const name of add) if (!kept.some(held => eq(held, name))) kept.push(name);
		return kept;
	}

	private labelsDone(issue: ApiIssue, remove: readonly string[], add: readonly string[]): boolean {
		return add.every(label => has(issue, label)) && remove.every(label => !has(issue, label));
	}

	private labelWords(remove: readonly string[], add: readonly string[]): string[] {
		const words: string[] = [];
		if (remove.length > 0) words.push(`removed the label${remove.length === 1 ? '' : 's'} ${remove.join(', ')}`);
		if (add.length > 0) words.push(`added the label${add.length === 1 ? '' : 's'} ${add.join(', ')}`);
		return words;
	}

	private notApplied(operation: string, number: number, what: string, answer: ApiIssue): BackendDataError {
		return new BackendDataError(
			'github',
			`issue #${number}`,
			`GitHub did not apply ${what} on issue #${number} (it answered state ${answer.state}, reason ${answer.state_reason ?? 'none'}, labels ${labelNames(answer).join(', ') || 'none'}) during ${operation}`,
			`Look at ${this.host.issueUrl(number)}; the repository may restrict who can change issues`
		);
	}

	/**
	 * The steps that give the issue a status: ONE PATCH that carries the new state, its reason and the whole label set (so no reader ever
	 * sees two status labels, nor the status of a half-done change, and the history shows one change). Each answer is checked.
	 */
	private statusSteps(args: {
		operation: string;
		issue: ApiIssue;
		rep: StatusRepresentation;
		remove?: readonly string[];
		add?: readonly string[];
		/** Sent with the closing (`duplicate_issue_id`). */
		extraClose?: Record<string, unknown>;
		repair?: string;
	}): Step[] {
		const { operation, issue, rep, repair } = args;
		const remove = args.remove ?? [];
		const add = args.add ?? [];
		const number = issue.number;
		const labelsChange = remove.length + add.length > 0;
		const stateChange = issue.state !== rep.state;
		const reasonChange =
			issue.state === 'closed' && rep.state === 'closed' && (issue.state_reason ?? 'completed') !== rep.reason;
		const patch = async (
			body: Record<string, unknown>,
			check: (answer: ApiIssue) => boolean,
			what: string
		): Promise<void> => {
			for (const label of add) await this.ensureLabel(label, 'status');
			const answer = (await this.send<ApiIssue>(operation, String(number), 'PATCH', this.path(number), body))
				.body;
			if (!check(answer)) throw this.notApplied(operation, number, what, answer);
		};
		const labelBody = labelsChange ? { labels: this.finalLabels(issue, remove, add) } : {};
		const closing = { state: 'closed', state_reason: rep.reason, ...(args.extraClose ?? {}) };
		const reason = rep.reason ?? 'completed';
		// Measured on the real API: a close reason is applied when the body carries `state: closed` -- even on an issue that is already
		// closed -- and ignored when it travels alone. So a change of ending is the same one PATCH as any other change of status.
		const sendState = stateChange || reasonChange;
		if (!sendState && !labelsChange) return [];
		const words = [
			...this.labelWords(remove, add),
			...(sendState ? [rep.state === 'open' ? 'reopened the issue' : `closed the issue as ${reason}`] : []),
		];
		return [
			{
				description: words.join(' and '),
				run: () =>
					patch(
						{ ...labelBody, ...(sendState ? (rep.state === 'open' ? { state: 'open' } : closing) : {}) },
						answer => (!sendState || matches(answer, rep)) && this.labelsDone(answer, remove, add),
						'the change of status'
					),
				applied: current => (!sendState || matches(current, rep)) && this.labelsDone(current, remove, add),
				...(repair === undefined ? {} : { repair }),
			},
		];
	}

	/**
	 * The steps that change labels (and, with `extra`, other fields) of an issue. A swap (some removed, some added) is ONE PATCH of the
	 * whole label set: no moment has the old and the new label together or neither. Only additions are one POST (in batches of 10), only
	 * removals are one DELETE each, which cannot overwrite a label someone else adds in the meantime.
	 */
	private labelSteps(args: {
		operation: string;
		issue: ApiIssue;
		remove: readonly string[];
		add: ReadonlyArray<{ name: string; kind: LabelKind }>;
		/** Other fields of the issue to change in the same PATCH (`{ type: 'Bug' }`). */
		extra?: Record<string, unknown>;
		extraDone?: (issue: ApiIssue) => boolean;
		extraWords?: string;
	}): Step[] {
		const { operation, issue, remove } = args;
		const number = issue.number;
		const add = args.add.map(label => label.name);
		const extra = args.extra ?? {};
		const hasExtra = Object.keys(extra).length > 0;
		const extraDone = args.extraDone ?? ((): boolean => true);
		const kindOf = (name: string): LabelKind => args.add.find(label => label.name === name)?.kind ?? 'user';
		if (remove.length === 0 && add.length === 0 && !hasExtra) return [];
		if (remove.length > 0 && add.length === 0 && !hasExtra) {
			return remove.map(label => this.removeLabelStep(number, operation, label));
		}
		if (remove.length === 0 && !hasExtra) {
			return add.map(name => this.addLabelsStep(number, operation, [name], kindOf(name)));
		}
		const labelsChange = remove.length + add.length > 0;
		const words = [
			...this.labelWords(remove, add),
			...(hasExtra && args.extraWords !== undefined ? [args.extraWords] : []),
		];
		return [
			{
				description: words.join(' and '),
				run: async () => {
					for (const name of add) await this.ensureLabel(name, kindOf(name));
					const answer = (
						await this.send<ApiIssue>(operation, String(number), 'PATCH', this.path(number), {
							...(labelsChange ? { labels: this.finalLabels(issue, remove, add) } : {}),
							...extra,
						})
					).body;
					if (!this.labelsDone(answer, remove, add) || !extraDone(answer)) {
						throw this.notApplied(operation, number, 'the change', answer);
					}
				},
				applied: current => this.labelsDone(current, remove, add) && extraDone(current),
			},
		];
	}

	// ---------------------------------------------------------------- labels

	private async ensureLabel(name: string, kind: LabelKind): Promise<void> {
		if (this.knownLabels.has(name.toLowerCase())) return;
		const probe = await this.host.client.get(`${this.host.repoPath}/labels/${enc(name)}`, {
			allowNotFound: true,
			cache: false,
		});
		if (probe.status === 404) await this.createLabel(name, kind);
		this.knownLabels.add(name.toLowerCase());
	}

	private async createLabel(name: string, kind: LabelKind): Promise<void> {
		const style = LABEL_STYLE[kind];
		try {
			await this.send('createLabel', name, 'POST', `${this.host.repoPath}/labels`, {
				name,
				color: style.color,
				...(style.description === undefined ? {} : { description: style.description }),
			});
		} catch (error) {
			// Created by someone else in the meantime: the label exists, which is all that is needed.
			const alreadyThere =
				error instanceof BackendRejectedError && /already_exists|already exists/.test(error.message);
			if (!alreadyThere) throw error;
		}
		this.knownLabels.add(name.toLowerCase());
	}

	/** `task labels sync`: creates the labels the configuration needs, in the order of the config; never deletes or edits one. */
	async syncLabels(options: { dryRun?: boolean }): Promise<LabelSyncReport> {
		const dryRun = options.dryRun === true;
		const wanted = wantedLabels(this.host.settings, this.map.projectTypes, this.host.fills);
		const present = await this.host.client.getAll<{ name: string }>(`${this.host.repoPath}/labels`, {
			query: { per_page: this.host.settings.pageSize },
			revalidate: true,
		});
		const known = new Set(present.items.map(label => label.name.toLowerCase()));
		const created: string[] = [];
		const existing: string[] = [];
		for (const label of wanted) {
			if (known.has(label.name.toLowerCase())) {
				existing.push(label.name);
				continue;
			}
			if (!dryRun) await this.createLabel(label.name, label.kind);
			created.push(label.name);
		}
		const notes =
			this.fill('meta') === 'labels'
				? [
						`Labels ${this.map.settings.metaPrefix}<key>=<value> are created when a value is set: their names depend on the data.`,
					]
				: [];
		return { dryRun, wanted, created, existing, notes };
	}

	/** A label name GitHub would refuse, as the error to throw; undefined when it is fine. */
	private labelError(operation: string, name: string): Error | undefined {
		const problem = labelProblem(name);
		if (problem === undefined) return undefined;
		if (name.length > GITHUB_LABEL_MAX && !name.includes(',') && name === name.trim()) {
			return new BackendLimitError(
				'github',
				'label name length',
				GITHUB_LABEL_MAX,
				`${problem}. Shorten it${this.host.fills['meta']?.use === 'labels' ? ' (for metadata, "meta: body-block" has no such limit)' : ''}.`
			);
		}
		return new BackendRejectedError(
			'github',
			operation,
			`GitHub does not accept the label ${problem}`,
			this.host.fills['meta']?.use === 'labels'
				? 'Use another name (no comma, no space at either end); metadata that needs a comma belongs to "meta: body-block"'
				: 'Use another name (no comma, no space at either end)'
		);
	}

	private reservedLabelError(operation: string, label: string): Error | undefined {
		const ctx = this.map;
		const lower = label.toLowerCase();
		const use = (command: string, what: string): Error =>
			new BackendRejectedError(
				'github',
				operation,
				`the label "${label}" is reserved: ${what}`,
				`Use ${command} instead of a label of that name`
			);
		if (ctx.mapper.isStatusLabel(label)) return use('task set-status', 'it carries the status of a task');
		if (typeOfLabel(label, ctx) !== undefined) return use('task set-type', 'it carries the type of a task');
		if (this.host.fills['meta']?.use === 'labels' && lower.startsWith(ctx.settings.metaPrefix.toLowerCase())) {
			return use('task set-meta', 'it carries the metadata of a task');
		}
		if (lower === TOMBSTONE_LABEL) return use('task delete', 'it marks a deleted task');
		return undefined;
	}

	async addLabel(id: string, label: string, options?: WriteOptions): Promise<VersionedRecord> {
		const error = this.labelError('addLabel', label) ?? this.reservedLabelError('addLabel', label);
		if (error !== undefined) throw error;
		const { issue } = await this.prepare(id, options, ['labels']);
		if (!has(issue, label)) {
			await this.runSteps('addLabel', issue.number, [
				this.addLabelsStep(issue.number, 'addLabel', [label], 'user'),
			]);
		}
		return this.read(issue.number);
	}

	async removeLabel(id: string, label: string, options?: WriteOptions): Promise<VersionedRecord> {
		const { issue } = await this.prepare(id, options, ['labels']);
		const held = labelNames(issue).find(name => eq(name, label));
		if (held !== undefined && !this.map.mapper.isStatusLabel(held) && typeOfLabel(held, this.map) === undefined) {
			await this.runSteps('removeLabel', issue.number, [this.removeLabelStep(issue.number, 'removeLabel', held)]);
		}
		return this.read(issue.number);
	}

	// ---------------------------------------------------------------- create, status

	/** What GitHub must hold for a status; a status the statusMap lacks is an UnsupportedByBackendError (the map is checked at load, so this is a safety net). */
	private representation(operation: string, status: string): StatusRepresentation {
		if (!this.map.mapper.knows(status)) {
			throw new UnsupportedByBackendError(
				'github',
				operation,
				'status',
				`The status "${status}" is not mapped to GitHub: add it to strategy.options.statusMap of the project config (state, and a label or a reason that tell it apart).`
			);
		}
		return this.map.mapper.representation(status);
	}

	async create(input: CreateTaskInput): Promise<VersionedRecord> {
		const rep = this.representation('create', input.status);
		let parent: ApiIssue | undefined;
		if (input.parentId !== undefined) {
			parent = (await this.host.loadIssue(input.parentId, { revalidate: false })).issue;
			await this.requireRoomForChild(parent);
		}
		const text = input.description?.trim() ?? '';
		const body = text === '' || text === input.title.trim() ? undefined : input.description!;
		if (body !== undefined && body.length > BODY_MAX) throw this.bodyLimit(body.length);
		if (rep.label !== undefined) await this.ensureLabel(rep.label, 'status');
		const created = (
			await this.send<ApiIssue>('create', 'new task', 'POST', `${this.host.repoPath}/issues`, {
				title: input.title,
				...(body === undefined ? {} : { body }),
				...(rep.label === undefined ? {} : { labels: [rep.label] }),
			})
		).body;
		const number = created.number;
		// The issue list shows it seconds late: remember it for the reads of the list.
		this.host.client.note('created', number);
		if (parent !== undefined) this.noteSubIssues(parent.number);
		const steps: Step[] = [];
		// Measured: GitHub ignores state and state_reason in the body of a create, so a closed task is created, then closed.
		if (rep.state === 'closed') {
			steps.push(
				...this.statusSteps({
					operation: 'create',
					issue: created,
					rep,
					repair: `task set-status ${number} ${input.status}`,
				})
			);
		}
		if (parent !== undefined) {
			const parentNumber = parent.number;
			steps.push({
				description: `attached the issue to #${parentNumber}`,
				run: () =>
					this.send('create', String(number), 'POST', this.path(parentNumber, '/sub_issues'), {
						sub_issue_id: created.id,
						replace_parent: true,
					}),
				applied: issue => issue.parent_issue_url?.endsWith(`/issues/${parentNumber}`) === true,
				repair: `task set-parent ${number} ${input.parentId}`,
			});
		}
		await this.runSteps('create', number, steps, [`created issue #${number}`]);
		return this.read(number);
	}

	async updateStatus(id: string, status: string, options?: WriteOptions): Promise<VersionedRecord> {
		const rep = this.representation('updateStatus', status);
		const { issue } = await this.prepare(id, options, ['status']);
		const number = issue.number;
		if (statusOfIssue(issue, this.map) === status) {
			throw new TaskConflictError(`Task "${number}" is already in status "${status}"`);
		}
		const remove = labelNames(issue).filter(
			name => this.map.mapper.isStatusLabel(name) && (rep.label === undefined || !eq(name, rep.label))
		);
		const add = rep.label !== undefined && !has(issue, rep.label) ? [rep.label] : [];
		const steps = this.statusSteps({
			operation: 'updateStatus',
			issue,
			rep,
			remove,
			add,
			repair: `task set-status ${number} ${status}`,
		});
		await this.runSteps('updateStatus', number, steps);
		return this.read(number);
	}

	// ---------------------------------------------------------------- text

	private bodyLimit(length: number): BackendLimitError {
		return new BackendLimitError(
			'github',
			'body length',
			BODY_MAX,
			`The text has ${length} characters; GitHub keeps ${BODY_MAX} at most in an issue body. Shorten it, or put the long text in a comment (task comment).`
		);
	}

	async setTitle(id: string, title: string, options?: WriteOptions): Promise<VersionedRecord> {
		const { issue } = await this.prepare(id, options, ['title']);
		if (issue.title !== title) {
			await this.runSteps('setTitle', issue.number, [
				{
					description: 'renamed the issue',
					run: () => this.send('setTitle', String(issue.number), 'PATCH', this.path(issue.number), { title }),
					applied: current => current.title === title,
				},
			]);
		}
		return this.read(issue.number);
	}

	async setDescription(id: string, description: string, options?: WriteOptions): Promise<VersionedRecord> {
		const { issue } = await this.prepare(id, options, ['body']);
		const parts = splitBody(issue, this.map);
		// Like the local store: a description equal to the title is no description.
		const visible = description.trim() === issue.title.trim() ? '' : description;
		await this.writeBody(issue, 'setDescription', composeBody(visible, parts.blockData));
		return this.read(issue.number);
	}

	/** One PATCH of the body, skipped when it is already that text. */
	private async writeBody(issue: ApiIssue, operation: string, body: string): Promise<void> {
		if (body.length > BODY_MAX) throw this.bodyLimit(body.length);
		if (body === (issue.body ?? '').replace(/\r\n/g, '\n')) return;
		await this.runSteps(operation, issue.number, [
			{
				description: 'wrote the body',
				run: () => this.send(operation, String(issue.number), 'PATCH', this.path(issue.number), { body }),
				applied: current => (current.body ?? '').replace(/\r\n/g, '\n') === body,
			},
		]);
	}

	// ---------------------------------------------------------------- type

	private typeLabelsHeld(issue: ApiIssue): string[] {
		return labelNames(issue).filter(name => typeOfLabel(name, this.map) !== undefined);
	}

	async setType(id: string, type: string, options?: WriteOptions): Promise<VersionedRecord> {
		const { typeMap, typePrefix } = this.map.settings;
		const rule = Object.hasOwn(typeMap, type) ? typeMap[type] : undefined;
		const label = rule?.issueType !== undefined ? undefined : (rule?.label ?? `${typePrefix}${type}`);
		if (label !== undefined) {
			const problem = labelProblem(label);
			if (problem !== undefined) {
				throw new BackendLimitError(
					'github',
					'label name length',
					GITHUB_LABEL_MAX,
					`The type "${type}" needs the label ${problem}. Give the type a shorter name, set strategy.options.typePrefix to a shorter prefix, or map it in strategy.options.typeMap (a label or a native issue type).`
				);
			}
		}
		const { issue } = await this.prepare(id, options, ['type']);
		const number = issue.number;
		if (typeOf(issue, this.map) === type) return this.read(number);
		const wanted = rule?.issueType;
		const steps = this.labelSteps({
			operation: 'setType',
			issue,
			remove: this.typeLabelsHeld(issue).filter(held => label === undefined || !eq(held, label)),
			add: label !== undefined && !has(issue, label) ? [{ name: label, kind: 'type' }] : [],
			...(wanted === undefined
				? {}
				: {
						extra: { type: wanted },
						extraDone: (current: ApiIssue) =>
							current.type?.name !== undefined && eq(current.type.name, wanted),
						extraWords: `set the issue type ${wanted}`,
					}),
		});
		await this.runSteps('setType', number, steps);
		return this.read(number);
	}

	async clearType(id: string, options?: WriteOptions): Promise<VersionedRecord> {
		const { issue } = await this.prepare(id, options, ['type']);
		const number = issue.number;
		const hasNative = issue.type !== undefined && issue.type !== null;
		const steps = this.labelSteps({
			operation: 'clearType',
			issue,
			remove: this.typeLabelsHeld(issue),
			add: [],
			...(hasNative
				? {
						extra: { type: null },
						extraDone: (current: ApiIssue) => current.type === undefined || current.type === null,
						extraWords: 'cleared the issue type',
					}
				: {}),
		});
		await this.runSteps('clearType', number, steps);
		return this.read(number);
	}

	// ---------------------------------------------------------------- meta

	private metaUnsupported(operation: string): UnsupportedByBackendError {
		return new UnsupportedByBackendError(
			'github',
			operation,
			'meta',
			'A GitHub issue has no metadata. Declare where task keeps it, in strategy.options.fills of the project config: "meta: labels" (one label meta:<key>=<value> per key, 50 characters at most each, exact) or "meta: { use: body-block, fidelity: degrade }" (a hidden block in the issue body, no size limit, approximate: someone editing the body on GitHub can overwrite it).'
		);
	}

	private metaLabel(key: string, value: string): string {
		return `${this.map.settings.metaPrefix}${key}${value === '' ? '' : `=${value}`}`;
	}

	private metaLabelsOfKey(issue: ApiIssue, key: string): string[] {
		const prefix = this.map.settings.metaPrefix.toLowerCase();
		return labelNames(issue).filter(name => {
			if (!name.toLowerCase().startsWith(prefix)) return false;
			const rest = name.slice(prefix.length);
			const at = rest.indexOf('=');
			return (at < 0 ? rest : rest.slice(0, at)) === key;
		});
	}

	async setMeta(id: string, key: string, value: string, options?: WriteOptions): Promise<VersionedRecord> {
		const mode = this.fill('meta');
		if (mode !== 'labels' && mode !== 'body-block') throw this.metaUnsupported('setMeta');
		if (mode === 'labels') {
			if (key === '' || key.includes('=')) {
				throw new BackendRejectedError(
					'github',
					'setMeta',
					`the meta key "${key}" cannot be part of a label (empty, or with "=")`,
					'Use a plain key, or declare "meta: body-block" in strategy.options.fills, which accepts any key'
				);
			}
			const label = this.metaLabel(key, value);
			const problem = labelProblem(label);
			if (problem !== undefined) {
				const tooLong = !value.includes(',') && !key.includes(',') && label.length > GITHUB_LABEL_MAX;
				throw tooLong
					? new BackendLimitError(
							'github',
							'label name length',
							GITHUB_LABEL_MAX,
							`The meta ${key}=${value.length > 20 ? `${value.slice(0, 20)}...` : value} would be the label ${problem}. Keep key and value short, or declare "meta: body-block" in strategy.options.fills (no size limit).`
						)
					: new BackendRejectedError(
							'github',
							'setMeta',
							`the meta ${key} cannot be a label: ${problem}`,
							'Declare "meta: body-block" in strategy.options.fills, which accepts any text'
						);
			}
		}
		const { issue } = await this.prepare(id, options, ['meta']);
		const number = issue.number;
		const currentMeta = metaOf(issue, this.map);
		if (currentMeta !== undefined && Object.hasOwn(currentMeta, key) && currentMeta[key] === value) {
			return this.read(number);
		}
		if (mode === 'labels') {
			const label = this.metaLabel(key, value);
			const steps = this.labelSteps({
				operation: 'setMeta',
				issue,
				remove: this.metaLabelsOfKey(issue, key),
				add: [{ name: label, kind: 'meta' }],
			});
			await this.runSteps('setMeta', number, steps);
		} else {
			const parts = splitBody(issue, this.map);
			const meta = { ...(parts.blockMeta ?? {}), [key]: value };
			await this.writeBlock(issue, 'setMeta', { ...(parts.blockData ?? {}), meta }, parts.visibleText);
			this.emulated(
				`meta is emulated: it is kept in a hidden block of the body of the issues (fills.meta: body-block, accepted with fidelity: degrade); editing the body on GitHub can overwrite it`
			);
		}
		return this.read(number);
	}

	async removeMeta(id: string, key: string, options?: WriteOptions): Promise<VersionedRecord> {
		const mode = this.fill('meta');
		if (mode !== 'labels' && mode !== 'body-block') throw this.metaUnsupported('removeMeta');
		const { issue } = await this.prepare(id, options, ['meta']);
		const number = issue.number;
		if (!Object.hasOwn(metaOf(issue, this.map) ?? {}, key)) return this.read(number);
		if (mode === 'labels') {
			const steps = this.metaLabelsOfKey(issue, key).map(held =>
				this.removeLabelStep(number, 'removeMeta', held)
			);
			await this.runSteps('removeMeta', number, steps);
		} else {
			const parts = splitBody(issue, this.map);
			const meta = { ...(parts.blockMeta ?? {}) };
			delete meta[key];
			const data: Record<string, unknown> = { ...(parts.blockData ?? {}) };
			if (Object.keys(meta).length === 0) delete data['meta'];
			else data['meta'] = meta;
			await this.writeBlock(issue, 'removeMeta', data, parts.visibleText);
			this.emulated(
				`meta is emulated: it is kept in a hidden block of the body of the issues (fills.meta: body-block, accepted with fidelity: degrade); editing the body on GitHub can overwrite it`
			);
		}
		return this.read(number);
	}

	/** Writes the managed block (with the visible text in front of it) in one PATCH of the body. */
	private async writeBlock(
		issue: ApiIssue,
		operation: string,
		data: Record<string, unknown>,
		visible: string
	): Promise<void> {
		await this.writeBody(issue, operation, composeBody(visible, data));
	}

	// ---------------------------------------------------------------- hierarchy

	private childrenLimit(parent: number): BackendLimitError {
		return new BackendLimitError(
			'github',
			'sub-issues per parent',
			MAX_CHILDREN,
			`#${parent} already has ${MAX_CHILDREN} sub-issues, which is what GitHub allows; use another parent (${this.host.issueUrl(parent)})`
		);
	}

	/** The count of GitHub lags a change: with a sub-issue attached a moment ago the list is the truth. */
	private async requireRoomForChild(parent: ApiIssue): Promise<void> {
		let count = parent.sub_issues_summary?.total ?? 0;
		if (count < MAX_CHILDREN && this.host.mayHaveChildren(parent)) {
			count = Math.max(count, (await this.host.related(this.path(parent.number, '/sub_issues'))).length);
		}
		if (count >= MAX_CHILDREN) throw this.childrenLimit(parent.number);
	}

	/** The sub-issue count of the parent will lag the change (measured: 1 to 2 s): the reads that follow read the list. */
	private noteSubIssues(parent: number): void {
		this.host.client.note('subIssues', parent);
	}

	async setParent(id: string, parentId: string, options?: WriteOptions): Promise<VersionedRecord> {
		const { issue: child } = await this.prepare(id, options, ['parent']);
		const parent = (await this.host.loadIssue(parentId, { revalidate: false })).issue;
		const childId = String(child.number);
		const parentRef = String(parent.number);
		if (child.number === parent.number) throw new TaskConflictError(`Task "${childId}" cannot be its own parent`);
		const current = parentNumber(child, this.map);
		if (current === parent.number) return this.read(child.number);
		// The ancestors of the new parent: reaching the task means a cycle (GitHub says so too, after the write was tried).
		const chain: number[] = [];
		for (let up = parentNumber(parent, this.map); up !== undefined;) {
			chain.push(up);
			if (up === child.number) {
				throw new TaskConflictError(
					`Cannot set parent of "${childId}" to "${parentRef}": it would create a cycle (${[childId, parentRef, ...chain.map(String)].join(' -> ')}); "${parentRef}" is a descendant of "${childId}"`
				);
			}
			if (chain.length > MAX_DEPTH) break;
			up = parentNumber((await this.host.loadIssue(String(up), { revalidate: false })).issue, this.map);
		}
		await this.requireRoomForChild(parent);
		this.noteSubIssues(parent.number);
		await this.runSteps('setParent', child.number, [
			{
				description: `attached the issue to #${parent.number}`,
				run: () =>
					this.send('setParent', childId, 'POST', this.path(parent.number, '/sub_issues'), {
						sub_issue_id: child.id,
						replace_parent: true,
					}),
				applied: issue => issue.parent_issue_url?.endsWith(`/issues/${parent.number}`) === true,
			},
		]);
		return this.read(child.number);
	}

	async removeParent(id: string, options?: WriteOptions): Promise<VersionedRecord> {
		const { issue } = await this.prepare(id, options, ['parent']);
		const url = issue.parent_issue_url;
		if (url === undefined || url === null) throw new TaskConflictError(`Task "${issue.number}" has no parent`);
		const location = /\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(new URL(url).pathname);
		if (location === null) {
			throw new BackendDataError(
				'github',
				`issue #${issue.number}`,
				`the parent of issue #${issue.number} has an address task does not understand (${url})`,
				`Remove the parent on ${this.host.issueUrl(issue.number)}`
			);
		}
		const parentPath = `/repos/${location[1]}/issues/${location[2]}/sub_issue`;
		await this.runSteps('removeParent', issue.number, [
			{
				description: 'detached the issue from its parent',
				run: () =>
					this.send('removeParent', String(issue.number), 'DELETE', parentPath, { sub_issue_id: issue.id }),
				applied: current => current.parent_issue_url === undefined || current.parent_issue_url === null,
			},
		]);
		return this.read(issue.number);
	}

	// ---------------------------------------------------------------- links

	private linkUnsupported(type: LinkType): UnsupportedByBackendError {
		if (type === 'duplicateOf') {
			return new UnsupportedByBackendError(
				'github',
				'addLink',
				'linkTypes',
				'GitHub keeps no readable target for a duplicate. To store it, declare in strategy.options.fills of the project config: "linkTypes.duplicateOf: { use: duplicate-marker, fidelity: degrade }" -- task then writes the link in a hidden block of the issue body and closes the issue as a duplicate (the project needs a terminal status with { state: closed, reason: duplicate } in statusMap).'
			);
		}
		return new UnsupportedByBackendError(
			'github',
			'addLink',
			'linkTypes',
			`GitHub has no "${type}" relation. Use blockedBy (GitHub issue dependencies)${this.fill('linkTypes.duplicateOf') === undefined ? ', or duplicateOf with its fill (strategy.options.fills)' : ''}, or say it in a comment (task comment).`
		);
	}

	/** The dependency counts of both issues will lag the change (measured: 1 to 2 s): the reads that follow ignore them for a while. */
	private noteDependencies(...numbers: number[]): void {
		for (const number of numbers) this.host.client.note('dependencies', number);
	}

	private requireLinkType(type: string): LinkType {
		if (!(LINK_TYPES as readonly string[]).includes(type)) {
			throw new Error(`Unknown link type "${type}". Valid types: ${LINK_TYPES.join(', ')}`);
		}
		return type as LinkType;
	}

	async addLink(id: string, type: LinkType, targetId: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.requireLinkType(type);
		if (type === 'causedBy') throw this.linkUnsupported(type);
		if (type === 'duplicateOf') return this.addDuplicate(id, targetId, options);
		const { issue } = await this.prepare(id, options, ['dependencies']);
		const source = String(issue.number);
		const target = (await this.targetOf(issue, targetId, source)).issue;
		// The counts of GitHub lag a change by seconds: the list is the truth, always read here.
		const blockers = await this.host.related(this.path(issue.number, '/dependencies/blocked_by'));
		if (blockers.some(blocker => blocker.number === target.number)) {
			throw new TaskConflictError(`Task "${source}" is already blockedBy "${target.number}"`);
		}
		this.noteDependencies(issue.number, target.number);
		await this.runSteps('addLink', issue.number, [
			{
				description: `added the dependency on #${target.number}`,
				run: async () => {
					try {
						await this.send(
							'addLink',
							source,
							'POST',
							this.path(issue.number, '/dependencies/blocked_by'),
							{
								issue_id: target.id,
							}
						);
					} catch (error) {
						if (error instanceof TaskConflictError && /cycle/.test(error.message)) {
							throw new TaskConflictError(
								`Cannot link "${source}" blockedBy "${target.number}": it would create a cycle`
							);
						}
						throw error;
					}
				},
				applied: current => (current.issue_dependencies_summary?.total_blocked_by ?? 0) > blockers.length,
			},
		]);
		return this.read(issue.number);
	}

	private async targetOf(issue: ApiIssue, targetId: string, source: string): Promise<{ issue: ApiIssue }> {
		const loaded = await this.host.loadIssue(targetId, { revalidate: false });
		if (loaded.issue.number === issue.number)
			throw new TaskConflictError(`Task "${source}" cannot be linked to itself`);
		return loaded;
	}

	async removeLink(id: string, type: LinkType, targetId: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.requireLinkType(type);
		if (type === 'causedBy') throw this.linkUnsupported(type);
		if (type === 'duplicateOf') return this.removeDuplicate(id, targetId, options);
		const { issue } = await this.prepare(id, options, ['dependencies']);
		const source = String(issue.number);
		const wanted = Number(targetId.replace('#', ''));
		const blockers = await this.host.related(this.path(issue.number, '/dependencies/blocked_by'));
		const target = blockers.find(blocker => blocker.number === wanted);
		if (target === undefined) throw new TaskConflictError(`Task "${source}" is not blockedBy "${targetId}"`);
		this.noteDependencies(issue.number, target.number);
		await this.runSteps('removeLink', issue.number, [
			{
				description: `removed the dependency on #${target.number}`,
				run: () =>
					this.sendTolerant(
						'removeLink',
						source,
						'DELETE',
						this.path(issue.number, `/dependencies/blocked_by/${target.id}`)
					),
				applied: current => (current.issue_dependencies_summary?.total_blocked_by ?? 0) < blockers.length,
			},
		]);
		return this.read(issue.number);
	}

	// ---- duplicateOf (fill: duplicate-marker)

	private requireDuplicateFill(operation: string): void {
		if (this.fill('linkTypes.duplicateOf') !== 'duplicate-marker') throw this.linkUnsupported('duplicateOf');
		if (!this.map.mapper.hasClosedReason('duplicate') && operation === 'addLink') {
			throw new UnsupportedByBackendError(
				'github',
				operation,
				'linkTypes',
				'Closing an issue as a duplicate needs a status of the project that means it: add one to the project statuses and to strategy.options.statusMap with { state: closed, reason: duplicate }, for example "duplicate: { state: closed, reason: duplicate }".'
			);
		}
	}

	private async addDuplicate(id: string, targetId: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.requireDuplicateFill('addLink');
		const { issue } = await this.prepare(id, options, ['body', 'status']);
		const source = String(issue.number);
		const target = (await this.targetOf(issue, targetId, source)).issue;
		const parts = splitBody(issue, this.map);
		if (parts.duplicateOf === String(target.number)) {
			throw new TaskConflictError(`Task "${source}" is already duplicateOf "${target.number}"`);
		}
		if (parts.duplicateOf !== undefined) {
			throw new TaskConflictError(
				`Task "${source}" is already a duplicateOf of "${parts.duplicateOf}". Run: task unlink ${source} duplicateOf ${parts.duplicateOf} first`
			);
		}
		const path = [source, String(target.number)];
		let next: string | undefined = splitBody(target, this.map).duplicateOf;
		for (let hops = 0; next !== undefined && hops < 20; hops++) {
			path.push(next);
			if (next === source) {
				throw new TaskConflictError(
					`Cannot link "${source}" duplicateOf "${target.number}": it would create a cycle (${path.join(' -> ')})`
				);
			}
			next = splitBody((await this.host.loadIssue(next, { revalidate: false })).issue, this.map).duplicateOf;
		}
		const links = [
			...(Array.isArray(parts.blockData?.['links']) ? (parts.blockData['links'] as unknown[]) : []),
			{ type: 'duplicateOf', target: String(target.number) },
		];
		const body = composeBody(parts.visibleText, { ...(parts.blockData ?? {}), links });
		if (body.length > BODY_MAX) throw this.bodyLimit(body.length);
		const rep: StatusRepresentation = { state: 'closed', reason: 'duplicate', label: undefined };
		await this.runSteps('addLink', issue.number, [
			{
				description: 'wrote the duplicate marker in the body',
				run: () => this.send('addLink', source, 'PATCH', this.path(issue.number), { body }),
				applied: current => splitBody(current, this.map).duplicateOf === String(target.number),
				repair: `task link ${source} duplicateOf ${target.number}`,
			},
			...this.statusSteps({
				operation: 'addLink',
				issue,
				rep,
				extraClose: { duplicate_issue_id: target.id },
				repair: `task link ${source} duplicateOf ${target.number}`,
			}),
		]);
		this.emulated(
			`duplicateOf is emulated: the link is kept in a hidden block of the issue body and the issue was closed as a duplicate (fills.linkTypes.duplicateOf: duplicate-marker, accepted with fidelity: degrade); the status of #${source} is now the one that maps "closed as duplicate"`
		);
		return this.read(issue.number);
	}

	private async removeDuplicate(id: string, targetId: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.requireDuplicateFill('removeLink');
		const { issue } = await this.prepare(id, options, ['body']);
		const source = String(issue.number);
		const parts = splitBody(issue, this.map);
		if (parts.duplicateOf === undefined || parts.duplicateOf !== targetId.replace('#', '')) {
			throw new TaskConflictError(`Task "${source}" is not duplicateOf "${targetId}"`);
		}
		const links = (
			Array.isArray(parts.blockData?.['links']) ? (parts.blockData['links'] as Array<{ type?: unknown }>) : []
		).filter(link => link?.type !== 'duplicateOf');
		const data: Record<string, unknown> = { ...(parts.blockData ?? {}) };
		if (links.length === 0) delete data['links'];
		else data['links'] = links;
		await this.writeBody(issue, 'removeLink', composeBody(parts.visibleText, data));
		this.emulated(
			`the duplicate marker of #${source} was removed, but GitHub still shows the issue closed as a duplicate; give it its status back with: task set-status ${source} <status>`
		);
		return this.read(issue.number);
	}

	// ---------------------------------------------------------------- comments

	async addComment(
		id: string,
		text: string,
		options?: WriteOptions & { author?: string }
	): Promise<BackendCommentChange> {
		if (options?.author !== undefined) {
			throw new UnsupportedByBackendError(
				'github',
				'addComment',
				'comments',
				'GitHub writes the comment as the user of the token, so an author cannot be chosen: leave out --author (or "author" in the request).'
			);
		}
		const clean = normalizeCommentText(text);
		const { issue } = await this.prepare(id, options, []);
		const created = (
			await this.send<ApiComment>(
				'addComment',
				String(issue.number),
				'POST',
				this.path(issue.number, '/comments'),
				{ body: clean }
			)
		).body;
		return { task: await this.read(issue.number), comment: commentsOf([created])[0]! };
	}

	private async commentsOfIssue(issue: ApiIssue): Promise<ApiComment[]> {
		return (
			await this.host.client.getAll<ApiComment>(this.path(issue.number, '/comments'), {
				query: { per_page: this.host.settings.pageSize },
				revalidate: true,
			})
		).items;
	}

	private async findComment(issue: ApiIssue, commentId: string): Promise<ApiComment> {
		const comments = await this.commentsOfIssue(issue);
		const found = comments.find(comment => String(comment.id) === commentId);
		if (found === undefined) {
			throw new CommentNotFoundError(
				String(issue.number),
				commentId,
				comments.map(comment => String(comment.id))
			);
		}
		return found;
	}

	async editComment(
		id: string,
		commentId: string,
		text: string,
		options?: WriteOptions
	): Promise<BackendCommentEdit> {
		const clean = normalizeCommentText(text);
		const { issue } = await this.prepare(id, options, []);
		const before = await this.findComment(issue, commentId);
		if (before.body === clean) {
			return {
				task: await this.read(issue.number),
				comment: commentsOf([before])[0]!,
				oldText: before.body,
				changed: false,
			};
		}
		const edited = (
			await this.send<ApiComment>(
				'editComment',
				String(issue.number),
				'PATCH',
				`${this.host.repoPath}/issues/comments/${before.id}`,
				{
					body: clean,
				}
			)
		).body;
		return {
			task: await this.read(issue.number),
			comment: commentsOf([edited])[0]!,
			oldText: before.body,
			changed: true,
		};
	}

	async removeComment(id: string, commentId: string, options?: WriteOptions): Promise<BackendCommentChange> {
		const { issue } = await this.prepare(id, options, []);
		const before = await this.findComment(issue, commentId);
		await this.sendTolerant(
			'removeComment',
			String(issue.number),
			'DELETE',
			`${this.host.repoPath}/issues/comments/${before.id}`
		);
		return { task: await this.read(issue.number), comment: commentsOf([before])[0]! };
	}

	// ---------------------------------------------------------------- delete

	private deleteUnsupported(): UnsupportedByBackendError {
		return new UnsupportedByBackendError(
			'github',
			'deleteTask',
			'delete',
			'GitHub has no way to delete an issue with an ordinary token. Declare a fill in strategy.options.fills of the project config: "delete: hard" (GraphQL deleteIssue: needs a repository administrator, and for an organization the opt-in; exact) or "delete: tombstone" with fidelity: degrade (the issue is closed as not planned, labelled task:deleted and hidden from task; it stays on GitHub; approximate). Or close it instead: task set-status <id> <terminal status>.'
		);
	}

	async deleteTask(id: string, options?: WriteOptions): Promise<boolean> {
		const mode = this.fill('delete');
		if (mode !== 'tombstone' && mode !== 'hard') throw this.deleteUnsupported();
		let issue: ApiIssue;
		try {
			({ issue } = await this.prepare(id, options, [
				'title',
				'body',
				'status',
				'type',
				'labels',
				'meta',
				'parent',
				'dependencies',
			]));
		} catch (error) {
			if (error instanceof TaskNotFoundError) return false;
			throw error;
		}
		// Already deleted (a tombstone) is gone, as for a task that does not exist.
		if (mode === 'tombstone' && isTombstone(issue)) return false;
		return mode === 'hard' ? this.deleteHard(issue) : this.deleteTombstone(issue);
	}

	private async deleteHard(issue: ApiIssue): Promise<boolean> {
		const number = issue.number;
		if (issue.node_id === undefined) {
			throw new BackendDataError(
				'github',
				`issue #${number}`,
				`GitHub sent no node id for issue #${number}`,
				'Retry; if it persists the service is misbehaving'
			);
		}
		const answer = await this.host.client.graphql<{ deleteIssue: unknown }>(
			'mutation($id: ID!) { deleteIssue(input: {issueId: $id}) { clientMutationId } }',
			{ id: issue.node_id }
		);
		const error = answer.errors?.[0];
		if (error !== undefined) {
			if (error.type === 'NOT_FOUND') return false;
			if (error.type === 'FORBIDDEN' || error.type === 'INSUFFICIENT_SCOPES') {
				throw new BackendAuthError(
					'github',
					'forbidden',
					`GitHub refused to delete issue #${number}: ${error.message}`,
					`Deleting an issue needs a repository administrator (and, in an organization, the owners must allow it). Use a token of an administrator, or declare "delete: tombstone" with fidelity: degrade in strategy.options.fills instead (the issue is closed and hidden, not deleted).`
				);
			}
			throw new BackendRejectedError(
				'github',
				'deleteTask',
				`GitHub could not delete issue #${number}: ${error.message}`,
				`Look at ${this.host.issueUrl(number)}`
			);
		}
		try {
			await this.host.loadIssue(String(number), { revalidate: true });
		} catch (error2) {
			if (error2 instanceof TaskNotFoundError) return true;
			throw error2;
		}
		throw new BackendDataError(
			'github',
			`issue #${number}`,
			`GitHub said issue #${number} was deleted, but it is still there`,
			`Look at ${this.host.issueUrl(number)}`
		);
	}

	private async deleteTombstone(issue: ApiIssue): Promise<boolean> {
		const number = issue.number;
		const operation = 'deleteTask';
		const rep: StatusRepresentation = { state: 'closed', reason: 'not_planned', label: undefined };
		await this.ensureLabel(TOMBSTONE_LABEL, 'deleted');
		const steps: Step[] = [];
		const children = this.host.mayHaveChildren(issue)
			? await this.host.related(this.path(number, '/sub_issues'))
			: [];
		for (const child of children) {
			steps.push({
				description: `detached the sub-issue #${child.number}`,
				run: () =>
					this.sendTolerant(operation, String(number), 'DELETE', this.path(number, '/sub_issue'), {
						sub_issue_id: child.id,
					}),
				applied: () => false,
			});
		}
		const parent = parentNumber(issue, this.map);
		if (parent !== undefined) {
			steps.push({
				description: `detached the issue from its parent #${parent}`,
				run: () =>
					this.sendTolerant(operation, String(number), 'DELETE', this.path(parent, '/sub_issue'), {
						sub_issue_id: issue.id,
					}),
				applied: () => false,
			});
		}
		// Hidden last: until then the issue is a closed task like any other, and the command can be run again.
		steps.push(...this.statusSteps({ operation, issue, rep, repair: `task delete ${number}` }), {
			description: `labelled the issue ${TOMBSTONE_LABEL}`,
			run: () =>
				this.send(operation, String(number), 'POST', this.path(number, '/labels'), {
					labels: [TOMBSTONE_LABEL],
				}),
			applied: current => isTombstone(current),
			repair: `task delete ${number}`,
		});
		await this.runSteps(operation, number, steps);
		this.emulated(
			`delete is emulated: issue #${number} was closed as not planned and labelled ${TOMBSTONE_LABEL}; it is hidden from task but still on GitHub, and its number stays used (fills.delete: tombstone, accepted with fidelity: degrade)`
		);
		return true;
	}
}
