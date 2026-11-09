// The write path of the gitlab strategy: every TaskBackend write as official REST calls.
//
// NOT VERIFIED AGAINST A REAL GITLAB: built from docs.gitlab.com and a fake server modelled on it.
//
// How a write goes (design 1.6):
//  1. the issue is read again (a conditional GET) and compared with the caller's expectedRevision on the parts the write changes
//     (gitlabRevision.ts) -- GitLab documents no conditional write, so a short race remains between that read and the write, and
//     `task strategy check` says so;
//  2. the write is a list of steps, sent one after the other; a failure after the first step is a PartialWriteError that says what
//     GitLab holds now and how to finish; a 5xx or a lost connection is never trusted either way: the issue is read again to see;
//  3. the record is read again and returned, so what the caller gets is what GitLab holds, not what was asked.
// Nothing here is silent: an operation GitLab cannot do is an UnsupportedByBackendError naming the tier or the fill that gives it.
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

import { GitLabHttpError } from './gitlabClient.js';
import type { ClientResponse } from './gitlabClient.js';
import { wantedLabels } from './gitlabLabels.js';
import {
	TOMBSTONE_LABEL,
	commentsOf,
	composeBody,
	isTombstone,
	labelNames,
	metaLabelName,
	metaLabelProblem,
	metaOf,
	parseMetaLabel,
	splitBody,
	statusOfIssue,
	typeOf,
	typeOfLabel,
} from './gitlabMapping.js';
import type { MapContext } from './gitlabMapping.js';
import { COMMENT_MAX, DESCRIPTION_MAX, LABELS_PER_ISSUE, labelProblem } from './gitlabOptions.js';
import { checkRevision, revisionOf } from './gitlabRevision.js';
import type { FieldGroup } from './gitlabRevision.js';
import type { StatusRepresentation } from './gitlabStatusMapping.js';
import type { ApiIssue, ApiLinkedIssue, ApiNote, ApiProjectLabel } from './gitlabTypes.js';
import type { WriteHost } from './gitlabWriteHost.js';

type LabelKind = 'status' | 'type' | 'meta' | 'user' | 'deleted';

/** The colour and description a label created by `task labels sync` gets (GitLab needs a colour: `#RRGGBB`). */
const LABEL_STYLE: Record<LabelKind, { color: string; description?: string }> = {
	status: { color: '#1d76db', description: 'Task status (set by the task tool)' },
	type: { color: '#a2eeef', description: 'Task type (set by the task tool)' },
	meta: { color: '#d4c5f9', description: 'Task metadata (set by the task tool)' },
	user: { color: '#ededed' },
	deleted: { color: '#b60205', description: 'Deleted task, hidden by the task tool' },
};

/** One call of a multi-call write. `description` is the past tense: it is shown as applied or as not applied. */
interface Step {
	description: string;
	run: () => Promise<unknown>;
	applied: (issue: ApiIssue) => boolean | Promise<boolean>;
	/** The command that finishes the job when this step is not applied. */
	repair?: string;
}

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const has = (issue: ApiIssue, label: string): boolean => labelNames(issue).some(name => eq(name, label));
const isUnknownOutcome = (error: unknown): boolean =>
	error instanceof BackendUnreachableError || error instanceof BackendTimeoutError;
const stateOf = (issue: Pick<ApiIssue, 'state'>): 'open' | 'closed' => (issue.state === 'closed' ? 'closed' : 'open');

/** A line that starts with a slash and a letter is a quick action for GitLab (`/close`, `/label ~x`, `/duplicate #3`...). */
const QUICK_ACTION_LINE = /^[ \t]*\/[A-Za-z][^\s/]*(?:[ \t]|$)/m;

/** The scope of a scoped label (everything before the last `::`), or undefined for a label that is not scoped. */
function scopeOf(name: string): string | undefined {
	const at = name.lastIndexOf('::');
	return at <= 0 ? undefined : name.slice(0, at).toLowerCase();
}

export class GitLabWriter {
	constructor(private readonly host: WriteHost) {}

	private get map(): MapContext {
		return this.host.map;
	}

	private path(iid: number, tail = ''): string {
		return `${this.host.projectPath}/issues/${iid}${tail}`;
	}

	private fill(key: string): string | undefined {
		return this.host.fills[key]?.use;
	}

	private emulated(text: string): void {
		this.map.notice({ kind: 'emulated', text });
	}

	// ---------------------------------------------------------------- sending, translating

	private translate(error: unknown, operation: string, subject: string): unknown {
		if (!(error instanceof GitLabHttpError)) return error;
		const texts = [error.detail, ...error.errors].filter(text => text !== '').join('; ');
		const lower = texts.toLowerCase();
		if (error.status === 404) return new TaskNotFoundError(subject);
		if (/label/.test(lower) && /(too many|maximum|more than)/.test(lower) && /\d/.test(lower)) {
			return new BackendLimitError(
				'gitlab',
				'labels per issue',
				LABELS_PER_ISSUE,
				`An issue holds ${LABELS_PER_ISSUE} labels at most, statuses, types and metadata included; remove some with: task remove-label ${subject} <label>`
			);
		}
		return new BackendRejectedError(
			'gitlab',
			operation,
			`GitLab refused ${operation} on ${subject} (${error.status}${texts === '' ? '' : `: ${texts}`})`,
			'Nothing was changed by this call. Check the values against what GitLab accepts (names, lengths, the role of the token user).'
		);
	}

	private async send<T>(
		operation: string,
		subject: string,
		method: 'POST' | 'PUT' | 'DELETE',
		path: string,
		body?: unknown
	): Promise<ClientResponse<T>> {
		try {
			return await this.host.client.write<T>(method, path, body);
		} catch (error) {
			throw this.translate(error, operation, subject);
		}
	}

