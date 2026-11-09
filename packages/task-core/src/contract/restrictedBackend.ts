// Test fixture of the contract suite (not exported by the package): the local backend under a SMALLER declaration that
// refuses loudly what it declares away, the way a forge adapter will. It proves the gated cases of the contract assert
// UnsupportedByBackendError instead of being skipped (backendContract.meta.test.ts). It guards the operations the
// contract exercises for each capability, which is the point of a fixture: a real adapter guards all of them.
import { UnsupportedByBackendError } from '../backend/backendErrors.js';
import type { BackendCapabilities } from '../backend/capabilities.js';
import { LOCAL_CAPABILITIES } from '../backend/capabilities.js';
import { LocalFileBackend } from '../backend/LocalFileBackend.js';
import type { ListQuery, Page, TaskBackend, VersionedRecord, WriteOptions } from '../backend/TaskBackend.js';
import { TaskStore } from '../TaskStore.js';
import type { TaskStoreOptions, TaskSummary } from '../TaskStore.js';

export const RESTRICTED_CAPABILITIES: BackendCapabilities = Object.freeze({
	...LOCAL_CAPABILITIES,
	hierarchy: 'none',
	linkTypes: Object.freeze(['blockedBy'] as const),
	delete: 'no',
	search: 'none',
	concurrency: 'none',
	labels: false,
	meta: false,
	comments: false,
});

function refuse(operation: string, capability: keyof BackendCapabilities, hint: string): never {
	throw new UnsupportedByBackendError('local', operation, capability, hint);
}

const NO_LABELS = 'Labels are not available on this backend.';
const NO_META = 'Declare a fill for meta in the project config, or do not use metadata here.';
const NO_COMMENTS = 'Comments are not available on this backend.';
const NO_HIERARCHY = 'This backend has no hierarchy; use a link instead.';
const NO_REVISION = 'Write without expectedRevision (last write wins on this backend).';

export class RestrictedBackend extends LocalFileBackend {
	override readonly capabilities = RESTRICTED_CAPABILITIES;

	private requireNoRevision(operation: string, options: WriteOptions | undefined): void {
		if (options?.expectedRevision !== undefined) {
			refuse(operation, 'concurrency', NO_REVISION);
		}
	}

	// ---- concurrency: none ----
	override async updateStatus(
		...[id, status, options]: Parameters<TaskBackend['updateStatus']>
	): Promise<VersionedRecord> {
		this.requireNoRevision('updateStatus', options);
		return super.updateStatus(id, status, options);
	}

	override async setTitle(...[id, title, options]: Parameters<TaskBackend['setTitle']>): Promise<VersionedRecord> {
		this.requireNoRevision('setTitle', options);
		return super.setTitle(id, title, options);
	}

	override async setDescription(
		...[id, description, options]: Parameters<TaskBackend['setDescription']>
	): Promise<VersionedRecord> {
		this.requireNoRevision('setDescription', options);
		return super.setDescription(id, description, options);
	}

	override async setType(...[id, type, options]: Parameters<TaskBackend['setType']>): Promise<VersionedRecord> {
		this.requireNoRevision('setType', options);
		return super.setType(id, type, options);
	}

	override async clearType(...[id, options]: Parameters<TaskBackend['clearType']>): Promise<VersionedRecord> {
		this.requireNoRevision('clearType', options);
		return super.clearType(id, options);
	}

	// ---- labels, meta, comments: off ----
	override async addLabel(..._args: Parameters<TaskBackend['addLabel']>): Promise<never> {
		return refuse('addLabel', 'labels', NO_LABELS);
	}

	override async removeLabel(..._args: Parameters<TaskBackend['removeLabel']>): Promise<never> {
		return refuse('removeLabel', 'labels', NO_LABELS);
	}

	override async listLabels(): Promise<never> {
		return refuse('listLabels', 'labels', NO_LABELS);
	}

	override async setMeta(..._args: Parameters<TaskBackend['setMeta']>): Promise<never> {
		return refuse('setMeta', 'meta', NO_META);
	}

