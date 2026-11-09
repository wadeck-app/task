import { addComment, editComment, removeComment } from './comments.js';
import { checkAgainstSchema } from './jsonSchemaCheck.js';
import { createTask } from './createTask.js';
import type { TaskEvent } from './events.js';
import { executeDelete, planDelete } from './deleteTasks.js';
import { removeParent, setParent } from './hierarchy.js';
import { linkTasks, unlinkTasks } from './links.js';
import {
	QUEUE_EVENT_LIMITS,
	TASK_EVENT_NAMES,
	TASK_QUEUE_SOURCE,
	queueEventDeclarations,
	queueEventDeclarationsHash,
} from './queueEventDeclarations.js';
import { setStatus } from './setStatus.js';
import { setTaskText } from './setTaskText.js';
import { addLabel, removeLabel, setMeta, setType, unsetMeta, unsetType } from './taskFields.js';
import { createTestContext, type TestContext } from './testHelpers.js';

function declaration(name: string) {
	const found = queueEventDeclarations.find(entry => entry.name === name);
	if (found === undefined) throw new Error(`no declaration for ${name}`);
	return found;
}

/** What the wire does to a payload: undefined fields disappear. */
function throughJson(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

describe('queueEventDeclarations', () => {
	it('declares under the source "task"', () => {
		expect(TASK_QUEUE_SOURCE).toBe('task');
	});

	it('declares each TaskEvent name exactly once, and nothing else', () => {
		// TASK_EVENT_NAMES is typed Record<TaskEvent['name'], true>: adding an event to the union breaks the build until listed.
		const expected = Object.keys(TASK_EVENT_NAMES).sort();
		expect(expected).toEqual([
			'onStatusChange',
			'onTaskCommentAdded',
			'onTaskCommentEdited',
			'onTaskCommentRemoved',
			'onTaskCreated',
			'onTaskDeleted',
			'onTaskLabelAdded',
			'onTaskLabelRemoved',
			'onTaskLinked',
			'onTaskMetaChanged',
			'onTaskParentChanged',
			'onTaskTextChanged',
			'onTaskTypeChanged',
			'onTaskUnblocked',
			'onTaskUnlinked',
			'onTasksMigrated',
		]);
		const declared = queueEventDeclarations.map(entry => entry.name);
		expect([...declared].sort()).toEqual(expected);
		expect(new Set(declared).size).toBe(declared.length);
	});

	describe('limits enforced by the queue daemon (queue-core EventCatalog)', () => {
		it.each(queueEventDeclarations.map(entry => [entry.name, entry] as const))('%s fits them', (_name, entry) => {
			expect(entry.name).toMatch(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/);
			expect(entry.name.length).toBeLessThanOrEqual(QUEUE_EVENT_LIMITS.nameLength);
			expect(entry.description.trim()).not.toBe('');
			expect(entry.description.length).toBeLessThanOrEqual(QUEUE_EVENT_LIMITS.descriptionLength);
			expect(Buffer.byteLength(JSON.stringify(entry.schema))).toBeLessThanOrEqual(QUEUE_EVENT_LIMITS.schemaBytes);
			expect(Buffer.byteLength(JSON.stringify(entry.example))).toBeLessThanOrEqual(
				QUEUE_EVENT_LIMITS.exampleBytes
			);
			// Every event is about one task, except the migration summary: it is about the target project.
			expect(entry.correlationKey).toBe(
				entry.name === 'onTasksMigrated' ? 'payload.toProjectId' : 'payload.taskId'
			);
		});

		it('stays under the events-per-source limit', () => {
			expect(queueEventDeclarations.length).toBeLessThanOrEqual(QUEUE_EVENT_LIMITS.eventsPerSource);
		});

		it('is plain JSON (what the SDK serialises)', () => {
			expect(throughJson(queueEventDeclarations)).toEqual(queueEventDeclarations);
		});
	});

	describe('descriptions say what the event is and what it is not', () => {
		it('onStatusChange is not terminal by itself and never fires for an unchanged status', () => {
			const entry = declaration('onStatusChange');
			expect(entry.terminal).toBe(false);
			expect(entry.description).toMatch(/unchanged/i);
			expect(entry.description).toMatch(/does not end/i);
		});

		it('onStatusChange declares status, says it equals newStatus, and requires it', () => {
			const entry = declaration('onStatusChange');
			expect(entry.description).toMatch(/status equals newStatus/);
			expect(entry.description.length).toBeLessThanOrEqual(QUEUE_EVENT_LIMITS.descriptionLength);
			expect(Object.keys(entry.schema['properties'] as object)).toContain('status');
			expect(entry.schema['required']).toContain('status');
			expect((entry.example as Record<string, unknown>)['status']).toBe(
				(entry.example as Record<string, unknown>)['newStatus']
			);
		});

		it('onTaskUnblocked names the unblocked task as taskId and the finished one as blockerId', () => {
			const text = declaration('onTaskUnblocked').description;
			expect(text).toMatch(/taskId/);
			expect(text).toMatch(/blockerId/);
			expect(text).toMatch(/after onStatusChange/);
		});

		it('the link events explain the holder and that the inverse spelling swaps the tasks', () => {
			for (const name of ['onTaskLinked', 'onTaskUnlinked']) {
				expect(declaration(name).description).toMatch(/holder/);
				expect(declaration(name).description).toMatch(/inverse/);
			}
		});

		it('onTaskCreated says the app-core UI fires it too', () => {
			expect(declaration('onTaskCreated').description).toMatch(/app-core/);
		});

		it('only onTaskDeleted is terminal (it ends the task), with the neutral outcome info', () => {
			for (const entry of queueEventDeclarations) {
				expect(entry.terminal ?? false, entry.name).toBe(entry.name === 'onTaskDeleted');
			}
			expect(declaration('onTaskDeleted').outcome).toBe('info');
		});

		it('onTaskDeleted says one event per task, after the deletion, and what does not fire it', () => {
			const text = declaration('onTaskDeleted').description;
			expect(text).toMatch(/once per deleted task/i);
			expect(text).toMatch(/cascade/i);
			expect(text).toMatch(/leaves before/i);
			expect(text).toMatch(/dry-run|preview/i);
			expect(text).toMatch(/Does NOT fire/);
		});
	});

	describe('examples', () => {
		it.each(queueEventDeclarations.map(entry => [entry.name, entry] as const))(
			'the example of %s validates against its own schema',
			(_name, entry) => {
				expect(checkAgainstSchema(entry.schema, entry.example)).toEqual([]);
			}
		);

		it('a schema really rejects a wrong payload (the check is not vacuous)', () => {
			const entry = declaration('onStatusChange');
			const example = entry.example as Record<string, unknown>;
			expect(checkAgainstSchema(entry.schema, { ...example, newStatus: 4 })).not.toEqual([]);
			expect(checkAgainstSchema(entry.schema, { ...example, surprise: 1 })).not.toEqual([]);
			const withoutId = { ...example };
			delete withoutId['taskId'];
			expect(checkAgainstSchema(entry.schema, withoutId)).not.toEqual([]);
		});
	});

	describe('the schemas follow the payloads the code really produces', () => {
		let t: TestContext;
		beforeEach(() => {
			t = createTestContext({ types: ['bug'] });
		});
		afterEach(() => t.cleanup());

		function expectConform(events: readonly TaskEvent[]): void {
			expect(events.length).toBeGreaterThan(0);
			for (const event of events) {
				const payload = throughJson(event.payload);
				expect(
					checkAgainstSchema(declaration(event.name).schema, payload),
					`${event.name} ${JSON.stringify(payload)}`
				).toEqual([]);
			}
		}

		it('onTaskCreated, with and without parent and type', async () => {
			const root = await createTask(t.ctx, { description: 'root' });
			expectConform(root.events);
			await t.ctx.store.setType(root.task.id, 'bug');
			await t.ctx.store.addLabel(root.task.id, 'x');
			const child = await createTask(t.ctx, { description: 'child', parent: root.task.id });
			expect(child.events[0]!.payload).toMatchObject({ parentId: root.task.id });
			expectConform(child.events);
		});

		it('onStatusChange and onTaskUnblocked, with type and labels set and unset', async () => {
			const blocker = (await createTask(t.ctx, { description: 'blocker' })).task;
			const blocked = (await createTask(t.ctx, { description: 'blocked' })).task;
			await t.ctx.store.setType(blocked.id, 'bug');
			await t.ctx.store.addLabel(blocked.id, 'urgent');
			await linkTasks(t.ctx, { id: blocked.id, type: 'blockedBy', target: blocker.id });

			const progress = await setStatus(t.ctx, { id: blocker.id, status: 'in-progress' });
			expect(progress.events[0]!.payload).toMatchObject({ newStatus: 'in-progress', status: 'in-progress' });
			expectConform(progress.events);
			const done = await setStatus(t.ctx, { id: blocker.id, status: 'done' });
			expect(done.events.map(event => event.name)).toEqual(['onStatusChange', 'onTaskUnblocked']);
			expect(done.events[1]!.payload).toMatchObject({ taskId: blocked.id, blockerId: blocker.id });
			expectConform(done.events);
		});

		it('onTaskLinked and onTaskUnlinked, with a stored type and with an inverse spelling', async () => {
			const a = (await createTask(t.ctx, { description: 'a' })).task;
			const b = (await createTask(t.ctx, { description: 'b' })).task;
			expectConform((await linkTasks(t.ctx, { id: a.id, type: 'blockedBy', target: b.id })).events);
			expectConform((await unlinkTasks(t.ctx, { id: a.id, type: 'blockedBy', target: b.id })).events);

			// "b blocks a" is stored on a as blockedBy: the holder (taskId) is the blocked one.
			const inverse = await linkTasks(t.ctx, { id: b.id, type: 'blocks', target: a.id });
			expect(inverse.events[0]!.payload).toMatchObject({ taskId: a.id, linkType: 'blockedBy', targetId: b.id });
			expectConform(inverse.events);
			expectConform((await unlinkTasks(t.ctx, { id: b.id, type: 'blocks', target: a.id })).events);

			for (const type of ['duplicateOf', 'causedBy']) {
				const other = (await createTask(t.ctx, { description: type })).task;
				expectConform((await linkTasks(t.ctx, { id: a.id, type, target: other.id })).events);
			}
		});
	});

	describe('the schemas follow the payloads of the field and hierarchy operations', () => {
		let t: TestContext;
		beforeEach(() => {
			t = createTestContext();
		});
		afterEach(() => t.cleanup());

		function expectConform(events: readonly TaskEvent[]): void {
			expect(events.length).toBeGreaterThan(0);
			for (const event of events) {
				const payload = throughJson(event.payload);
				expect(
					checkAgainstSchema(declaration(event.name).schema, payload),
					`${event.name} ${JSON.stringify(payload)}`
				).toEqual([]);
			}
		}

		it('onTaskTypeChanged, from no type and from a type', async () => {
			const task = (await createTask(t.ctx, { description: 'a' })).task;
			const first = await setType(t.ctx, { id: task.id, type: 'bug' });
			expect(first.events.map(event => event.name)).toEqual(['onTaskTypeChanged']);
			expectConform(first.events);
			expectConform((await setType(t.ctx, { id: task.id, type: 'feature' })).events);
		});

		it('onTaskTypeChanged with newType absent (type cleared)', async () => {
			const task = (await createTask(t.ctx, { description: 'a' })).task;
			await setType(t.ctx, { id: task.id, type: 'bug' });
			const cleared = await unsetType(t.ctx, { id: task.id });
			expect(throughJson(cleared.events[0]!.payload)).not.toHaveProperty('newType');
			expectConform(cleared.events);
		});

		it('onTaskMetaChanged with newValue absent (key removed)', async () => {
			const task = (await createTask(t.ctx, { description: 'a' })).task;
			await setMeta(t.ctx, { id: task.id, key: 'owner', value: 'ann' });
			await setMeta(t.ctx, { id: task.id, key: 'blank', value: '' });
			const removed = await unsetMeta(t.ctx, { id: task.id, key: 'owner' });
			expect(throughJson(removed.events[0]!.payload)).not.toHaveProperty('newValue');
			expectConform(removed.events);
			expectConform((await unsetMeta(t.ctx, { id: task.id, key: 'blank' })).events);
		});

		it('onTaskTextChanged, for the title, a first description, a changed one and a cleared one', async () => {
			const task = (await createTask(t.ctx, { description: 'a' })).task;
			expectConform((await setTaskText(t.ctx, { id: task.id, title: 'b' })).events);
			const first = await setTaskText(t.ctx, { id: task.id, description: 'body' });
			expect(throughJson(first.events[0]!.payload)).not.toHaveProperty('oldValue');
			expectConform(first.events);
			expectConform((await setTaskText(t.ctx, { id: task.id, description: 'other' })).events);
			expectConform((await setTaskText(t.ctx, { id: task.id, description: '' })).events);
		});

		it('onTaskDeleted, for a root task, a child with orphans and links, and a cascade', async () => {
			const parent = (await createTask(t.ctx, { description: 'parent' })).task;
			await createTask(t.ctx, { description: 'child', parent: parent.id });
			const holder = (await createTask(t.ctx, { description: 'holder' })).task;
			await linkTasks(t.ctx, { id: holder.id, type: 'blockedBy', target: parent.id });
			const loose = (await createTask(t.ctx, { description: 'loose' })).task;

			const deleted = await executeDelete(
				t.ctx,
				await planDelete(t.ctx, { selector: { kind: 'ids', ids: [parent.id] } })
			);
			expect(deleted.events.map(event => event.name)).toEqual(['onTaskDeleted']);
			expect(deleted.events[0]!.payload).toMatchObject({ removedLinkCount: 1 });
			expectConform(deleted.events);
			expectConform(
				(await executeDelete(t.ctx, await planDelete(t.ctx, { selector: { kind: 'ids', ids: [loose.id] } })))
					.events
			);

			const root = (await createTask(t.ctx, { description: 'root' })).task;
			await createTask(t.ctx, { description: 'kid', parent: root.id });
			const cascade = await executeDelete(
				t.ctx,
				await planDelete(t.ctx, { selector: { kind: 'ids', ids: [root.id] }, cascade: true })
			);
			expect(cascade.events).toHaveLength(2);
			expectConform(cascade.events);
		});

		it('onTaskCommentAdded / Edited / Removed, with and without author, multi-line text', async () => {
			const task = (await createTask(t.ctx, { description: 'a' })).task;
			const plain = await addComment(t.ctx, { id: task.id, text: 'line 1\nline 2' });
			expect(throughJson(plain.events[0]!.payload)).not.toHaveProperty('author');
			expectConform(plain.events);
			const named = await addComment(t.ctx, { id: task.id, text: 'b', author: 'alice' });
			expectConform(named.events);
			const edited = await editComment(t.ctx, { id: task.id, commentId: plain.comment.id, text: 'c' });
			expect(edited.events[0]!.payload).toMatchObject({ oldText: 'line 1\nline 2', newText: 'c' });
			expectConform(edited.events);
			expectConform((await removeComment(t.ctx, { id: task.id, commentId: named.comment.id })).events);
		});

		it('onTaskDeleted with commentCount (a task that had comments)', async () => {
			const task = (await createTask(t.ctx, { description: 'a' })).task;
			await addComment(t.ctx, { id: task.id, text: 'x' });
			const deleted = await executeDelete(
				t.ctx,
				await planDelete(t.ctx, { selector: { kind: 'ids', ids: [task.id] } })
			);
			expect(throughJson(deleted.events[0]!.payload)).toMatchObject({ commentCount: 1 });
			expectConform(deleted.events);
		});

		it('onTaskParentChanged, attached, moved and detached', async () => {
			const a = (await createTask(t.ctx, { description: 'a' })).task;
			const b = (await createTask(t.ctx, { description: 'b' })).task;
			const c = (await createTask(t.ctx, { description: 'c' })).task;
			expectConform((await setParent(t.ctx, { id: c.id, parent: a.id })).events);
			expectConform((await setParent(t.ctx, { id: c.id, parent: b.id })).events);
			expectConform((await removeParent(t.ctx, { id: c.id })).events);
		});

		it('onTaskMetaChanged, for a new key and for a changed value', async () => {
			const task = (await createTask(t.ctx, { description: 'a' })).task;
			expectConform((await setMeta(t.ctx, { id: task.id, key: 'owner', value: 'ann' })).events);
			expectConform((await setMeta(t.ctx, { id: task.id, key: 'owner', value: '' })).events);
		});

		it('onTaskLabelAdded and onTaskLabelRemoved', async () => {
			const task = (await createTask(t.ctx, { description: 'a' })).task;
			expectConform((await addLabel(t.ctx, { id: task.id, label: 'urgent' })).events);
			expectConform((await removeLabel(t.ctx, { id: task.id, label: 'urgent' })).events);
		});
	});

	describe('onTaskTextChanged declaration', () => {
		it('says what fires it and what does not, within the daemon limit, correlated on taskId', () => {
			const entry = declaration('onTaskTextChanged');
			expect(entry.description).toMatch(/title/);
			expect(entry.description).toMatch(/description/);
			expect(entry.description).toMatch(/Does NOT fire/);
			expect(entry.terminal ?? false).toBe(false);
			expect(entry.schema['required']).toEqual(expect.arrayContaining(['taskId', 'field', 'newValue']));
			expect(entry.schema['required']).not.toContain('oldValue');
			expect(checkAgainstSchema(entry.schema, { ...(entry.example as object), field: 'author' })).not.toEqual([]);
		});

		it('onTaskMetaChanged and onTaskTypeChanged do not require the new value (removals), and say so', () => {
			expect(declaration('onTaskMetaChanged').schema['required']).not.toContain('newValue');
			expect(declaration('onTaskMetaChanged').description).toMatch(/removed/i);
			expect(declaration('onTaskTypeChanged').schema['required']).not.toContain('newType');
			expect(declaration('onTaskTypeChanged').description).toMatch(/cleared/i);
		});

		it('onTaskCreated and onTaskDeleted say description is the full text', () => {
			expect(declaration('onTaskCreated').description).toMatch(/full text/i);
			expect(JSON.stringify(declaration('onTaskDeleted').schema)).toMatch(/full text/i);
		});
	});

	describe('comment event declarations', () => {
		it.each(['onTaskCommentAdded', 'onTaskCommentEdited', 'onTaskCommentRemoved'])(
			'%s says what fires it and what does not, is not terminal, and its example fits its schema',
			name => {
				const entry = declaration(name);
				expect(entry.description).toMatch(/comment/i);
				expect(entry.description).toMatch(/Does NOT fire/);
				expect(entry.terminal ?? false).toBe(false);
				expect(entry.schema['required']).toEqual(expect.arrayContaining(['taskId', 'commentId']));
				expect(checkAgainstSchema(entry.schema, entry.example)).toEqual([]);
			}
		);

		it('the added and edited events carry the full text; the author is optional', () => {
			expect(declaration('onTaskCommentAdded').description).toMatch(/full text/i);
			expect(declaration('onTaskCommentAdded').schema['required']).toContain('text');
			expect(declaration('onTaskCommentAdded').schema['required']).not.toContain('author');
			expect(declaration('onTaskCommentEdited').schema['required']).toContain('newText');
		});

		it('onTaskDeleted declares commentCount as optional', () => {
			const entry = declaration('onTaskDeleted');
			expect(JSON.stringify(entry.schema)).toContain('commentCount');
			expect(entry.schema['required']).not.toContain('commentCount');
		});
	});

	describe('queueEventDeclarationsHash', () => {
		it('is stable and a hex digest', () => {
			expect(queueEventDeclarationsHash()).toMatch(/^[0-9a-f]{64}$/);
			expect(queueEventDeclarationsHash()).toBe(queueEventDeclarationsHash());
		});

		it('changes with any declaration content', () => {
			const changed = queueEventDeclarations.map((entry, index) =>
				index === 0 ? { ...entry, description: entry.description + '.' } : entry
			);
			expect(queueEventDeclarationsHash(changed)).not.toBe(queueEventDeclarationsHash());
		});
	});
});