	/** A call whose "it is not there" answer is the wanted result (removing a link that is already gone). */
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
	): Promise<{ issue: ApiIssue }> {
		const { issue, response } = await this.host.loadIssue(id, { revalidate: true });
		void response;
		const expected = options?.expectedRevision;
		if (expected !== undefined) {
			const actual = revisionOf(issue, this.map);
			if (checkRevision(expected, actual, groups).length > 0) {
				throw new StaleRevisionError(String(issue.iid), expected, actual);
			}
		}
		return { issue };
	}

	private read(iid: number): Promise<VersionedRecord> {
		return this.host.readRecord(String(iid));
	}

	// ---------------------------------------------------------------- steps

	/**
	 * Sends the steps in order. A step refused for good, with nothing before it applied, is that error (nothing changed). Any other
	 * failure -- a refusal after a first step, or a call whose outcome is unknown (5xx, lost connection) -- is checked against a fresh
	 * read: a step that did apply counts, and a write that stopped halfway is a PartialWriteError with both lists.
	 */
	private async runSteps(
		operation: string,
		iid: number,
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
					current = (await this.host.loadIssue(String(iid), { revalidate: true })).issue;
				} catch {
					current = undefined;
				}
				if (current !== undefined && unknown && (await step.applied(current))) continue;
				const applied = [...alreadyApplied, ...steps.slice(0, index).map(done => done.description)];
				if (applied.length === 0) throw error;
				const pending = steps.slice(index);
				const repairs = [
					...new Set(
						pending.map(todo => todo.repair).filter((repair): repair is string => repair !== undefined)
					),
				];
				throw new PartialWriteError({
					backendKind: 'gitlab',
					operation,
					taskId: String(iid),
					applied,
					notApplied: pending.map(todo => todo.description),
					hint:
						repairs.length > 0
							? `Finish it with: ${repairs.join(' ; ')} (what GitLab holds now: ${this.host.issueUrl(iid)})`
							: `Check the issue on GitLab and redo what is missing: ${this.host.issueUrl(iid)}`,
					cause: error,
				});
			}
		}
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

	private notApplied(operation: string, iid: number, what: string, answer: ApiIssue): BackendDataError {
		return new BackendDataError(
			'gitlab',
			`issue #${iid}`,
			`GitLab did not apply ${what} on issue #${iid} (it answered state ${answer.state}, labels ${labelNames(answer).join(', ') || 'none'}) during ${operation}`,
			`Look at ${this.host.issueUrl(iid)}; the project may restrict who can change issues`
		);
	}

	/** The count of labels the issue would hold must stay within the instance limit. */
	private checkLabelCount(iid: number, labels: readonly string[]): void {
		if (labels.length > LABELS_PER_ISSUE) {
			throw new BackendLimitError(
				'gitlab',
				'labels per issue',
				LABELS_PER_ISSUE,
				`Issue #${iid} would hold ${labels.length} labels; GitLab allows ${LABELS_PER_ISSUE}, statuses, types and metadata included. Remove some with: task remove-label ${iid} <label>`
			);
		}
	}

	/**
	 * One PUT that changes the whole label set (a swap: no moment has the old and the new label together or neither) and, with
	 * `extra`, other fields of the issue. The answer is checked.
	 */
	private labelSetStep(args: {
		operation: string;
		issue: ApiIssue;
		remove: readonly string[];
		add: readonly string[];
		extra?: Record<string, unknown>;
		extraDone?: (issue: ApiIssue) => boolean;
		extraWords?: string;
		repair?: string;
	}): Step[] {
		const { operation, issue, remove, add } = args;
		const iid = issue.iid;
		const extra = args.extra ?? {};
		const hasExtra = Object.keys(extra).length > 0;
		const labelsChange = remove.length + add.length > 0;
		if (!labelsChange && !hasExtra) return [];
		const extraDone = args.extraDone ?? ((): boolean => true);
		const final = this.finalLabels(issue, remove, add);
		if (labelsChange) this.checkLabelCount(iid, final);
		const words = [
			...this.labelWords(remove, add),
			...(hasExtra && args.extraWords !== undefined ? [args.extraWords] : []),
		];
		return [
			{
				description: words.join(' and '),
				run: async () => {
					const answer = (
						await this.send<ApiIssue>(operation, String(iid), 'PUT', this.path(iid), {
							...(labelsChange ? { labels: final.join(',') } : {}),
							...extra,
						})
					).body;
					if (!this.labelsDone(answer, remove, add) || !extraDone(answer)) {
						throw this.notApplied(operation, iid, 'the change', answer);
					}
				},
				applied: current => this.labelsDone(current, remove, add) && extraDone(current),
				...(args.repair === undefined ? {} : { repair: args.repair }),
			},
		];
	}

	// ---------------------------------------------------------------- labels

	/** `task labels sync`: creates the labels the configuration needs, in the order of the config; never deletes or edits one. */
	async syncLabels(options: { dryRun?: boolean }): Promise<LabelSyncReport> {
		const dryRun = options.dryRun === true;
		const wanted = wantedLabels(this.host.settings, this.map.projectTypes, this.host.fills);
		// include_ancestor_groups is true by default: a label of a parent group counts as existing.
		const present = await this.host.client.getAll<ApiProjectLabel>(`${this.host.projectPath}/labels`, {
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
		const notes: string[] = [];
		if (this.fill('meta') === 'labels') {
			const { metaPrefix, scopedLabels } = this.map.settings;
			notes.push(
				`Labels ${metaPrefix}<key>${scopedLabels ? '::<value>' : '=<value>'} are created when a value is set: their names depend on the data.`
			);
		}
		notes.push('Labels a user adds to a task are created by GitLab itself, with its default colour.');
		return { dryRun, wanted, created, existing, notes };
	}

	private async createLabel(name: string, kind: LabelKind): Promise<void> {
		const style = LABEL_STYLE[kind];
		try {
			await this.send('createLabel', name, 'POST', `${this.host.projectPath}/labels`, {
				name,
				color: style.color,
				...(style.description === undefined ? {} : { description: style.description }),
			});
		} catch (error) {
			// Created by someone else in the meantime: the label exists, which is all that is needed.
			const alreadyThere =
				error instanceof BackendRejectedError && /already exist|has already been taken/i.test(error.message);
			if (!alreadyThere) throw error;
		}
	}

	/** A label name GitLab would refuse, as the error to throw; undefined when it is fine. */
	private labelError(operation: string, name: string): Error | undefined {
		const problem = labelProblem(name);
		if (problem === undefined) return undefined;
		return new BackendRejectedError(
			'gitlab',
			operation,
			`GitLab does not accept the label ${problem}`,
			this.fill('meta') === 'labels'
				? 'Use another name (no comma, no space at either end); metadata that needs a comma belongs to "meta: body-block"'
				: 'Use another name (no comma, no space at either end)'
		);
	}

	private reservedLabelError(operation: string, label: string): Error | undefined {
		const ctx = this.map;
		const lower = label.toLowerCase();
		const use = (command: string, what: string): Error =>
			new BackendRejectedError(
				'gitlab',
				operation,
				`the label "${label}" is reserved: ${what}`,
				`Use ${command} instead of a label of that name`
			);
		if (ctx.mapper.isStatusLabel(label)) return use('task set-status', 'it carries the status of a task');
		if (typeOfLabel(label, ctx) !== undefined) return use('task set-type', 'it carries the type of a task');
		if (this.fill('meta') === 'labels' && lower.startsWith(ctx.settings.metaPrefix.toLowerCase())) {
			return use('task set-meta', 'it carries the metadata of a task');
		}
		if (lower === TOMBSTONE_LABEL) return use('task delete', 'it marks a deleted task');
		// On Premium and Ultimate a scoped label replaces the other labels of its scope: one sharing the scope of a status label would
		// silently take the status away.
		const scope = ctx.settings.scopedLabels ? scopeOf(label) : undefined;
		if (scope !== undefined) {
			const taken = Object.values(ctx.settings.statusMap).some(
				rule => rule.label !== undefined && scopeOf(rule.label) === scope
			);
			if (taken)
				return use(
					'task set-status',
					`it shares the scope "${scope}" of the status labels, which exclude each other`
				);
		}
		return undefined;
	}

	async addLabel(id: string, label: string, options?: WriteOptions): Promise<VersionedRecord> {
		const error = this.labelError('addLabel', label) ?? this.reservedLabelError('addLabel', label);
		if (error !== undefined) throw error;
		const { issue } = await this.prepare(id, options, ['labels']);
		if (!has(issue, label)) {
			this.checkLabelCount(issue.iid, [...labelNames(issue), label]);
			await this.runSteps('addLabel', issue.iid, [
				{
					description: `added the label ${label}`,
					run: async () => {
						const answer = (
							await this.send<ApiIssue>('addLabel', String(issue.iid), 'PUT', this.path(issue.iid), {
								add_labels: label,
							})
						).body;
						if (!has(answer, label)) throw this.notApplied('addLabel', issue.iid, 'the label', answer);
					},
					applied: current => has(current, label),
				},
			]);
		}
		return this.read(issue.iid);
	}

	async removeLabel(id: string, label: string, options?: WriteOptions): Promise<VersionedRecord> {
		const { issue } = await this.prepare(id, options, ['labels']);
		const held = labelNames(issue).find(name => eq(name, label));
		if (held !== undefined && !this.map.mapper.isStatusLabel(held) && typeOfLabel(held, this.map) === undefined) {
			await this.runSteps('removeLabel', issue.iid, [
				{
					description: `removed the label ${held}`,
					run: async () => {
						const answer = (
							await this.send<ApiIssue>('removeLabel', String(issue.iid), 'PUT', this.path(issue.iid), {
								remove_labels: held,
							})
						).body;
						if (has(answer, held)) throw this.notApplied('removeLabel', issue.iid, 'the removal', answer);
					},
					applied: current => !has(current, held),
				},
			]);
		}
		return this.read(issue.iid);
	}

	// ---------------------------------------------------------------- text guards

	/** Throws when GitLab would RUN something written in this text (a quick action), or when it is longer than GitLab keeps. */
	private checkText(operation: string, text: string, what: 'description' | 'comment'): void {
		const max = what === 'description' ? DESCRIPTION_MAX : COMMENT_MAX;
		if (text.length > max) {
			throw new BackendLimitError(
				'gitlab',
				`${what} length`,
				max,
				`The text has ${text.length} characters; GitLab keeps ${max} at most in a ${what}. Shorten it${what === 'description' ? ', or put the long text in a comment (task comment)' : ''}.`
			);
		}
		const line = QUICK_ACTION_LINE.exec(text);
		if (line !== null) {
			throw new BackendRejectedError(
				'gitlab',
				operation,
				`GitLab runs a line that starts with a slash and a command word as a quick action (here "${line[0].trim().slice(0, 40)}"), which would change the issue instead of being kept as text`,
				'Nothing was sent. Rephrase so that no line of the text starts with "/" (put a word before it); which escape GitLab honours is not documented, so none is promised.'
			);
		}
	}

	// ---------------------------------------------------------------- create, status

	/** What GitLab must hold for a status; a status the statusMap lacks is an UnsupportedByBackendError (a safety net: the map is checked at load). */
	private representation(operation: string, status: string): StatusRepresentation {
		if (!this.map.mapper.knows(status)) {
			throw new UnsupportedByBackendError(
				'gitlab',
				operation,
				'status',
				`The status "${status}" is not mapped to GitLab: add it to strategy.options.statusMap of the project config (state, and a label that tells it apart).`
			);
		}
		return this.map.mapper.representation(status);
	}

	private hierarchyUnsupported(operation: string): UnsupportedByBackendError {
		return new UnsupportedByBackendError(
			'gitlab',
			operation,
			'hierarchy',
			'The GitLab REST API has no parent of an issue (the issue has no such field and the API no such endpoint). The work item hierarchy exists only in GraphQL, and which issue may be the child of which on which plan is not documented, so task does not use it. Say it in the description or with a link instead (task link).'
		);
	}

	async create(input: CreateTaskInput): Promise<VersionedRecord> {
		const rep = this.representation('create', input.status);
		if (input.parentId !== undefined) throw this.hierarchyUnsupported('create');
		const text = input.description?.trim() ?? '';
		const description = text === '' || text === input.title.trim() ? undefined : input.description!;
		if (description !== undefined) this.checkText('create', description, 'description');
		const created = (
			await this.send<ApiIssue>('create', 'new task', 'POST', `${this.host.projectPath}/issues`, {
				title: input.title,
				...(description === undefined ? {} : { description }),
				...(rep.label === undefined ? {} : { labels: rep.label }),
			})
		).body;
		const iid = created.iid;
		const steps: Step[] = [];
		// GitLab has no state in the create call: a closed task is created, then closed.
		if (rep.state === 'closed') {
			steps.push({
				description: 'closed the issue',
				run: async () => {
					const answer = (
						await this.send<ApiIssue>('create', String(iid), 'PUT', this.path(iid), {
							state_event: 'close',
						})
					).body;
					if (stateOf(answer) !== 'closed') throw this.notApplied('create', iid, 'the closing', answer);
				},
				applied: current => stateOf(current) === 'closed',
				repair: `task set-status ${iid} ${input.status}`,
			});
		}
		await this.runSteps('create', iid, steps, [`created issue #${iid}`]);
		return this.read(iid);
	}

	async updateStatus(id: string, status: string, options?: WriteOptions): Promise<VersionedRecord> {
		const rep = this.representation('updateStatus', status);
		const { issue } = await this.prepare(id, options, ['status']);
		const iid = issue.iid;
		if (statusOfIssue(issue, this.map) === status) {
			throw new TaskConflictError(`Task "${iid}" is already in status "${status}"`);
		}
		const remove = labelNames(issue).filter(
			name => this.map.mapper.isStatusLabel(name) && (rep.label === undefined || !eq(name, rep.label))
		);
		const add = rep.label !== undefined && !has(issue, rep.label) ? [rep.label] : [];
		const stateChange = stateOf(issue) !== rep.state;
		const labelsChange = remove.length + add.length > 0;
		if (!stateChange && !labelsChange) return this.read(iid);
		const final = this.finalLabels(issue, remove, add);
		if (labelsChange) this.checkLabelCount(iid, final);
		const words = [
			...this.labelWords(remove, add),
			...(stateChange ? [rep.state === 'open' ? 'reopened the issue' : 'closed the issue'] : []),
		];
		const done = (current: ApiIssue): boolean =>
			(!stateChange || stateOf(current) === rep.state) && this.labelsDone(current, remove, add);
		// ONE PUT carries the state and the whole label set: no reader ever sees two status labels, nor the status of a half-done change.
		await this.runSteps('updateStatus', iid, [
			{
				description: words.join(' and '),
				run: async () => {
					const answer = (
						await this.send<ApiIssue>('updateStatus', String(iid), 'PUT', this.path(iid), {
							...(labelsChange ? { labels: final.join(',') } : {}),
							...(stateChange ? { state_event: rep.state === 'closed' ? 'close' : 'reopen' } : {}),
						})
					).body;
					if (!done(answer)) throw this.notApplied('updateStatus', iid, 'the change of status', answer);
				},
				applied: done,
				repair: `task set-status ${iid} ${status}`,
			},
		]);
		return this.read(iid);
	}

	// ---------------------------------------------------------------- text

	async setTitle(id: string, title: string, options?: WriteOptions): Promise<VersionedRecord> {
		const { issue } = await this.prepare(id, options, ['title']);
		if (issue.title !== title) {
			await this.runSteps('setTitle', issue.iid, [
				{
					description: 'renamed the issue',
					run: () => this.send('setTitle', String(issue.iid), 'PUT', this.path(issue.iid), { title }),
					applied: current => current.title === title,
				},
			]);
		}
		return this.read(issue.iid);
	}

	async setDescription(id: string, description: string, options?: WriteOptions): Promise<VersionedRecord> {
		const { issue } = await this.prepare(id, options, ['body']);
		const parts = splitBody(issue, this.map);
		// Like the local store: a description equal to the title is no description.
		const visible = description.trim() === issue.title.trim() ? '' : description;
		await this.writeBody(issue, 'setDescription', composeBody(visible, parts.blockData));
		return this.read(issue.iid);
	}

	/** One PUT of the description, skipped when it is already that text. */
	private async writeBody(issue: ApiIssue, operation: string, body: string): Promise<void> {
		this.checkText(operation, body, 'description');
		if (body === (issue.description ?? '').replace(/\r\n/g, '\n')) return;
		await this.runSteps(operation, issue.iid, [
			{
				description: 'wrote the description',
				run: () => this.send(operation, String(issue.iid), 'PUT', this.path(issue.iid), { description: body }),
				applied: current => (current.description ?? '').replace(/\r\n/g, '\n') === body,
			},
		]);
	}

	// ---------------------------------------------------------------- type

	private typeLabelsHeld(issue: ApiIssue): string[] {
		return labelNames(issue).filter(name => typeOfLabel(name, this.map) !== undefined);
	}

	/** The native issue type the issue holds when a task type is mapped to it (`incident`, `test_case`), else undefined. */
	private nativeTypeHeld(issue: ApiIssue): string | undefined {
		const native = issue.issue_type;
		if (native === undefined) return undefined;
		return Object.values(this.map.settings.typeMap).some(rule => rule.issueType === native) ? native : undefined;
	}

	async setType(id: string, type: string, options?: WriteOptions): Promise<VersionedRecord> {
		const { typeMap, typePrefix } = this.map.settings;
		const rule = Object.hasOwn(typeMap, type) ? typeMap[type] : undefined;
		const wanted = rule?.issueType;
		const label = wanted !== undefined ? undefined : (rule?.label ?? `${typePrefix}${type}`);
		if (label !== undefined) {
			const problem = labelProblem(label);
			if (problem !== undefined) {
				throw new BackendRejectedError(
					'gitlab',
					'setType',
					`The type "${type}" needs the label ${problem}`,
					'Give the type another name, set strategy.options.typePrefix to another prefix, or map it in strategy.options.typeMap.'
				);
			}
		}
		const { issue } = await this.prepare(id, options, ['type']);
		if (typeOf(issue, this.map) === type) return this.read(issue.iid);
		const oldNative = this.nativeTypeHeld(issue);
		const nativeTarget = wanted ?? (oldNative !== undefined ? 'issue' : undefined);
		const steps = this.labelSetStep({
			operation: 'setType',
			issue,
			remove: this.typeLabelsHeld(issue).filter(held => label === undefined || !eq(held, label)),
			add: label !== undefined && !has(issue, label) ? [label] : [],
			...(nativeTarget !== undefined && issue.issue_type !== nativeTarget
				? {
						extra: { issue_type: nativeTarget },
						extraDone: (current: ApiIssue) => current.issue_type === nativeTarget,
						extraWords: `set the issue type ${nativeTarget}`,
					}
				: {}),
		});
		await this.runSteps('setType', issue.iid, steps);
		return this.read(issue.iid);
	}

	async clearType(id: string, options?: WriteOptions): Promise<VersionedRecord> {
		const { issue } = await this.prepare(id, options, ['type']);
		const hasNative = this.nativeTypeHeld(issue) !== undefined;
		const steps = this.labelSetStep({
			operation: 'clearType',
			issue,
			remove: this.typeLabelsHeld(issue),
			add: [],
			...(hasNative
				? {
						extra: { issue_type: 'issue' },
						extraDone: (current: ApiIssue) => current.issue_type === 'issue',
						extraWords: 'set the issue type issue',
					}
				: {}),
		});
		await this.runSteps('clearType', issue.iid, steps);
		return this.read(issue.iid);
	}

	// ---------------------------------------------------------------- meta

	private metaUnsupported(operation: string): UnsupportedByBackendError {
		return new UnsupportedByBackendError(
			'gitlab',
			operation,
			'meta',
			`A GitLab issue has no metadata. Declare where task keeps it, in strategy.options.fills of the project config: "meta: labels" (one label per key: ${this.map.settings.scopedLabels ? `${this.map.settings.metaPrefix}<key>::<value>, a scoped label` : `${this.map.settings.metaPrefix}<key>=<value>`}; exact) or "meta: { use: body-block, fidelity: degrade }" (a hidden block in the description, approximate: someone editing the description on GitLab can overwrite it).`
		);
	}

	private metaLabelsOfKey(issue: ApiIssue, key: string): string[] {
		return labelNames(issue).filter(name => parseMetaLabel(name, this.map, issue.iid)?.key === key);
	}

	async setMeta(id: string, key: string, value: string, options?: WriteOptions): Promise<VersionedRecord> {
		const mode = this.fill('meta');
		if (mode !== 'labels' && mode !== 'body-block') throw this.metaUnsupported('setMeta');
		if (mode === 'labels') {
			const problem = metaLabelProblem(key, value, this.map);
			if (problem !== undefined) {
				throw new BackendRejectedError(
					'gitlab',
					'setMeta',
					`the meta ${key} cannot be a label: ${problem}`,
					'Declare "meta: body-block" in strategy.options.fills, which accepts any text'
				);
			}
			const bad = labelProblem(metaLabelName(key, value, this.map));
			if (bad !== undefined) {
				throw new BackendRejectedError(
					'gitlab',
					'setMeta',
					`the meta ${key} cannot be a label: ${bad}`,
					'Declare "meta: body-block" in strategy.options.fills, which accepts any text'
				);
			}
		}
		const { issue } = await this.prepare(id, options, ['meta']);
		const iid = issue.iid;
		const currentMeta = metaOf(issue, this.map);
		if (currentMeta !== undefined && Object.hasOwn(currentMeta, key) && currentMeta[key] === value) {
			return this.read(iid);
		}
		if (mode === 'labels') {
			const label = metaLabelName(key, value, this.map);
			const steps = this.labelSetStep({
				operation: 'setMeta',
				issue,
				remove: this.metaLabelsOfKey(issue, key),
				add: [label],
			});
			await this.runSteps('setMeta', iid, steps);
		} else {
			const parts = splitBody(issue, this.map);
			const meta = { ...(parts.blockMeta ?? {}), [key]: value };
			await this.writeBody(
				issue,
				'setMeta',
				composeBody(parts.visibleText, { ...(parts.blockData ?? {}), meta })
			);
			this.emulated(
				'meta is emulated: it is kept in a hidden block of the description of the issues (fills.meta: body-block, accepted with fidelity: degrade); editing the description on GitLab can overwrite it'
			);
		}
		return this.read(iid);
	}

	async removeMeta(id: string, key: string, options?: WriteOptions): Promise<VersionedRecord> {
		const mode = this.fill('meta');
		if (mode !== 'labels' && mode !== 'body-block') throw this.metaUnsupported('removeMeta');
		const { issue } = await this.prepare(id, options, ['meta']);
		const iid = issue.iid;
		if (!Object.hasOwn(metaOf(issue, this.map) ?? {}, key)) return this.read(iid);
		if (mode === 'labels') {
			const steps = this.labelSetStep({
				operation: 'removeMeta',
				issue,
				remove: this.metaLabelsOfKey(issue, key),
				add: [],
			});
			await this.runSteps('removeMeta', iid, steps);
		} else {
			const parts = splitBody(issue, this.map);
			const meta = { ...(parts.blockMeta ?? {}) };
			delete meta[key];
			const data: Record<string, unknown> = { ...(parts.blockData ?? {}) };
			if (Object.keys(meta).length === 0) delete data['meta'];
			else data['meta'] = meta;
			await this.writeBody(issue, 'removeMeta', composeBody(parts.visibleText, data));
			this.emulated(
				'meta is emulated: it is kept in a hidden block of the description of the issues (fills.meta: body-block, accepted with fidelity: degrade); editing the description on GitLab can overwrite it'
			);
		}
		return this.read(iid);
	}

	// ---------------------------------------------------------------- hierarchy

	async setParent(_id: string, _parentId: string, _options?: WriteOptions): Promise<VersionedRecord> {
		await Promise.resolve();
		throw this.hierarchyUnsupported('setParent');
	}

	async removeParent(_id: string, _options?: WriteOptions): Promise<VersionedRecord> {
		await Promise.resolve();
		throw this.hierarchyUnsupported('removeParent');
	}

	// ---------------------------------------------------------------- links

	private requireLinkType(type: string): LinkType {
		if (!(LINK_TYPES as readonly string[]).includes(type)) {
			throw new Error(`Unknown link type "${type}". Valid types: ${LINK_TYPES.join(', ')}`);
		}
		return type as LinkType;
	}

	private blockedByUnsupported(operation: string): UnsupportedByBackendError {
		return new UnsupportedByBackendError(
			'gitlab',
			operation,
			'linkTypes',
			'The links "blocks" / "is blocked by" of GitLab exist on the Premium and Ultimate plans only (docs.gitlab.com/user/project/issues/related_issues). If this instance has one of those plans, set strategy.options.tier to premium or ultimate in the project config; otherwise say it in a comment (task comment).'
		);
	}

	private blockLinkUnsupported(type: 'duplicateOf' | 'causedBy', operation: string): UnsupportedByBackendError {
		return new UnsupportedByBackendError(
			'gitlab',
			operation,
			'linkTypes',
			`GitLab has no "${type}" relation. To store it, declare in strategy.options.fills of the project config: "linkTypes.${type}: { use: relate-block, fidelity: degrade }" -- task then writes the link in a hidden block of the issue description and adds a plain "relates to" link, which GitLab shows (approximate: the type lives in the block only).`
		);
	}

	async addLink(id: string, type: LinkType, targetId: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.requireLinkType(type);
		if (type === 'duplicateOf' || type === 'causedBy') return this.addBlockLink(type, id, targetId, options);
		if (this.map.settings.tier === 'free') throw this.blockedByUnsupported('addLink');
		const { issue } = await this.prepare(id, options, []);
		const source = String(issue.iid);
		const target = (await this.targetOf(issue, targetId, source)).issue;
		const linked = await this.host.linked(issue);
		const existing = linked.find(item => item.iid === target.iid);
		if (existing !== undefined) {
			if (existing.link_type === 'is_blocked_by') {
				throw new TaskConflictError(`Task "${source}" is already blockedBy "${target.iid}"`);
			}
			if (existing.link_type === 'blocks') {
				// The source already blocks the target: making it wait for the target too is the shortest cycle.
				throw new TaskConflictError(
					`Cannot link "${source}" blockedBy "${target.iid}": it would create a cycle (${source} -> ${target.iid} -> ${source})`
				);
			}
			throw new TaskConflictError(
				`Task "${source}" is already linked to "${target.iid}" (${existing.link_type.replace(/_/g, ' ')}); GitLab keeps one link between two issues (UNVERIFIED, the fake models it). Remove it first (task unlink)`
			);
		}
		await this.checkBlockerCycle(issue, target, source);
		await this.runSteps('addLink', issue.iid, [
			{
				description: `added the link "is blocked by" #${target.iid}`,
				run: async () => {
					try {
						await this.send('addLink', source, 'POST', this.path(issue.iid, '/links'), {
							target_project_id: issue.project_id,
							target_issue_iid: target.iid,
							link_type: 'is_blocked_by',
						});
					} catch (error) {
						if (error instanceof BackendAuthError && error.reason === 'forbidden') {
							throw new BackendAuthError(
								'gitlab',
								'forbidden',
								`${error.message}; the "blocks" / "is blocked by" links need GitLab Premium or Ultimate (strategy.options.tier is ${this.map.settings.tier})`,
								`If this instance is on the Free plan set strategy.options.tier: free (blockedBy is then refused); otherwise the user of the token must be allowed to update both issues. ${error.hint}`
							);
						}
						throw error;
					}
				},
				applied: async current =>
					(await this.host.linked(current)).some(
						item => item.iid === target.iid && item.link_type === 'is_blocked_by'
					),
			},
		]);
		return this.read(issue.iid);
	}

	/** The blockers of `target` (and theirs) must not reach `source`: that would make the two wait for each other. */
	private async checkBlockerCycle(source: ApiIssue, target: ApiIssue, sourceId: string): Promise<void> {
		const seen = new Set<number>([target.iid]);
		const queue: ApiLinkedIssue[] = [{ ...target } as ApiLinkedIssue];
		const parentOf = new Map<number, number>();
		while (queue.length > 0 && seen.size <= 200) {
			const current = queue.shift()!;
			for (const blocker of (await this.host.linked(current)).filter(
				item => item.link_type === 'is_blocked_by'
			)) {
				if (blocker.iid === source.iid) {
					const path = [sourceId, String(target.iid)];
					for (let at = current.iid; at !== target.iid; at = parentOf.get(at)!) path.push(String(at));
					path.push(sourceId);
					throw new TaskConflictError(
						`Cannot link "${sourceId}" blockedBy "${target.iid}": it would create a cycle (${path.join(' -> ')})`
					);
				}
				if (seen.has(blocker.iid)) continue;
				seen.add(blocker.iid);
				parentOf.set(blocker.iid, current.iid);
				queue.push(blocker);
			}
		}
	}

	private async targetOf(issue: ApiIssue, targetId: string, source: string): Promise<{ issue: ApiIssue }> {
		const loaded = await this.host.loadIssue(targetId, { revalidate: false });
		if (loaded.issue.iid === issue.iid) throw new TaskConflictError(`Task "${source}" cannot be linked to itself`);
		return loaded;
	}

	async removeLink(id: string, type: LinkType, targetId: string, options?: WriteOptions): Promise<VersionedRecord> {
		this.requireLinkType(type);
		if (type === 'duplicateOf' || type === 'causedBy') return this.removeBlockLink(type, id, targetId, options);
		if (this.map.settings.tier === 'free') throw this.blockedByUnsupported('removeLink');
		const { issue } = await this.prepare(id, options, []);
		const source = String(issue.iid);
		const wanted = Number(targetId.replace('#', ''));
		const linked = await this.host.linked(issue);
		const item = linked.find(candidate => candidate.iid === wanted && candidate.link_type === 'is_blocked_by');
		if (item === undefined) throw new TaskConflictError(`Task "${source}" is not blockedBy "${targetId}"`);
		await this.runSteps('removeLink', issue.iid, [
			{
				description: `removed the link "is blocked by" #${item.iid}`,
				run: () =>
					this.sendTolerant(
						'removeLink',
						source,
						'DELETE',
						this.path(issue.iid, `/links/${item.issue_link_id}`)
					),
				applied: async current =>
					!(await this.host.linked(current)).some(
						candidate => candidate.iid === item.iid && candidate.link_type === 'is_blocked_by'
					),
			},
		]);
		return this.read(issue.iid);
	}

	// ---- duplicateOf and causedBy (fill: relate-block)

	private requireBlockFill(type: 'duplicateOf' | 'causedBy', operation: string): void {
		if (this.fill(`linkTypes.${type}`) !== 'relate-block') throw this.blockLinkUnsupported(type, operation);
	}

	private linksOfBlock(data: Record<string, unknown> | undefined): Array<{ type?: unknown; target?: unknown }> {
		return Array.isArray(data?.['links']) ? (data['links'] as Array<{ type?: unknown; target?: unknown }>) : [];
	}

	/** The targets the block links of an issue name, of one type; an unreadable block counts as none (it is reported when read). */
	private blockTargets(issue: ApiIssue, type: 'duplicateOf' | 'causedBy'): string[] {
		try {
			return splitBody(issue, this.map)
				.blockLinks.filter(link => link.type === type)
				.map(link => link.target);
		} catch (error) {
			if (error instanceof BackendDataError) return [];
			throw error;
		}
	}

	private async addBlockLink(
		type: 'duplicateOf' | 'causedBy',
		id: string,
		targetId: string,
		options?: WriteOptions
	): Promise<VersionedRecord> {
		this.requireBlockFill(type, 'addLink');
		const { issue } = await this.prepare(id, options, ['body']);
		const source = String(issue.iid);
		const target = (await this.targetOf(issue, targetId, source)).issue;
		const targetRef = String(target.iid);
		const parts = splitBody(issue, this.map);
		const held = parts.blockLinks.filter(link => link.type === type).map(link => link.target);
		if (held.includes(targetRef)) throw new TaskConflictError(`Task "${source}" is already ${type} "${targetRef}"`);
		if (type === 'duplicateOf' && held.length > 0) {
			throw new TaskConflictError(
				`Task "${source}" is already a duplicateOf of "${held[0]}". Run: task unlink ${source} duplicateOf ${held[0]} first`
			);
		}
		// A cycle: following the same kind of link from the target must not come back to the source.
		const { issues } = await this.host.issuesAll();
		const byIid = new Map(issues.map(other => [String(other.iid), other]));
		const path = [source, targetRef];
		const visited = new Set<string>([targetRef]);
		const pending = [targetRef];
		while (pending.length > 0) {
			const at = pending.pop()!;
			const node = at === targetRef ? target : byIid.get(at);
			if (node === undefined) continue;
			for (const next of this.blockTargets(node, type)) {
				if (next === source) {
					throw new TaskConflictError(
						`Cannot link "${source}" ${type} "${targetRef}": it would create a cycle (${[
							...path,
							at === targetRef ? undefined : at,
							source,
						]
							.filter((part): part is string => part !== undefined)
							.join(' -> ')})`
					);
				}
				if (!visited.has(next)) {
					visited.add(next);
					pending.push(next);
				}
			}
		}
		const links = [...this.linksOfBlock(parts.blockData), { type, target: targetRef }];
		const body = composeBody(parts.visibleText, { ...(parts.blockData ?? {}), links });
		this.checkText('addLink', body, 'description');
		const repair = `task link ${source} ${type} ${targetRef}`;
		const related = (await this.host.linked(issue)).some(item => item.iid === target.iid);
		const steps: Step[] = [
			{
				description: `wrote the ${type} entry in the description`,
				run: () => this.send('addLink', source, 'PUT', this.path(issue.iid), { description: body }),
				applied: current => this.blockTargets(current, type).includes(targetRef),
				repair,
			},
		];
		if (!related) {
			steps.push({
				description: `added the link "relates to" #${targetRef}`,
				run: () =>
					this.send('addLink', source, 'POST', this.path(issue.iid, '/links'), {
						target_project_id: issue.project_id,
						target_issue_iid: target.iid,
						link_type: 'relates_to',
					}),
				applied: async current => (await this.host.linked(current)).some(item => item.iid === target.iid),
				repair,
			});
		}
		await this.runSteps('addLink', issue.iid, steps);
		this.emulated(
			`${type} is emulated: the link is kept in a hidden block of the issue description and shown on GitLab as "relates to" (fills.linkTypes.${type}: relate-block, accepted with fidelity: degrade); editing the description on GitLab can overwrite it`
		);
		return this.read(issue.iid);
	}

	private async removeBlockLink(
		type: 'duplicateOf' | 'causedBy',
		id: string,
		targetId: string,
		options?: WriteOptions
	): Promise<VersionedRecord> {
		this.requireBlockFill(type, 'removeLink');
		const { issue } = await this.prepare(id, options, ['body']);
		const source = String(issue.iid);
		const targetRef = targetId.replace('#', '');
		const parts = splitBody(issue, this.map);
		if (!parts.blockLinks.some(link => link.type === type && link.target === targetRef)) {
			throw new TaskConflictError(`Task "${source}" is not ${type} "${targetId}"`);
		}
		const links = this.linksOfBlock(parts.blockData).filter(
			link => !(link?.type === type && String(link.target) === targetRef)
		);
		const data: Record<string, unknown> = { ...(parts.blockData ?? {}) };
		if (links.length === 0) delete data['links'];
		else data['links'] = links;
		const body = composeBody(parts.visibleText, data);
		this.checkText('removeLink', body, 'description');
		const repair = `task unlink ${source} ${type} ${targetRef}`;
		const steps: Step[] = [
			{
				description: `removed the ${type} entry from the description`,
				run: () => this.send('removeLink', source, 'PUT', this.path(issue.iid), { description: body }),
				applied: current => !this.blockTargets(current, type).includes(targetRef),
				repair,
			},
		];
		// The plain "relates to" link was added with the entry: it goes too, unless another entry (of this issue, or of the other
		// one pointing back) still needs it.
		let target: ApiIssue | undefined;
		try {
			target = (await this.host.loadIssue(targetRef, { revalidate: false })).issue;
		} catch (error) {
			if (!(error instanceof TaskNotFoundError)) throw error;
		}
		const needed =
			parts.blockLinks.some(
				link => !(link.type === type && link.target === targetRef) && link.target === targetRef
			) ||
			(target !== undefined &&
				(['duplicateOf', 'causedBy'] as const).some(kind => this.blockTargets(target, kind).includes(source)));
		const relation =
			target === undefined || needed
				? undefined
				: (await this.host.linked(issue)).find(
						item => item.iid === target.iid && item.link_type === 'relates_to'
					);
		if (relation !== undefined) {
			steps.push({
				description: `removed the link "relates to" #${targetRef}`,
				run: () =>
					this.sendTolerant(
						'removeLink',
						source,
						'DELETE',
						this.path(issue.iid, `/links/${relation.issue_link_id}`)
					),
				applied: async current =>
					!(await this.host.linked(current)).some(
						item => item.iid === relation.iid && item.link_type === 'relates_to'
					),
				repair,
			});
		}
		await this.runSteps('removeLink', issue.iid, steps);
		return this.read(issue.iid);
	}

	// ---------------------------------------------------------------- comments

	private async userNotes(issue: ApiIssue): Promise<ApiNote[]> {
		const all = await this.host.client.getAll<ApiNote>(this.path(issue.iid, '/notes'), {
			query: {
				per_page: this.host.settings.pageSize,
				activity_filter: 'only_comments',
				sort: 'asc',
				order_by: 'created_at',
			},
			revalidate: true,
		});
		return all.items.filter(note => !note.system);
	}

	private async findNote(issue: ApiIssue, commentId: string): Promise<ApiNote> {
		const notes = await this.userNotes(issue);
		const found = notes.find(note => String(note.id) === commentId);
		if (found === undefined) {
			throw new CommentNotFoundError(
				String(issue.iid),
				commentId,
				notes.map(note => String(note.id))
			);
		}
		return found;
	}

	async addComment(
		id: string,
		text: string,
		options?: WriteOptions & { author?: string }
	): Promise<BackendCommentChange> {
		if (options?.author !== undefined) {
			throw new UnsupportedByBackendError(
				'gitlab',
				'addComment',
				'comments',
				'GitLab writes the comment as the user of the token, so an author cannot be chosen: leave out --author (or "author" in the request).'
			);
		}
		const clean = normalizeCommentText(text);
		this.checkText('addComment', clean, 'comment');
		const { issue } = await this.prepare(id, options, []);
		const created = (
			await this.send<ApiNote>('addComment', String(issue.iid), 'POST', this.path(issue.iid, '/notes'), {
				body: clean,
			})
		).body;
		return { task: await this.read(issue.iid), comment: commentsOf([created])[0]! };
	}

	async editComment(
		id: string,
		commentId: string,
		text: string,
		options?: WriteOptions
	): Promise<BackendCommentEdit> {
		const clean = normalizeCommentText(text);
		this.checkText('editComment', clean, 'comment');
		const { issue } = await this.prepare(id, options, []);
		const before = await this.findNote(issue, commentId);
		if (before.body === clean) {
			return {
				task: await this.read(issue.iid),
				comment: commentsOf([before])[0]!,
				oldText: before.body,
				changed: false,
			};
		}
		const edited = (
			await this.send<ApiNote>(
				'editComment',
				String(issue.iid),
				'PUT',
				this.path(issue.iid, `/notes/${before.id}`),
				{
					body: clean,
				}
			)
		).body;
		return {
			task: await this.read(issue.iid),
			comment: commentsOf([edited])[0]!,
			oldText: before.body,
			changed: true,
		};
	}

	async removeComment(id: string, commentId: string, options?: WriteOptions): Promise<BackendCommentChange> {
		const { issue } = await this.prepare(id, options, []);
		const before = await this.findNote(issue, commentId);
		await this.sendTolerant(
			'removeComment',
			String(issue.iid),
			'DELETE',
			this.path(issue.iid, `/notes/${before.id}`)
		);
		return { task: await this.read(issue.iid), comment: commentsOf([before])[0]! };
	}

	// ---------------------------------------------------------------- delete

	private deleteUnsupported(): UnsupportedByBackendError {
		return new UnsupportedByBackendError(
			'gitlab',
			'deleteTask',
			'delete',
			'Deleting an issue needs the Planner or Owner role (or being its author since GitLab 18.10) and is not done unless the project asks for it. Declare a fill in strategy.options.fills of the project config: "delete: hard" (REST DELETE of the issue; exact) or "delete: tombstone" with fidelity: degrade (the issue is closed, labelled task:deleted and hidden from task; it stays on GitLab; approximate). Or close it instead: task set-status <id> <terminal status>.'
		);
	}

	async deleteTask(id: string, options?: WriteOptions): Promise<boolean> {
		const mode = this.fill('delete');
		if (mode !== 'tombstone' && mode !== 'hard') throw this.deleteUnsupported();
		let issue: ApiIssue;
		try {
			({ issue } = await this.prepare(id, options, ['title', 'body', 'status', 'type', 'labels', 'meta']));
		} catch (error) {
			if (error instanceof TaskNotFoundError) return false;
			throw error;
		}
		// Already deleted (a tombstone) is gone, as for a task that does not exist.
		if (mode === 'tombstone' && isTombstone(issue)) return false;
		return mode === 'hard' ? this.deleteHard(issue) : this.deleteTombstone(issue);
	}

	private async deleteHard(issue: ApiIssue): Promise<boolean> {
		const iid = issue.iid;
		try {
			await this.send('deleteTask', String(iid), 'DELETE', this.path(iid));
		} catch (error) {
			if (error instanceof TaskNotFoundError) return false;
			if (error instanceof BackendAuthError && error.reason === 'forbidden') {
				throw new BackendAuthError(
					'gitlab',
					'forbidden',
					`GitLab refused to delete issue #${iid}: ${error.message}`,
					'Deleting an issue needs the Planner or Owner role on the project (or being the author of the issue since GitLab 18.10). Use a token of such a user, or declare "delete: tombstone" with fidelity: degrade in strategy.options.fills instead (the issue is closed and hidden, not deleted).'
				);
			}
			throw error;
		}
		try {
			await this.host.loadIssue(String(iid), { revalidate: true });
		} catch (error) {
			if (error instanceof TaskNotFoundError) return true;
			throw error;
		}
		throw new BackendDataError(
			'gitlab',
			`issue #${iid}`,
			`GitLab said issue #${iid} was deleted, but it is still there`,
			`Look at ${this.host.issueUrl(iid)}`
		);
	}

	private async deleteTombstone(issue: ApiIssue): Promise<boolean> {
		const iid = issue.iid;
		const closing = stateOf(issue) !== 'closed';
		// ONE PUT closes and hides the issue: until it lands the issue is a task like any other, and the command can be run again.
		this.checkLabelCount(iid, [...labelNames(issue), TOMBSTONE_LABEL]);
		await this.runSteps('deleteTask', iid, [
			{
				description: `${closing ? 'closed the issue and ' : ''}labelled it ${TOMBSTONE_LABEL}`,
				run: async () => {
					const answer = (
						await this.send<ApiIssue>('deleteTask', String(iid), 'PUT', this.path(iid), {
							...(closing ? { state_event: 'close' } : {}),
							add_labels: TOMBSTONE_LABEL,
						})
					).body;
					if (!isTombstone(answer) || stateOf(answer) !== 'closed') {
						throw this.notApplied('deleteTask', iid, 'the deletion', answer);
					}
				},
				applied: current => isTombstone(current) && stateOf(current) === 'closed',
				repair: `task delete ${iid}`,
			},
		]);
		this.emulated(
			`delete is emulated: issue #${iid} was closed and labelled ${TOMBSTONE_LABEL}; it is hidden from task but still on GitLab, and its number stays used (fills.delete: tombstone, accepted with fidelity: degrade)`
		);
		return true;
	}
}
