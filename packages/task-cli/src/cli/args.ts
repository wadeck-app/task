export interface ParsedArgs {
	/** `--config <dir>`: global config directory. */
	configDir: string | undefined;
	/** `-p` / `--project <ref>`: a project of the shared registry (name, alias or id; never a path). */
	projectRef: string | undefined;
	/** `--project-dir <dir>`: project directory override (deprecated, see the shared registry). */
	projectDir: string | undefined;
	jsonMode: boolean;
	command: string | undefined;
	/** Arguments after the command, without `-p <ref>`, `--project-dir <dir>` and `--json`. */
	rest: string[];
}

/** Splits the global flags (before or after the command) from the command and its own arguments. */
export function parseArgs(args: string[]): ParsedArgs {
	let i = 0;
	let configDir: string | undefined;
	let projectDir: string | undefined;
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

	// Filter -p <ref>, --project-dir <path> and --json from rest args
	const rest: string[] = [];
	for (let j = 0; j < trailing.length; j++) {
		if (trailing[j] === '--project-dir' && trailing[j + 1] !== undefined) {
			projectDir = trailing[j + 1]!;
			j++;
		} else if ((trailing[j] === '-p' || trailing[j] === '--project') && trailing[j + 1] !== undefined) {
			projectRef = trailing[j + 1]!;
			j++;
		} else if (trailing[j] === '--json') {
			jsonMode = true;
		} else {
			rest.push(trailing[j]!);
		}
	}

	return { configDir, projectDir, projectRef, jsonMode, command, rest };
}
