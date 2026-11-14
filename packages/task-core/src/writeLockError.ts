// The failure of the project write lock, in a file of its own: the wire codec of the remote protocol needs the class and must not pull
// the Node modules of projectLock.ts. No Node module is imported.

/** What the lock file tells about its holder. */
export interface LockHolder {
	pid: number;
	host: string;
	/** ISO instant the lock was taken. */
	at: string;
}

/** The lock could not be taken in time. `holder` is absent when the lock file cannot be read. */
export class WriteLockTimeoutError extends Error {
	constructor(
		message: string,
		readonly hint: string,
		readonly lockPath: string,
		readonly holder?: LockHolder
	) {
		super(message);
		this.name = 'WriteLockTimeoutError';
	}
}
