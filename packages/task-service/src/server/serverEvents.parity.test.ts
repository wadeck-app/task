import type { TaskServiceContext } from '../context.js';
import { addComment, editComment, removeComment } from '../comments.js';
import { createTask } from '../createTask.js';
import { executeDelete, planDelete } from '../deleteTasks.js';
import type { TaskEvent } from '../events.js';
import { removeParent, setParent } from '../hierarchy.js';
import { linkTasks, unlinkTasks } from '../links.js';
import { startRemoteFixture } from '../plugins/remote/testHelpers.js';
import type { RemoteFixture } from '../plugins/remote/testHelpers.js';
import { setStatus } from '../setStatus.js';
import { addLabel, removeLabel, setMeta, setType, unsetMeta, unsetType } from '../taskFields.js';
import { setTaskText } from '../setTaskText.js';
import { createTestContext } from '../testHelpers.js';

// The server raises the queue events of a remote project from the port operations it sees (serverOperations.ts); the use cases build
// the same events for a local project from the records they read. This test runs ONE scenario through the use cases three times --
// over a local backend, and over a remote backend (the events the use cases build on the client, and the events the server raised) --
// and requires the three event streams to be equal. A rule changed in one place and not in the other fails here.

type Trace = Array<{ step: string; events: unknown; refused?: string }>;

const PROJECT_KEYS = ['taskProjectId', 'taskProjectName', 'taskProjectPath'];

function normalize(events: readonly TaskEvent[], names: Map<string, string>): unknown {
	const rename = (value: unknown): unknown => {
		if (typeof value === 'string') return names.get(value) ?? value;
		if (Array.isArray(value)) return value.map(rename);
		if (typeof value === 'object' && value !== null) {
			return Object.fromEntries(
				Object.entries(value)
					.filter(([key]) => !PROJECT_KEYS.includes(key))
					.map(([key, item]) => [key, rename(item)])
			);
		}
		return value;
	};
	// What travels as JSON: a key set to undefined is absent.
	return JSON.parse(JSON.stringify(events.map(event => ({ name: event.name, payload: rename(event.payload) }))));
}

