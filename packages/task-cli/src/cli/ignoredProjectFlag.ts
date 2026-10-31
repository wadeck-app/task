/**
 * The project flag exactly as the user typed it (`-p x`, `--project x`, `--project=x`), or undefined without one. Looks only before `--`,
 * like the SDK. Call it on arguments that `readProjectOption` already accepted (well-formed, at most one flag).
 */
export function typedProjectFlag(args: readonly string[]): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === '--') return undefined;
		if (arg === '-p' || arg === '--project') return `${arg} ${args[index + 1] ?? ''}`.trimEnd();
		if (arg !== undefined && arg.startsWith('--project=')) return arg;
	}
	return undefined;
}

/** The single stderr line for a valid project flag given to a command that is not scoped to a project. */
export function ignoredProjectFlagNote(typed: string): string {
	return `note: ${typed} ignored: this command is not scoped to a project`;
}
