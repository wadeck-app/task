// Where the priority of THIS project lives on GitHub, resolved once per backend instance (design D11 of .claude/session/decisions.md):
//   priorityStorage: label  -> labels, no request
//   priorityFieldId set     -> the native issue field with that id, no request (the options are not known: GitHub judges a value)
//   priorityStorage: field  -> the field named priorityFieldName among the organization definitions; unreadable = a loud error
//   priorityStorage: auto   -> the same lookup; definitions refused (403), absent (404) or without such a field -> labels, said
//                              by `task strategy check` with the reason and the fix, never silently
// The definitions are `GET /orgs/{owner}/issue-fields` and need the ORGANIZATION permission `issue_fields=read` (measured 2026-11-14:
// a token with only Issues read/write gets a 403 naming `issue_fields=read`; /repos and /users routes are 404). Their REST shape
// was NOT observed: the code reads the shape of the MCP `list_issue_fields` (id, full_database_id, name, data_type, options[].name)
// and says so when it finds something else.
//
// Reads never wait for this question (`forRead`): the explicit settings, then what an earlier command remembered at any age, then a
// priority label as the sign that it is worth asking; a failure to ask reads as label storage, with a notice. Only a priority WRITE and
// `strategy check` fail on it. The API version of the issue fields goes only on the requests that need it (FIELDS_API_VERSION), asked
// by the caller per request; what an older version returns is NOT known.
import { BackendAuthError, BackendRejectedError } from '@wadeck-app/task-core';

import type { GitHubClient } from './githubClient.js';
import type { PrioritySettings } from './githubOptions.js';
import { explicitStorage } from './githubPriority.js';
import type { PriorityContext } from './githubPriority.js';
import type { ReadNotice } from '../kinds.js';
import type { ResponseCache } from './responseCache.js';

/** The API version the issue field routes and values were measured with. */
export const FIELDS_API_VERSION = '2026-03-10';

/** How the definitions were asked, for `strategy check`. */
export type DefinitionsOutcome =
	| { kind: 'not-read'; why: string }
	| { kind: 'read'; fields: number }
	| { kind: 'forbidden'; accepted: string | undefined }
	| { kind: 'not-found' }
	| { kind: 'unreadable'; why: string };

export interface PriorityResolution {
	storage: 'field' | 'label';
	/** The field used (`field` only). */
	field?: { id: number; name: string; options?: string[] };
	/** One sentence: why this storage. */
	reason: string;
	/** What to do to get the field, when the resolution fell back to labels. */
	fix?: string;
	/** Why the field is not usable, when the resolution fell back to labels (the sentence of the `fix` is its remedy). */
	why?: string;
	definitions: DefinitionsOutcome;
}

interface ApiFieldDefinition {
	id?: unknown;
	full_database_id?: unknown;
	name?: unknown;
	data_type?: unknown;
	options?: unknown;
}

const PERMISSION_FIX =
	'give the token the ORGANIZATION permission "Issue fields: Read" (GitHub names it issue_fields=read in x-accepted-github-permissions; how the token page prints it is UNVERIFIED), or set strategy.options.priorityFieldId to the numeric id of the field (full_database_id), or choose priorityStorage: label to stop asking';

/**
 * How long a resolution that needed a request is remembered in the cache folder of the project, shared by the processes (a command is
 * a process: without it every command of an `auto` project would pay the request that finds out). `strategy check` never uses it.
 */
export const RESOLUTION_MEMORY_MS = 10 * 60_000;

export class PriorityResolver {
	private pending: Promise<PriorityResolution> | undefined;
	private done: PriorityResolution | undefined;
	/** The failure of the question made for a read, kept so that a process asks once. */
	private readFailure: Error | undefined;

	constructor(
		private readonly init: {
			client: GitHubClient;
			settings: PrioritySettings;
			owner: string;
			/** The address of the API: part of what a remembered answer is about. */
			baseUrl: string;
			/** The context the readers use: its `storage` follows the resolution. */
			context: PriorityContext;
			/** Where a resolution that needed a request is remembered; absent: it is asked again by every process. */
			cache?: ResponseCache;
			/** Where a notice for the person goes (the read notices of the backend). */
			notice?: (notice: ReadNotice) => void;
			now?: () => number;
		}
	) {}

	/** The resolution, when it was made in this process. */
	current(): PriorityResolution | undefined {
		return this.done;
	}

	/** True when the settings say where the priority lives (a field id, `label`, `field`): nothing is remembered or asked for them. */
	private explicit(): boolean {
		return explicitStorage(this.init.settings) !== undefined;
	}

