import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { UnsupportedByBackendError } from '../backend/backendErrors';
import { LOCAL_CAPABILITIES } from '../backend/capabilities';
import type { BackendCapabilities } from '../backend/capabilities';
import { LocalFileBackend } from '../backend/LocalFileBackend';
import type { VersionedRecord } from '../backend/TaskBackend';
import { TaskStore } from '../TaskStore';
import { READ_ONLY_CASES, READ_ONLY_SCENARIO, runReadOnlyBackendContract, runReadOnlyCase } from './readOnlyContract';
import type { ReadOnlyFixture, SeedTask } from './readOnlyContract';

// A read-only view of the local store: the same data, every write refused. It proves the suite passes a correct read-only
// backend, and (below) that it catches the usual mistakes of a wrong one.
export const READ_ONLY_LOCAL_CAPABILITIES: BackendCapabilities = Object.freeze({
	...LOCAL_CAPABILITIES,
	writes: 'none',
});

const STATUS_OF = { initial: 'backlog', next: 'in-progress', terminal: 'done' } as const;

function refuse(operation: string): never {
	throw new UnsupportedByBackendError(
		'local',
		operation,
		'writes',
		'This view is read-only: change the data at its source.'
	);
}

class ReadOnlyLocal extends LocalFileBackend {
	override readonly capabilities = READ_ONLY_LOCAL_CAPABILITIES;
	override async create(..._args: unknown[]): Promise<VersionedRecord> {
		return refuse('create');
	}
	override async updateStatus(): Promise<VersionedRecord> {
		return refuse('updateStatus');
	}
	override async setTitle(): Promise<VersionedRecord> {
		return refuse('setTitle');
	}
	override async setDescription(): Promise<VersionedRecord> {
		return refuse('setDescription');
	}
	override async setType(): Promise<VersionedRecord> {
		return refuse('setType');
	}
	override async clearType(): Promise<VersionedRecord> {
		return refuse('clearType');
	}
	override async addLabel(): Promise<VersionedRecord> {
		return refuse('addLabel');
	}
	override async removeLabel(): Promise<VersionedRecord> {
		return refuse('removeLabel');
	}
	override async setMeta(): Promise<VersionedRecord> {
		return refuse('setMeta');
	}
	override async removeMeta(): Promise<VersionedRecord> {
		return refuse('removeMeta');
	}
	override async setParent(): Promise<VersionedRecord> {
		return refuse('setParent');
	}
	override async removeParent(): Promise<VersionedRecord> {
		return refuse('removeParent');
	}
	override async addLink(): Promise<VersionedRecord> {
		return refuse('addLink');
	}
	override async removeLink(): Promise<VersionedRecord> {
		return refuse('removeLink');
	}
	override async addComment(): Promise<never> {
		return refuse('addComment');
	}
	override async editComment(): Promise<never> {
		return refuse('editComment');
	}
	override async removeComment(): Promise<never> {
		return refuse('removeComment');
	}
	override async deleteTask(): Promise<boolean> {
		return refuse('deleteTask');
	}
}

function localFixture(
	makeBackend: (store: TaskStore) => LocalFileBackend = store => new ReadOnlyLocal(store)
): ReadOnlyFixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-backend-contract-'));
	const tasksDir = path.join(root, 'data', 'tasks');
	fs.mkdirSync(tasksDir, { recursive: true });
	const store = new TaskStore(tasksDir);
	const writer = new LocalFileBackend(store);
	return {
		backend: makeBackend(store),
		dispose: () => fs.rmSync(root, { recursive: true, force: true }),
		async seed(tasks: readonly SeedTask[]) {
			const ids: Record<string, string> = {};
			for (const task of tasks) {
				const created = await writer.create({
					title: task.title,
					status: STATUS_OF.initial,
					...(task.parent === undefined ? {} : { parentId: ids[task.parent]! }),
					...(task.description === undefined ? {} : { description: task.description }),
				});
				ids[task.key] = created.id;
				if (task.status !== 'initial') await writer.updateStatus(created.id, STATUS_OF[task.status]);
				if (task.type !== undefined) await writer.setType(created.id, task.type);
				for (const label of task.labels ?? []) await writer.addLabel(created.id, label);
				for (const blocker of task.blockedBy ?? [])
					await writer.addLink(created.id, 'blockedBy', ids[blocker]!);
				for (const text of task.comments ?? []) await writer.addComment(created.id, text);
			}
			return ids;
		},
	};
}

runReadOnlyBackendContract('read-only view of the local store', () => localFixture(), READ_ONLY_LOCAL_CAPABILITIES);

describe('the read-only contract catches a wrong backend', () => {
	const caseNamed = (fragment: string) => READ_ONLY_CASES.find(c => c.name.includes(fragment))!;

	it('a write that is not refused fails the writes case', async () => {
		// Declares writes: none but still creates.
		class Lying extends ReadOnlyLocal {
			override async create(...args: Parameters<LocalFileBackend['create']>): Promise<VersionedRecord> {
				return LocalFileBackend.prototype.create.apply(this, args);
			}
		}
		const fixture = localFixture(store => new Lying(store));

		try {
			await expect(runReadOnlyCase(caseNamed('every write is refused'), fixture)).rejects.toThrow(
				/should have been refused/
			);
		} finally {
			await fixture.dispose?.();
		}
	});

	it('a refusal for another capability fails the writes case', async () => {
		class WrongCapability extends ReadOnlyLocal {
			override async setTitle(): Promise<VersionedRecord> {
				throw new UnsupportedByBackendError('local', 'setTitle', 'meta', 'x');
			}
		}
		const fixture = localFixture(store => new WrongCapability(store));
		try {
			await expect(runReadOnlyCase(caseNamed('every write is refused'), fixture)).rejects.toThrow(/writes/);
		} finally {
			await fixture.dispose?.();
		}
	});

	it('a backend that does not declare writes: none is refused up front', async () => {
		const fixture = localFixture(store => new LocalFileBackend(store));
		try {
			await expect(runReadOnlyCase(READ_ONLY_CASES[0]!, fixture)).rejects.toThrow(/writes: 'none'/);
		} finally {
			await fixture.dispose?.();
		}
	});

	it('a backend whose children are wrong fails the graph case', async () => {
		class WrongChildren extends ReadOnlyLocal {
			override async getChildren(): Promise<never[]> {
				return [];
			}
		}
		const fixture = localFixture(store => new WrongChildren(store));
		try {
			await expect(runReadOnlyCase(caseNamed('children, descendants'), fixture)).rejects.toThrow();
		} finally {
			await fixture.dispose?.();
		}
	});

	it('the scenario names every key the cases use', () => {
		expect(READ_ONLY_SCENARIO.map(task => task.key)).toEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
	});
});
