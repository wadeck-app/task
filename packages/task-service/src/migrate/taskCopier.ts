// The copy of ONE task between two backends, for a strategy that moves tasks while the project is in use (the migrating strategy). It is
// the per-task part of `task migrate` and reuses it instead of forking it: `mapTask` decides what the target keeps and writes the loss
// ledger, `createMigrated` carries the fields in the creation call where the backend can, `compare` reads the copy back. What differs
// from the engine: the engine fills only what is missing of a task it creates once; a task that keeps changing while it is copied needs
// the copy to be BROUGHT EQUAL to it as often as asked (every field, the parent, the links, the comments), so the second half of
// `copy` is a diff, and a second call on an unchanged task writes nothing.
//
// A relation to a task that has no copy yet is left out and reported (`unresolved`), never invented: the caller writes it later.
import type { BackendTraits, TaskBackend, VersionedRecord } from '@wadeck-app/task-core';

import type {
	TaskCopier,
	TaskCopyAssessment,
	TaskCopyInput,
	TaskCopyLoss,
	TaskCopyResult,
	ProjectFacts,
} from '../plugins/kinds.js';
import { LossLedger, isLossAllowed } from './lossLedger.js';
import { mapTask } from './mapTask.js';
import type { MappedTask } from './mapTask.js';
import { MigrationRefusedError } from './migrateErrors.js';
import { DEFAULT_MIGRATION_OPTIONS, LOSS_KINDS } from './migrateTypes.js';
import type { MigrationEndpoint } from './migrateTypes.js';
import { compare } from './migrateVerify.js';

export interface CopierSetup {
	project: { id: string; name: string; path?: string };
	facts: ProjectFacts;
	/** The side the tasks are copied from. */
	from: { backend: TaskBackend; traits: BackendTraits };
	/** The side they are copied to. */
	to: { backend: TaskBackend; traits: BackendTraits };
}

type Unresolved = TaskCopyResult['unresolved'][number];

/** What one task becomes: the mapping, the losses, and the relations as the target can hold them. */
interface Plan {
	mapped: MappedTask;
	losses: TaskCopyLoss[];
	/** The parent in the source when the copy keeps it (a loss of the hierarchy drops it). */
	parentSourceId: string | undefined;
}