	/**
	 * Where the priority lives, WITHOUT a request: the resolution of this process, the explicit settings, then what an earlier command
	 * remembered (any age). Sets the storage of the context. Undefined: `auto`, nothing known.
	 */
	known(): 'field' | 'label' | undefined {
		const storage =
			this.done?.storage ?? explicitStorage(this.init.settings) ?? this.memory()?.storage ?? this.failedStorage();
		if (storage !== undefined) this.init.context.storage = storage;
		return storage;
	}

	private failedStorage(): 'label' | undefined {
		return this.readFailure === undefined ? undefined : 'label';
	}

	/**
	 * The storage for a READ that has seen a sign of a priority (a priority label) while nothing is known: asks, and when asking fails
	 * the read goes on with label storage and says why. One attempt per process.
	 */
	async forRead(): Promise<'field' | 'label'> {
		const known = this.known();
		if (known !== undefined) return known;
		try {
			return (await this.resolve()).storage;
		} catch (error) {
			this.readFailure = error instanceof Error ? error : new Error(String(error));
			this.init.context.storage = 'label';
			this.init.notice?.({
				kind: 'ignored',
				text: `priority storage could not be resolved (${this.readFailure.message}); the priority is read from the labels ${this.init.settings.prefix}<name> for now. Run task strategy check for the cause`,
			});
			return 'label';
		}
	}

	/**
	 * The resolution (asked once; a failure to ask is not remembered, the next call asks again): for a priority WRITE and `strategy
	 * check`, which fail loudly. `fresh`: ignore what another process remembered and ask GitHub (`strategy check`).
	 */
	resolve(options: { fresh?: boolean } = {}): Promise<PriorityResolution> {
		if (this.done !== undefined) return Promise.resolve(this.done);
		this.pending ??= this.remembered(options.fresh === true).then(
			resolution => {
				this.done = resolution;
				this.readFailure = undefined;
				this.init.context.storage = resolution.storage;
				return resolution;
			},
			(error: unknown) => {
				this.pending = undefined;
				throw error;
			}
		);
		return this.pending;
	}

	/**
	 * The words of the warning of a priority write that went to a LABEL although the project did not ask for labels: the field is not
	 * usable. Undefined when labels were the choice, or the field is used.
	 */
	fallbackWarning(resolution: PriorityResolution, label?: string): string | undefined {
		if (resolution.storage !== 'label' || resolution.fix === undefined) return undefined;
		const named = label ?? `${this.init.settings.prefix}<name>`;
		return `priority stored as label ${named} because the native issue field is not usable: ${resolution.why ?? resolution.reason}. Fix: ${resolution.fix}`;
	}

	/** What a decision depends on: the memory is about THIS repository owner, address, storage, field id and field name. */
	private memoryKey(): string {
		const { settings, owner, baseUrl } = this.init;
		return `task:priority-resolution:${baseUrl}:${owner}:${settings.storage}:${settings.fieldId ?? '-'}:${settings.fieldName}`;
	}

	/** What an earlier command remembered, of any age (a read), for the `auto` case that had to ask. */
	private memory(): PriorityResolution | undefined {
		const { cache } = this.init;
		if (cache === undefined || this.explicit()) return undefined;
		const entry = cache.get(this.memoryKey());
		return entry === undefined ? undefined : (entry.body as PriorityResolution);
	}

	/** What another process remembered recently (a write), else a decision; a decision made by request is remembered (`auto` only). */
	private async remembered(fresh: boolean): Promise<PriorityResolution> {
		const { cache } = this.init;
		const now = this.init.now ?? Date.now;
		const memorable = cache !== undefined && !this.explicit();
		if (memorable && !fresh) {
			const entry = cache.get(this.memoryKey());
			if (entry !== undefined && now() - Date.parse(entry.cachedAt) < RESOLUTION_MEMORY_MS) {
				return entry.body as PriorityResolution;
			}
		}
		const resolution = await this.decide();
		if (memorable && resolution.definitions.kind !== 'not-read') {
			cache.put({
				url: this.memoryKey(),
				etag: 'task-priority-resolution',
				cachedAt: new Date(now()).toISOString(),
				body: resolution,
			});
		}
		return resolution;
	}

