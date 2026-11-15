// What the migrating strategy offers the rest of the service through the seam (`StrategyInstance.migration`, `StrategyPlugin
// .migrationControl`), so the CLI and the module use a migration without importing a plugin folder.
//   MigrationApi         needs the project opened (both sides): the plan and start of a migration, and its background worker
//   MigrationControlApi  needs only the files under `<data dir>/migrating/`: status, pause, resume, log. No side is opened, so these
//                        work when a token is missing or a server is down.
import type { ControlInput, LogEntry, MigrationStatusReport, PauseResult, ResumeResult } from './migrationControl.js';
import type { StartInput, StartResult } from './startMigration.js';
import type { WorkerOptions, WorkerResult } from './migrationWorker.js';

export interface MigrationApi {
	/** `<data dir>/migrating`: where the state, the logs and the lock of the worker are. */
	readonly dir: string;
	/** The plan for every task of "current", then (unless `dryRun`) the routing index and the state. Starts no worker. */
	start(input?: StartInput): Promise<StartResult>;
	/** The worker loop, in this process, until it has nothing left to do or is asked to stop. */
	runWorker(options: WorkerOptions): Promise<WorkerResult>;
}

export interface MigrationControlApi {
	/** The input of the functions below for the project whose data folder is `dataDir`, on this machine (real files, clock, process table). */
	input(dataDir: string, writeFile: (file: string, content: string) => void): ControlInput;
	status(input: ControlInput): MigrationStatusReport;
	pause(input: ControlInput): PauseResult;
	resume(input: ControlInput, launch: () => Promise<{ pid?: number }>): Promise<ResumeResult>;
	log(input: ControlInput, options?: { tail?: number; after?: number }): { entries: LogEntry[]; total: number };
	waitForWorker(
		input: ControlInput,
		options: { timeoutMs: number; sleep: (ms: number) => Promise<void> }
	): Promise<boolean>;
}

export type {
	ControlInput,
	LogEntry,
	MigrationStatusReport,
	PauseResult,
	ResumeResult,
	StartInput,
	StartResult,
	WorkerOptions,
	WorkerResult,
};
export type { PlanLoss, StartEstimate, StartPlan } from './startMigration.js';
export type { MigrationState, MigrationStatus } from './migrationState.js';
