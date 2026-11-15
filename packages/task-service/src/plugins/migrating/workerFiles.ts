// The files of the background worker and of the migration state: what `migrationState.ts` and `workerLock.ts` need from the file system.
// Everything the journal needs (append, read, ensureDir, atomic replace) plus the two things a lock needs: exclusive creation and removal.
import type { WalFiles } from './migrationJournal.js';

export interface WorkerFiles extends WalFiles {
	/** Creates the file only when it does not exist yet (atomic). Returns false, and writes nothing, when it exists. Any other failure throws. */
	createExclusive(file: string, text: string): boolean;
	/** Removes the file; a file that is not there is fine. Any other failure throws. */
	remove(file: string): void;
}