	private async decide(): Promise<PriorityResolution> {
		const { settings } = this.init;
		if (settings.storage === 'label') {
			return {
				storage: 'label',
				reason: 'priorityStorage: label, the definitions of the issue fields are not read',
				definitions: { kind: 'not-read', why: 'priorityStorage: label' },
			};
		}
		if (settings.fieldId !== undefined) {
			return {
				storage: 'field',
				field: { id: settings.fieldId, name: settings.fieldName },
				reason: `priorityFieldId ${settings.fieldId} is set: the issue field is used, its options are not read (GitHub judges a value)`,
				definitions: { kind: 'not-read', why: 'priorityFieldId is set' },
			};
		}
		const definitions = await this.readDefinitions();
		if (definitions.fields !== undefined) {
			const found = definitions.fields.find(
				field => field.name.toLowerCase() === settings.fieldName.toLowerCase()
			);
			if (found !== undefined) {
				return {
					storage: 'field',
					field: { id: found.id, name: found.name, options: found.options },
					reason: `the organization defines the single-select issue field "${found.name}" (id ${found.id}, options: ${found.options.join(', ')})`,
					definitions: definitions.outcome,
				};
			}
			return this.fallback(
				`the organization has no single-select issue field named "${settings.fieldName}" (it has: ${
					definitions.fields.map(field => field.name).join(', ') || 'none'
				})`,
				`create the field "${settings.fieldName}" (single select) in the organization, or set strategy.options.priorityFieldName to one of those fields`,
				definitions.outcome
			);
		}
		return this.fallback(definitions.why, PERMISSION_FIX, definitions.outcome);
	}

	/** `auto` falls back to labels; `field` was asked for explicitly and fails with the fix. */
	private fallback(why: string, fix: string, outcome: DefinitionsOutcome): PriorityResolution {
		const { settings } = this.init;
		if (settings.storage === 'field') {
			throw new BackendRejectedError(
				'github',
				'priority',
				`priorityStorage: field needs the issue field "${settings.fieldName}", and ${why}`,
				`Fix: ${fix}.`
			);
		}
		return {
			storage: 'label',
			reason: `issue fields are not usable (${why}); the label ${settings.prefix}<priority> is used`,
			why,
			fix,
			definitions: outcome,
		};
	}

	private async readDefinitions(): Promise<
		| { fields: Array<{ id: number; name: string; options: string[] }>; outcome: DefinitionsOutcome; why?: never }
		| { fields?: never; outcome: DefinitionsOutcome; why: string }
	> {
		const path = `/orgs/${this.init.owner}/issue-fields`;
		let answer;
		try {
			answer = await this.init.client.get<unknown>(path, {
				allowNotFound: true,
				cache: false,
				apiVersion: FIELDS_API_VERSION,
			});
		} catch (error) {
			if (error instanceof BackendAuthError && error.reason === 'forbidden') {
				const accepted = /issue_fields=\w+/.exec(error.hint)?.[0];
				return {
					outcome: { kind: 'forbidden', accepted },
					why: `GitHub refused GET ${path} (403${accepted === undefined ? '' : `, it names ${accepted}`}): the token lacks the organization permission "Issue fields: Read"`,
				};
			}
			throw error;
		}
		if (answer.status === 404) {
			return {
				outcome: { kind: 'not-found' },
				why: `GitHub answered 404 for GET ${path}: ${this.init.owner} is not an organization, or this server has no issue fields`,
			};
		}
		const parsed = parseDefinitions(answer.body);
		if (typeof parsed === 'string') {
			return {
				outcome: { kind: 'unreadable', why: parsed },
				why: `GET ${path} answered something this version of task does not understand (${parsed}); the REST shape of the definitions was never observed`,
			};
		}
		return { fields: parsed, outcome: { kind: 'read', fields: parsed.length } };
	}
}

/** The single-select fields of an answer in the shape of the MCP `list_issue_fields`; a sentence for another shape. */
export function parseDefinitions(body: unknown): Array<{ id: number; name: string; options: string[] }> | string {
	if (!Array.isArray(body)) return 'not a list';
	const fields: Array<{ id: number; name: string; options: string[] }> = [];
	for (const item of body as ApiFieldDefinition[]) {
		if (typeof item !== 'object' || item === null) return 'an entry is not an object';
		if (typeof item.name !== 'string') return 'an entry has no name';
		if (typeof item.data_type !== 'string') return `the field "${item.name}" has no data_type`;
		if (item.data_type.toLowerCase() !== 'single_select') continue;
		const id = item.full_database_id;
		if (typeof id !== 'number' || !Number.isSafeInteger(id))
			return `the field "${item.name}" has no numeric full_database_id`;
		if (!Array.isArray(item.options)) return `the field "${item.name}" has no options list`;
		const options: string[] = [];
		for (const option of item.options as Array<{ name?: unknown }>) {
			if (typeof option?.name !== 'string') return `an option of the field "${item.name}" has no name`;
			options.push(option.name);
		}
		fields.push({ id, name: item.name, options });
	}
	return fields;
}
