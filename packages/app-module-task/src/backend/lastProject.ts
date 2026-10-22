// The project a task was last created in, remembered for the New task page. The DSL has no storage a view could use for
// it (no persisted form field, no variable surviving a reload, nav links drop the query), so the module keeps it in its
// own persistent folder (ModuleContext.dataDir), next to nothing else.
import * as fs from 'node:fs';
import * as path from 'node:path';

const FILE_NAME = 'last-project.json';

export interface LastProject {
	/** The remembered project directory; null when none was remembered yet, or the file cannot be used (see `problem`). */
	path: string | null;
	/** Why the file cannot be used, with what to do; null when it is absent or fine. */
	problem: string | null;
}

function fileOf(dataDir: string): string {
	return path.join(dataDir, FILE_NAME);
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Reads the remembered project. An absent file is the normal first state; any other failure is reported, never hidden. */
export function readLastProject(dataDir: string): LastProject {
	const file = fileOf(dataDir);
	let raw: string;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: null, problem: null };
		return { path: null, problem: unusable(file, reasonOf(error)) };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		const remembered = (parsed as { path?: unknown } | null)?.path;
		if (typeof remembered !== 'string' || remembered === '') {
			return { path: null, problem: unusable(file, 'it has no "path" string') };
		}
		return { path: remembered, problem: null };
	} catch (error) {
		return { path: null, problem: unusable(file, reasonOf(error)) };
	}
}

function unusable(file: string, reason: string): string {
	return `${file} cannot be used (${reason}), so no project is preselected on the New task page. Delete it: the next created task writes it again.`;
}

/**
 * Remembers the project a task was just created in. The task exists by then, so a failure here must not fail the
 * request: it is returned as the warning text the view shows (null when remembered).
 */
export function rememberLastProject(dataDir: string, projectPath: string): string | null {
	const file = fileOf(dataDir);
	// Written aside, then renamed: a crash leaves the previous file, never half of a new one.
	const temp = `${file}.${process.pid}.tmp`;
	try {
		fs.mkdirSync(dataDir, { recursive: true });
		fs.writeFileSync(temp, JSON.stringify({ path: projectPath }));
		fs.renameSync(temp, file);
		return null;
	} catch (error) {
		return `The project of this task could not be remembered for the New task page (${reasonOf(error)}). Check that ${dataDir} is writable.`;
	}
}
