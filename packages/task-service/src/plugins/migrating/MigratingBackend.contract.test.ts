import { LOCAL_CAPABILITIES } from '@wadeck-app/task-core';
import type { BackendCapabilities, CreateTaskInput, TaskBackend } from '@wadeck-app/task-core';
import { runBackendContract } from '@wadeck-app/task-core/contract';
import type { BackendFixture } from '@wadeck-app/task-core/contract';

import { PAIR_KINDS, wrap } from './testHelpers.js';
import type { Pair, Wrapped } from './testHelpers.js';

// The shared backend contract against the migrating strategy, over TWO different pairs, so that what the wrapper does is proved to depend
// on the capabilities of the sides and on nothing else:
//  - two sides of the same kind: the intersection is the whole of what each does;
//  - a side that stores the tasks itself and a side behind an HTTP API (a fake server): where the second cannot do what a case does, the
//    case asserts the loud refusal (UnsupportedByBackendError) from the wrapper, though the first could do it.
// And in EVERY state a task can be in: the fixture makes each task the contract creates reach that state before the case uses it.
//   made-in-new  the task is born in new (what a creation through the wrapper does)
//   in-a         the task exists in current only, as before any move
//   moving       current is the truth and new holds an equal copy that every write is mirrored to
//   in-b         the task was moved: new is the truth, the copy in current is kept
const STATES = ['made-in-new', 'in-a', 'moving', 'in-b'] as const;
type State = (typeof STATES)[number];

// What both a side with files and the fake API (with its metadata fill) can do, written out (not computed by the code under test).
const SHARED_WITH_THE_API: BackendCapabilities = {
	hierarchy: 'limited',
	linkTypes: ['blockedBy'],
	status: 'mapped',
	history: 'derived',
	activity: 'native',
	delete: 'yes',
	search: 'native',
	concurrency: 'check-then-write',
	ids: 'assigned',
	labels: true,
	meta: true,
	comments: true,
	commentAttachments: false,
	priority: true,
	assignee: true,
	claim: true,
	writes: 'full',
	indexedGraph: false,
	events: 'client',
};

const EXPECTED: Record<string, BackendCapabilities> = {
	'local + local': LOCAL_CAPABILITIES,
	'local + API (fake server)': SHARED_WITH_THE_API,
};

const ACCEPT_ALL = { acceptedLosses: ['all'] } as const;

/** The wrapper, but a creation puts the task in the state under test (the contract only ever creates through the port). */
function inState(pair: Pair, wrapped: Wrapped, state: State): TaskBackend {
	const { backend } = wrapped;
	if (state === 'made-in-new') return backend;
	return new Proxy(backend, {
		get(target, property, receiver): unknown {
			if (property !== 'create') return Reflect.get(target, property, receiver) as unknown;
			return async (input: CreateTaskInput) => {
				const created = await pair.a.create(input);
				if (state === 'moving' || state === 'in-b') {
					const outcome = await target.moves.moveTask(created.id, ACCEPT_ALL);
					if (outcome.outcome !== 'moved') {
						throw new Error(`the fixture could not move task ${created.id}: ${JSON.stringify(outcome)}`);
					}
					if (state === 'moving') {
						// A copy as equal as after a catch-up, current the truth again: the state a move spends most of its time in.
						const row = wrapped.index.snapshot().byPublicId(created.id)!;
						await pair.bRaw.setMeta(row.b!, 'migrating.authority', 'current');
						wrapped.index.mutateRow(created.id, { mustExist: true }, current => {
							const { state: _state, ...rest } = current!;
							void _state;
							return { ...rest, state: 'moving', accepted: ['all'] };
						});
					}
				}
				return target.get(created.id);
			};
		},
	});
}

for (const kind of PAIR_KINDS) {
	for (const state of STATES) {
		runBackendContract(
			`migrating strategy, ${kind.name}, tasks ${state}`,
			async (): Promise<BackendFixture> => {
				const pair = await kind.open();
				const wrapped = wrap(pair);
				return { backend: inState(pair, wrapped, state), dispose: () => pair.dispose() };
			},
			EXPECTED[kind.name]!,
			{
				// A forge writes the comment as the user of the token: the intersection cannot let a person choose the author.
				authoredComments: kind.name === 'local + local',
				// Until a task moved, its comments are written by current, which has no user of its own.
				systemCommentAuthor: state === 'made-in-new' || state === 'in-b',
				// The identity block is written after the creation (or the task was moved): updatedAt moves on.
				freshStampsEqual: state === 'in-a' || state === 'moving',
			}
		);
	}
}
