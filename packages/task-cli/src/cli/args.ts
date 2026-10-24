export interface ParsedArgs {
	/** `--config <dir>`: global config directory. */
	configDir: string | undefined;
	/** `-p` / `--project <ref>`: a project of the shared registry (name, alias or id; never a path). */
	projectRef: string | undefined;
	jsonMode: boolean;
	command: string | undefined;
	/** Arguments after the command, without `-p <ref>` and `--json`. */
	rest: string[];
}

/** Splits the global flags (before or after the command) from the command and its own arguments. */
export function parseArgs(args: string[]): ParsedArgs {
	let i = 0;
	let configDir: string | undefined;
	let projectRef: string | undefined;
	let jsonMode = false;

	while (i < args.length) {
		if (args[i] === '--config' && args[i + 1] !== undefined) {
			configDir = args[i + 1]!;
			i += 2;
		} else if ((args[i] === '-p' || args[i] === '--project') && args[i + 1] !== undefined) {
			projectRef = args[i + 1]!;
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

	// Filter -p <ref> and --json from rest args
	const rest: string[] = [];
	for (let j = 0; j < trailing.length; j++) {
		if ((trailing[j] === '-p' || trailing[j] === '--project') && trailing[j + 1] !== undefined) {
			projectRef = trailing[j + 1]!;
			j++;
		} else if (trailing[j] === '--json') {
			jsonMode = true;
		} else {
			rest.push(trailing[j]!);
		}
	}

	return { configDir, projectRef, jsonMode, command, rest };
}

/**
 * `--project-dir <dir>` was removed (stage 2b): a project is named with `-p <id|name|alias>` or found from a registered cwd.
 * True when it is typed anywhere (`--project-dir x`, `--project-dir=x`, a bare `--project-dir`): the caller refuses loudly
 * instead of letting it be taken for an argument of the command.
 */
export function usesRemovedProjectDir(args: readonly string[]): boolean {
	return args.some(arg => arg === '--project-dir' || arg.startsWith('--project-dir='));
}