async function scenario(ctx: TaskServiceContext): Promise<{ trace: Trace; names: Map<string, string> }> {
	const names = new Map<string, string>();
	const trace: Trace = [];
	const label = (name: string, id: string): string => {
		names.set(id, name);
		return id;
	};
	const step = async (name: string, run: () => Promise<{ events: TaskEvent[] }>): Promise<void> => {
		try {
			const result = await run();
			trace.push({ step: name, events: normalize(result.events, names) });
		} catch (error) {
			trace.push({
				step: name,
				events: [],
				refused: error instanceof Error ? error.constructor.name : 'unknown',
			});
		}
	};

	let a = '';
	let b = '';
	let c = '';
	let d = '';
	let e = '';
	await step('create A', async () => {
		const result = await createTask(ctx, { title: 'Alpha', description: 'Alpha body' });
		a = label('A', result.task.id);
		return result;
	});
	await step('create B under A', async () => {
		const result = await createTask(ctx, { title: 'Beta', parent: a });
		b = label('B', result.task.id);
		return result;
	});
	await step('create C', async () => {
		const result = await createTask(ctx, { title: 'Gamma' });
		c = label('C', result.task.id);
		return result;
	});
	await step('create D', async () => {
		const result = await createTask(ctx, { title: 'Delta' });
		d = label('D', result.task.id);
		return result;
	});
	await step('create E under B', async () => {
		const result = await createTask(ctx, { title: 'Epsilon', parent: b });
		e = label('E', result.task.id);
		return result;
	});

	await step('B blockedBy C', () => linkTasks(ctx, { id: b, type: 'blockedBy', target: c }));
	await step('D blockedBy A', () => linkTasks(ctx, { id: d, type: 'blockedBy', target: a }));
	await step('C blocks D (inverse name)', () => linkTasks(ctx, { id: c, type: 'blocks', target: d }));
	await step('unlink C blocks D', () => unlinkTasks(ctx, { id: c, type: 'blocks', target: d }));
	await step('refused: B blockedBy B', () => linkTasks(ctx, { id: b, type: 'blockedBy', target: b }));

	await step('type bug', () => setType(ctx, { id: a, type: 'bug' }));
	await step('type bug again', () => setType(ctx, { id: a, type: 'bug' }));
	await step('type feature', () => setType(ctx, { id: a, type: 'feature' }));
	await step('unset type', () => unsetType(ctx, { id: a }));
	await step('unset type again', () => unsetType(ctx, { id: a }));

	await step('label x', () => addLabel(ctx, { id: a, label: 'x' }));
	await step('label x again', () => addLabel(ctx, { id: a, label: 'x' }));
	await step('remove label x', () => removeLabel(ctx, { id: a, label: 'x' }));
	await step('remove absent label', () => removeLabel(ctx, { id: a, label: 'x' }));

	await step('meta k=v', () => setMeta(ctx, { id: a, key: 'k', value: 'v' }));
	await step('meta k=v again', () => setMeta(ctx, { id: a, key: 'k', value: 'v' }));
	await step('meta k=w', () => setMeta(ctx, { id: a, key: 'k', value: 'w' }));
	await step('meta e=empty', () => setMeta(ctx, { id: a, key: 'e', value: '' }));
	await step('unset meta k', () => unsetMeta(ctx, { id: a, key: 'k' }));
	await step('unset absent meta', () => unsetMeta(ctx, { id: a, key: 'zz' }));
	await step('meta constructor', () => setMeta(ctx, { id: a, key: 'constructor', value: 'x' }));

	await step('title', () => setTaskText(ctx, { id: a, title: 'Alpha two' }));
	await step('description', () => setTaskText(ctx, { id: a, description: 'a new body' }));
	await step('description again', () => setTaskText(ctx, { id: a, description: 'a new body' }));
	await step('clear description', () => setTaskText(ctx, { id: a, description: '' }));
	await step('title and description', () => setTaskText(ctx, { id: a, title: 'Alpha three', description: 'both' }));
	await step('description equal to the title', () => setTaskText(ctx, { id: b, description: 'Beta' }));

	await step('C in-progress', () => setStatus(ctx, { id: c, status: 'in-progress' }));
	await step('C in-progress again (refused)', () => setStatus(ctx, { id: c, status: 'in-progress' }));
	await step('C done (unblocks B)', () => setStatus(ctx, { id: c, status: 'done' }));
	await step('A done (D blocked by A)', () => setStatus(ctx, { id: a, status: 'done' }));
	await step('B done', () => setStatus(ctx, { id: b, status: 'done' }));
	await step('C back to backlog', () => setStatus(ctx, { id: c, status: 'backlog' }));

	await step('C under D', () => setParent(ctx, { id: c, parent: d }));
	await step('C under D again', () => setParent(ctx, { id: c, parent: d }));
	await step('refused: D under C (cycle)', () => setParent(ctx, { id: d, parent: c }));
	await step('C under E', () => setParent(ctx, { id: c, parent: e }));
	await step('detach C', () => removeParent(ctx, { id: c }));
	await step('refused: detach a root task', () => removeParent(ctx, { id: c }));

	let commentId = '';
	await step('comment', async () => {
		const result = await addComment(ctx, { id: b, text: 'first', author: 'ann' });
		commentId = label('c1', result.comment.id);
		return result;
	});
	await step('comment without author', async () => {
		const result = await addComment(ctx, { id: b, text: 'second' });
		label('c2', result.comment.id);
		return result;
	});
	await step('edit comment', () => editComment(ctx, { id: b, commentId, text: 'first, edited' }));
	await step('edit comment, same text', () => editComment(ctx, { id: b, commentId, text: 'first, edited' }));
	await step('remove comment', () => removeComment(ctx, { id: b, commentId }));
	await step('refused: blank comment', () => addComment(ctx, { id: b, text: '  ' }));

	await step('delete B (E becomes a root task, C blocked)', async () => {
		const plan = await planDelete(ctx, { selector: { kind: 'ids', ids: [b] } });
		return executeDelete(ctx, plan);
	});
	await step('delete A with its descendants (D links to it)', async () => {
		const plan = await planDelete(ctx, { selector: { kind: 'ids', ids: [a] }, cascade: true });
		return executeDelete(ctx, plan);
	});
	await step('delete a task that has comments', async () => {
		const added = await addComment(ctx, { id: d, text: 'kept until the end' });
		label('c3', added.comment.id);
		const plan = await planDelete(ctx, { selector: { kind: 'ids', ids: [d] } });
		const deleted = await executeDelete(ctx, plan);
		return { events: [...added.events, ...deleted.events] };
	});

	return { trace, names };
}

describe('the events the server raises are the events a local project raises', () => {
	let local: ReturnType<typeof createTestContext>;
	let remote: RemoteFixture;

	beforeAll(async () => {
		local = createTestContext();
		remote = await startRemoteFixture({ withSink: true });
	});

	afterAll(async () => {
		local.cleanup();
		await remote.stop();
	});

	it('runs the same scenario over a local backend and over a remote one and gets the same events, step by step', async () => {
		const clientCtx: TaskServiceContext = {
			...createTestContext().ctx,
			store: remote.backend,
			project: { id: 'b1b1b1b1', name: 'client', path: '/client' },
		};

		const onLocal = await scenario(local.ctx);
		const onRemote = await scenario(clientCtx);

		// The use cases of the client build the same events on their own (the CLI and the module hand them to a sink that raises none)...
		expect(onRemote.trace).toEqual(onLocal.trace);
		expect(onLocal.trace.length).toBeGreaterThan(50);
		// ...and the server raised exactly the same stream, in order, with ITS project in every payload.
		const raised = remote.server.sink.delivered;
		const expected = onLocal.trace.flatMap(entry => entry.events as Array<{ name: string }>);
		expect(normalize(raised, onRemote.names)).toEqual(expected);
		for (const event of raised) {
			expect(event.payload).toMatchObject({ taskProjectId: 'ab12cd34', taskProjectName: 'served' });
		}
		// The scenario really exercised the rules: refusals, no-ops and every kind of event.
		const names = new Set(expected.map(event => event.name));
		expect([...names].sort()).toEqual(
			[
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
			].sort()
		);
		expect(onLocal.trace.filter(entry => entry.refused !== undefined).length).toBeGreaterThanOrEqual(5);
	});
});