	override async removeMeta(..._args: Parameters<TaskBackend['removeMeta']>): Promise<never> {
		return refuse('removeMeta', 'meta', NO_META);
	}

	override async addComment(..._args: Parameters<TaskBackend['addComment']>): Promise<never> {
		return refuse('addComment', 'comments', NO_COMMENTS);
	}

	override async editComment(..._args: Parameters<TaskBackend['editComment']>): Promise<never> {
		return refuse('editComment', 'comments', NO_COMMENTS);
	}

	override async removeComment(..._args: Parameters<TaskBackend['removeComment']>): Promise<never> {
		return refuse('removeComment', 'comments', NO_COMMENTS);
	}

	// ---- hierarchy: none ----
	override async create(...[input]: Parameters<TaskBackend['create']>): Promise<VersionedRecord> {
		if (input.parentId !== undefined) {
			refuse(
				'create with a parent',
				'hierarchy',
				'Create the task without a parent: this backend has no hierarchy.'
			);
		}
		return super.create(input);
	}

	override async setParent(..._args: Parameters<TaskBackend['setParent']>): Promise<never> {
		return refuse('setParent', 'hierarchy', NO_HIERARCHY);
	}

	override async removeParent(..._args: Parameters<TaskBackend['removeParent']>): Promise<never> {
		return refuse('removeParent', 'hierarchy', NO_HIERARCHY);
	}

	override async getChildren(..._args: Parameters<TaskBackend['getChildren']>): Promise<never> {
		return refuse('getChildren', 'hierarchy', NO_HIERARCHY);
	}

	override async getTree(..._args: Parameters<TaskBackend['getTree']>): Promise<never> {
		return refuse('getTree', 'hierarchy', NO_HIERARCHY);
	}

	override async getForest(..._args: Parameters<TaskBackend['getForest']>): Promise<never> {
		return refuse('getForest', 'hierarchy', NO_HIERARCHY);
	}

	override async getDescendants(..._args: Parameters<TaskBackend['getDescendants']>): Promise<never> {
		return refuse('getDescendants', 'hierarchy', NO_HIERARCHY);
	}

	override async getFullTree(..._args: Parameters<TaskBackend['getFullTree']>): Promise<never> {
		return refuse('getFullTree', 'hierarchy', NO_HIERARCHY);
	}

	override async getAncestors(..._args: Parameters<TaskBackend['getAncestors']>): Promise<never> {
		return refuse('getAncestors', 'hierarchy', NO_HIERARCHY);
	}

	// ---- links: blockedBy only ----
	override async addLink(
		...[id, type, targetId, options]: Parameters<TaskBackend['addLink']>
	): Promise<VersionedRecord> {
		if (type !== 'blockedBy') {
			refuse(`addLink ${type}`, 'linkTypes', 'Only blockedBy links are stored by this backend.');
		}
		return super.addLink(id, type, targetId, options);
	}

	// ---- delete: no, search: none ----
	override async deleteTask(..._args: Parameters<TaskBackend['deleteTask']>): Promise<never> {
		return refuse(
			'deleteTask',
			'delete',
			'This backend cannot delete a task; close it with a terminal status instead.'
		);
	}

	override async listPage(query: ListQuery = {}): Promise<Page<TaskSummary>> {
		if (query.text !== undefined) {
			refuse('listPage with text', 'search', 'This backend has no search; filter the list yourself.');
		}
		if (query.parentId !== undefined) {
			refuse('listPage with parentId', 'hierarchy', NO_HIERARCHY);
		}
		return super.listPage(query);
	}
}

/**
 * The restricted backend over `tasksDir`, for the packages that test against a backend with fewer capabilities (task migrate):
 * the store class is not exported by task-core, so they ask for the backend by directory like `createLocalBackend`.
 */
export function createRestrictedBackend(tasksDir: string, options: TaskStoreOptions = {}): RestrictedBackend {
	return new RestrictedBackend(new TaskStore(tasksDir, options));
}
