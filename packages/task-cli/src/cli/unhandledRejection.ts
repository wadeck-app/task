/** What the handler needs of `process` (tests pass a fake). */
export interface RejectionProcess {
	on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
	exit(code: number): never | void;
	stderr: { write(text: string): unknown };
}

/** The text printed for a promise nobody handled: what happened, and what to do about it. */
export function describeUnhandledRejection(reason: unknown): string {
	const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
	return (
		'Error: unexpected failure: an asynchronous operation failed and nothing handled its error, so the command was stopped.\n' +
		`${detail}\n` +
		'This is a bug in task, not in your input. Re-run the command, and report it with the output of: task cli logs'
	);
}

/**
 * The backend port is async: a promise that is neither awaited nor caught would let the command go on (and exit 0) as if
 * the operation had worked. Node's default would print a raw stack for it; this handler stops the command with exit 1
 * and an actionable message instead. Installed by the CLI entry point only (never by library code or tests).
 */
export function installUnhandledRejectionHandler(proc: RejectionProcess = process): void {
	proc.on('unhandledRejection', reason => {
		proc.stderr.write(describeUnhandledRejection(reason) + '\n');
		proc.exit(1);
	});
}
