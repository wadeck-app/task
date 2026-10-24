import { checkAgainstSchema } from './jsonSchemaCheck.js';
import { createTask } from './createTask.js';
import type { TaskEvent } from './events.js';
import { linkTasks, unlinkTasks } from './links.js';
import {
	QUEUE_EVENT_LIMITS,
	TASK_EVENT_NAMES,
	TASK_QUEUE_SOURCE,
	queueEventDeclarations,
	queueEventDeclarationsHash,
} from './queueEventDeclarations.js';
import { setStatus } from './setStatus.js';
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
			'onTaskLinked',
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

		it('no event is terminal', () => {
			for (const entry of queueEventDeclarations) expect(entry.terminal ?? false).toBe(false);
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

			expectConform(setStatus(t.ctx, { id: blocker.id, status: 'in-progress' }).events);
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
