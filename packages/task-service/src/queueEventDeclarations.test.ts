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
import { addLabel, removeLabel, setMeta, setType } from './taskFields.js';
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
			'onTaskCreated',
			'onTaskDeleted',
			'onTaskLabelAdded',
			'onTaskLabelRemoved',
			'onTaskLinked',
			'onTaskMetaChanged',
			'onTaskParentChanged',
			'onTaskTypeChanged',
			'onTaskUnblocked',
			'onTaskUnlinked',
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
			expect(entry.correlationKey).toBe('payload.taskId');
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

		it('onTaskCreated, with and without parent and type', () => {
			const root = createTask(t.ctx, { description: 'root' });
			expectConform(root.events);
			t.ctx.store.setType(root.task.id, 'bug');
			t.ctx.store.addLabel(root.task.id, 'x');
			const child = createTask(t.ctx, { description: 'child', parent: root.task.id });
			expect(child.events[0]!.payload).toMatchObject({ parentId: root.task.id });
			expectConform(child.events);
		});

		it('onStatusChange and onTaskUnblocked, with type and labels set and unset', () => {
			const blocker = createTask(t.ctx, { description: 'blocker' }).task;
			const blocked = createTask(t.ctx, { description: 'blocked' }).task;
			t.ctx.store.setType(blocked.id, 'bug');
			t.ctx.store.addLabel(blocked.id, 'urgent');
			linkTasks(t.ctx, { id: blocked.id, type: 'blockedBy', target: blocker.id });

			const progress = setStatus(t.ctx, { id: blocker.id, status: 'in-progress' });
			expect(progress.events[0]!.payload).toMatchObject({ newStatus: 'in-progress', status: 'in-progress' });
			expectConform(progress.events);
			const done = setStatus(t.ctx, { id: blocker.id, status: 'done' });
			expect(done.events.map(event => event.name)).toEqual(['onStatusChange', 'onTaskUnblocked']);
			expect(done.events[1]!.payload).toMatchObject({ taskId: blocked.id, blockerId: blocker.id });
			expectConform(done.events);
		});

		it('onTaskLinked and onTaskUnlinked, with a stored type and with an inverse spelling', () => {
			const a = createTask(t.ctx, { description: 'a' }).task;
			const b = createTask(t.ctx, { description: 'b' }).task;
			expectConform(linkTasks(t.ctx, { id: a.id, type: 'blockedBy', target: b.id }).events);
			expectConform(unlinkTasks(t.ctx, { id: a.id, type: 'blockedBy', target: b.id }).events);

			// "b blocks a" is stored on a as blockedBy: the holder (taskId) is the blocked one.
			const inverse = linkTasks(t.ctx, { id: b.id, type: 'blocks', target: a.id });
			expect(inverse.events[0]!.payload).toMatchObject({ taskId: a.id, linkType: 'blockedBy', targetId: b.id });
			expectConform(inverse.events);
			expectConform(unlinkTasks(t.ctx, { id: b.id, type: 'blocks', target: a.id }).events);

			for (const type of ['duplicateOf', 'causedBy']) {
				const other = createTask(t.ctx, { description: type }).task;
				expectConform(linkTasks(t.ctx, { id: a.id, type, target: other.id }).events);
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

		it('onTaskTypeChanged, from no type and from a type', () => {
			const task = createTask(t.ctx, { description: 'a' }).task;
			const first = setType(t.ctx, { id: task.id, type: 'bug' });
			expect(first.events.map(event => event.name)).toEqual(['onTaskTypeChanged']);
			expectConform(first.events);
			expectConform(setType(t.ctx, { id: task.id, type: 'feature' }).events);
		});

		it('onTaskDeleted, for a root task, a child with orphans and links, and a cascade', () => {
			const parent = createTask(t.ctx, { description: 'parent' }).task;
			createTask(t.ctx, { description: 'child', parent: parent.id });
			const holder = createTask(t.ctx, { description: 'holder' }).task;
			linkTasks(t.ctx, { id: holder.id, type: 'blockedBy', target: parent.id });
			const loose = createTask(t.ctx, { description: 'loose' }).task;

			const deleted = executeDelete(t.ctx, planDelete(t.ctx, { selector: { kind: 'ids', ids: [parent.id] } }));
			expect(deleted.events.map(event => event.name)).toEqual(['onTaskDeleted']);
			expect(deleted.events[0]!.payload).toMatchObject({ removedLinkCount: 1 });
			expectConform(deleted.events);
			expectConform(
				executeDelete(t.ctx, planDelete(t.ctx, { selector: { kind: 'ids', ids: [loose.id] } })).events
			);

			const root = createTask(t.ctx, { description: 'root' }).task;
			createTask(t.ctx, { description: 'kid', parent: root.id });
			const cascade = executeDelete(
				t.ctx,
				planDelete(t.ctx, { selector: { kind: 'ids', ids: [root.id] }, cascade: true })
			);
			expect(cascade.events).toHaveLength(2);
			expectConform(cascade.events);
		});

		it('onTaskParentChanged, attached, moved and detached', () => {
			const a = createTask(t.ctx, { description: 'a' }).task;
			const b = createTask(t.ctx, { description: 'b' }).task;
			const c = createTask(t.ctx, { description: 'c' }).task;
			expectConform(setParent(t.ctx, { id: c.id, parent: a.id }).events);
			expectConform(setParent(t.ctx, { id: c.id, parent: b.id }).events);
			expectConform(removeParent(t.ctx, { id: c.id }).events);
		});

		it('onTaskMetaChanged, for a new key and for a changed value', () => {
			const task = createTask(t.ctx, { description: 'a' }).task;
			expectConform(setMeta(t.ctx, { id: task.id, key: 'owner', value: 'ann' }).events);
			expectConform(setMeta(t.ctx, { id: task.id, key: 'owner', value: '' }).events);
		});

		it('onTaskLabelAdded and onTaskLabelRemoved', () => {
			const task = createTask(t.ctx, { description: 'a' }).task;
			expectConform(addLabel(t.ctx, { id: task.id, label: 'urgent' }).events);
			expectConform(removeLabel(t.ctx, { id: task.id, label: 'urgent' }).events);
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
