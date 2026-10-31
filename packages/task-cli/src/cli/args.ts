export interface ParsedArgs {
	/** `--config <dir>`: global config directory. */
	configDir: string | undefined;
	jsonMode: boolean;
	command: string | undefined;
	/** Arguments after the command, without `--json`. The project flag is taken out beforehand (`readProjectOption` of task-service). */
	rest: string[];
}

/** Splits the global flags (before or after the command) from the command and its own arguments. The project flag is not read here: see `readProjectOption`. */
export function parseArgs(args: string[]): ParsedArgs {
	let i = 0;
	let configDir: string | undefined;
	let jsonMode = false;

	while (i < args.length) {
		if (args[i] === '--config' && args[i + 1] !== undefined) {
			configDir = args[i + 1]!;
			i += 2;
		} else if (args[i] === '--json') {
			jsonMode = true;
			i++;
		} else {
			break;
		}
	}

	const command = args[i];
	const trailing = args.slice(i + 1);

	// Filter --json from rest args
	const rest: string[] = [];
	for (let j = 0; j < trailing.length; j++) {
		if (trailing[j] === '--json') {
			jsonMode = true;
		} else {
			rest.push(trailing[j]!);
		}
	}

	return { configDir, jsonMode, command, rest };
}

/**
 * `--project-dir` is not an option: a project is named with `-p <id|name|alias>` or found from a registered cwd.
 * True when it is typed anywhere (`--project-dir x`, `--project-dir=x`, a bare `--project-dir`): the caller refuses loudly
 * instead of letting it be taken for an argument of the command.
 */
export function usesProjectDirOption(args: readonly string[]): boolean {
	return args.some(arg => arg === '--project-dir' || arg.startsWith('--project-dir='));
}