const normal = (text: string): string => text.replace(/\r\n/g, '\n').trim();
const MARKER_PATTERN = /\[migrated from ([^\]#]*)#([^\]]*)\]/;

/** The comment key a copied comment carries in its text, for the task `qualifiedId`; `undefined` for any other comment. */
function markerKey(text: string, qualifiedId: string): string | undefined {
	const found = MARKER_PATTERN.exec(text);
	return found !== null && found[1] === qualifiedId ? found[2] : undefined;
}

export function createTaskCopier(setup: CopierSetup): TaskCopier {
	const source: MigrationEndpoint = {
		project: setup.project,
		backend: setup.from.backend,
		facts: setup.facts,
		traits: setup.from.traits,
	};
	const target: MigrationEndpoint = {
		project: setup.project,
		backend: setup.to.backend,
		facts: setup.facts,
		traits: setup.to.traits,
	};
	const backend = setup.to.backend;
	const caps = backend.capabilities;

	function plan(input: TaskCopyInput): Plan {
		const { record } = input;
		const ledger = new LossLedger();
		const mapped = mapTask(record, {
			source,
			target,
			options: { ...DEFAULT_MIGRATION_OPTIONS },
			ledger,
			sourceIds: input.sourceIds,
		});
		let parentSourceId: string | undefined = record.parentId;
		if (parentSourceId !== undefined) {
			const limits = target.traits;
			if (caps.hierarchy === 'none') {
				ledger.add('hierarchy:unsupported', record.id, undefined);
				parentSourceId = undefined;
			} else if (!input.sourceIds.has(parentSourceId)) {
				ledger.add('hierarchy:orphan', record.id, undefined);
				parentSourceId = undefined;
			} else if (
				limits.hierarchyDepth !== undefined &&
				input.hierarchy !== undefined &&
				input.hierarchy.depth > limits.hierarchyDepth
			) {
				ledger.add(
					'hierarchy:depth',
					record.id,
					`level ${input.hierarchy.depth}, the target allows ${limits.hierarchyDepth}`
				);
				parentSourceId = undefined;
			} else if (
				limits.childrenPerParent !== undefined &&
				input.hierarchy !== undefined &&
				input.hierarchy.siblings > limits.childrenPerParent
			) {
				ledger.add(
					'hierarchy:children',
					record.id,
					`${input.hierarchy.siblings} children, the target allows ${limits.childrenPerParent}`
				);
				parentSourceId = undefined;
			}
		}
		const losses = ledger
			.rows(kind => isLossAllowed(kind, input.acceptedLosses))
			.map(row => ({ kind: row.kind as string, text: row.text, fix: row.fix, allowed: row.allowed }));
		return { mapped, losses, parentSourceId };
	}

	function assess(input: TaskCopyInput): TaskCopyAssessment {
		const { losses } = plan(input);
		return { losses, blocking: losses.filter(loss => !loss.allowed) };
	}

	/** The relations of the plan as ids on the target, and the ones that cannot be written yet. */
	function relations(
		planned: Plan,
		input: TaskCopyInput
	): {
		parent: string | undefined;
		links: Array<{ type: string; target: string }>;
		unresolved: Unresolved[];
	} {
		const unresolved: Unresolved[] = [];
		let parent: string | undefined;
		if (planned.parentSourceId !== undefined) {
			parent = input.targetIdOf(planned.parentSourceId);
			if (parent === undefined) unresolved.push({ relation: 'parent', sourceId: planned.parentSourceId });
		}
		const links: Array<{ type: string; target: string }> = [];
		for (const link of planned.mapped.links) {
			const targetId = input.targetIdOf(link.sourceTarget);
			if (targetId === undefined) unresolved.push({ relation: link.type, sourceId: link.sourceTarget });
			else links.push({ type: link.type, target: targetId });
		}
		return { parent, links, unresolved };
	}

	async function copy(input: TaskCopyInput & { existingId?: string }): Promise<TaskCopyResult> {
		const planned = plan(input);
		const blocking = planned.losses.filter(loss => !loss.allowed);
		if (blocking.length > 0) {
			throw new MigrationRefusedError(
				`task ${input.record.id} cannot be copied: ${blocking.map(loss => loss.text).join('; ')}`,
				`${blocking.map(loss => `${loss.kind}: ${loss.fix}`).join('; ')}. Accepted loss kinds: ${LOSS_KINDS.join(', ')} (or a group, or all).`
			);
		}
		const { mapped } = planned;
		const related = relations(planned, input);
		const identity = input.identity ?? [];
		if (identity.length > 0 && !caps.meta) {
			throw new MigrationRefusedError(
				`task ${input.record.id} cannot be copied: the target holds no metadata, and every copy carries an identity block in its metadata`,
				'Give the target strategy metadata (a meta fill in its options), or choose another strategy for it.'
			);
		}

		let current: VersionedRecord;
		let created = false;
		// The revision the record was read at: a record that has not changed since is still whole for the links and comments below.
		let readRevision: string | undefined;
		if (input.existingId === undefined) {
			const creation = {
				title: mapped.title,
				status: mapped.status,
				...(related.parent === undefined ? {} : { parentId: related.parent }),
				...(mapped.description === undefined ? {} : { description: mapped.description }),
				...(mapped.createdAt === undefined ? {} : { createdAt: mapped.createdAt }),
			};
			if (target.traits.foldsCreate === true && typeof backend.createMigrated === 'function') {
				const meta = { ...mapped.meta, ...Object.fromEntries(identity) };
				current = await backend.createMigrated({
					...creation,
					...(mapped.type === undefined ? {} : { type: mapped.type }),
					...(mapped.labels.length === 0 ? {} : { labels: mapped.labels }),
					...(mapped.priority === undefined ? {} : { priority: mapped.priority }),
					...(Object.keys(meta).length === 0 ? {} : { meta }),
				});
			} else {
				current = await backend.create(creation);
			}
			created = true;
		} else {
			current = await backend.get(input.existingId);
			readRevision = current.revision;
		}
		const id = current.id;

		// The identity block first, in the given order (the last entry is the one that makes the block readable): a copy that exists
		// is never without a claim on which task it is a copy of.
		for (const [key, value] of identity) {
			if (current.meta !== undefined && Object.hasOwn(current.meta, key)) continue;
			current = await backend.setMeta(id, key, value);
		}

		if (current.title !== mapped.title) current = await backend.setTitle(id, mapped.title);
		if (normal(current.description ?? current.title) !== normal(mapped.description ?? mapped.title)) {
			current = await backend.setDescription(id, mapped.description ?? '');
		}
		if (current.status !== mapped.status) current = await backend.updateStatus(id, mapped.status);
		if ((current.type ?? '') !== (mapped.type ?? '')) {
			current = mapped.type === undefined ? await backend.clearType(id) : await backend.setType(id, mapped.type);
		}
		if (caps.priority === true && current.priority !== mapped.priority) {
			current =
				mapped.priority === undefined
					? await backend.clearPriority!(id)
					: await backend.setPriority!(id, mapped.priority);
		}
		if (caps.assignee === true && current.assignee !== mapped.assignee) {
			current =
				mapped.assignee === undefined
					? await backend.clearAssignee!(id)
					: await backend.setAssignee!(id, mapped.assignee);
		}

		const wanted = new Set(mapped.labels.map(label => label.toLowerCase()));
		const held = new Set((current.labels ?? []).map(label => label.toLowerCase()));
		for (const label of mapped.labels) {
			if (!held.has(label.toLowerCase())) current = await backend.addLabel(id, label);
		}
		for (const label of current.labels ?? []) {
			if (!wanted.has(label.toLowerCase())) current = await backend.removeLabel(id, label);
		}

		if (caps.meta) {
			for (const [key, value] of Object.entries(mapped.meta)) {
				if (current.meta?.[key] !== value) current = await backend.setMeta(id, key, value);
			}
			for (const key of Object.keys(current.meta ?? {})) {
				if (identity.some(([own]) => own === key) || key.startsWith('migrating.')) continue;
				if (!Object.hasOwn(mapped.meta, key)) current = await backend.removeMeta(id, key);
			}
		}

		if (caps.hierarchy !== 'none') {
			if (related.parent !== undefined) {
				if (current.parentId !== related.parent) current = await backend.setParent(id, related.parent);
			} else if (planned.parentSourceId === undefined && current.parentId !== undefined) {
				current = await backend.removeParent(id);
			}
		}

		// Links and comments are read from a record that is whole: read it again once anything was written since the last read.
		if (readRevision === undefined || current.revision !== readRevision) current = await backend.get(id);
		for (const link of related.links) {
			const present = (current.links ?? []).some(held => held.type === link.type && held.target === link.target);
			if (!present) current = await backend.addLink(id, link.type as never, link.target);
		}
		for (const link of current.links ?? []) {
			if (!related.links.some(wantedLink => wantedLink.type === link.type && wantedLink.target === link.target)) {
				current = await backend.removeLink(id, link.type, link.target);
			}
		}

		if (caps.comments) {
			const keys = new Set(mapped.comments.map(comment => comment.key));
			for (const comment of mapped.comments) {
				const found = (current.comments ?? []).find(
					held => markerKey(held.text, mapped.qualifiedId) === comment.key
				);
				if (found === undefined) {
					current = (
						await backend.addComment(
							id,
							comment.text,
							comment.author === undefined ? {} : { author: comment.author }
						)
					).task;
				} else if (normal(found.text) !== normal(comment.text)) {
					current = (await backend.editComment(id, found.id, comment.text)).task;
				}
			}
			for (const held of current.comments ?? []) {
				const key = markerKey(held.text, mapped.qualifiedId);
				if (key !== undefined && !keys.has(key)) current = (await backend.removeComment(id, held.id)).task;
			}
		}

		return { id, record: current, created, losses: planned.losses, unresolved: related.unresolved };
	}

	async function verify(input: TaskCopyInput & { id: string }): Promise<string[]> {
		const planned = plan(input);
		const related = relations(planned, input);
		const actual = await backend.get(input.id);
		const mismatches = compare(
			{
				mapped: planned.mapped,
				targetId: input.id,
				...(related.parent === undefined ? {} : { parentTargetId: related.parent }),
				marker: false,
				keepsCreatedAt: target.traits.keepsCreatedAt,
				links: related.links,
			},
			actual
		);
		const differences = mismatches.map(
			mismatch => `${mismatch.field}: expected ${mismatch.expected}, found ${mismatch.actual}`
		);
		for (const open of related.unresolved) {
			differences.push(`${open.relation}: task ${open.sourceId} has no copy yet`);
		}
		return differences;
	}

	return { assess, copy, verify };
}
