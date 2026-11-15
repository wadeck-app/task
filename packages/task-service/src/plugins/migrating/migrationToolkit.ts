// What the start of a migration and its background worker need from an opened migrating strategy: the two sides' port, the routing
// index, the journal, the copy of one task, the moves, and the places and clocks the worker uses. The plugin builds it once it has
// opened both sides and offers it on its instance (`StrategyInstance.migration`), so the commands of a person and the worker program
// against this interface and never against a kind of storage. Everything with a side effect (the files, the clock, the process
// table) is a field, so a test runs the whole machinery in memory with a clock it drives.
import type { BackendCapabilities, BackendTraits, TaskBackend } from '@wadeck-app/task-core';

import type { TaskCopier } from '../kinds.js';
import type { MigrationMoves } from './MigratingBackend.js';
import type { MigrationJournal } from './migrationJournal.js';
import type { RoutingIndex } from './routingIndex.js';
import type { WorkerFiles } from './workerFiles.js';

export interface MigrationToolkit {
	/** `<data dir>/migrating`: where state.json, control.json, worker.json, worker.lock and the logs live. */
	dir: string;
	files: WorkerFiles;
	/** The side the tasks are in (read to plan and to order the moves). */
	current: TaskBackend;
	/** What the side they move to can do and keeps and costs. */
	nextCapabilities: BackendCapabilities;
	nextTraits: BackendTraits;
	index: RoutingIndex;
	journal: MigrationJournal;
	/** The per-task copy of `task migrate` (the plan asks it what each task would lose). */
	copier: TaskCopier;
	moves: MigrationMoves;
	/** `strategy.options.budget`, as validated. */
	budget?: { requestsPerMinute?: number };
	/** The clock in milliseconds. */
	now: () => number;
	/** Whether a process of this host exists. */
	isAlive: (pid: number) => boolean;
	host: string;
	pid: number;
}
