// The project a task was last created in, remembered for the New task page by its registry ID. The DSL has no storage a view
// could use for it (no persisted form field, no variable surviving a reload, nav links drop the query), so the module keeps it in
// its own persistent folder (ModuleContext.dataDir), next to nothing else.
import * as fs from 'node:fs';
import * as path from 'node:path';

const FILE_NAME = 'last-project.json';

export interface LastProject {
	/** The remembered project (registry id); null when none was remembered yet, the file is in the old format, or it cannot be used (see `problem`). */
	id: string | null;
	/** Why the file cannot be used, with what to do; null when it is absent or fine (an old-format file is not a problem, see `onOldFormat`). */
	problem: string | null;
}

function fileOf(dataDir: string): string {
	return path.join(dataDir, FILE_NAME);
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the remembered project. An absent file is the normal first state; any other failure is reported, never hidden. A file of
 * the old format (`{ "path": ... }`, before the shared registry) names a project by directory: it is ignored, and `onOldFormat`
 * is told (the next created task writes the new format).
 */
export function readLastProject(
	dataDir: string,
	onOldFormat: (message: string) => void = () => undefined
): LastProject {
	const file = fileOf(dataDir);
	let raw: string;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { id: null, problem: null };
		return { id: null, problem: unusable(file, reasonOf(error)) };
	}
	try {
		const parsed = JSON.parse(raw) as { id?: unknown; path?: unknown } | null;
		if (typeof parsed?.id === 'string' && parsed.id !== '') return { id: parsed.id, problem: null };
		if (typeof parsed?.path === 'string') {
			onOldFormat(
				`${file} is in the old format (it names a project by directory: ${parsed.path}): ignored, no project is preselected on the New task page until the next task is created`
			);
			return { id: null, problem: null };
		}
		return { id: null, problem: unusable(file, 'it has no "id" string') };
	} catch (error) {
		return { id: null, problem: unusable(file, reasonOf(error)) };
	}
}

function unusable(file: string, reason: string): string {
	return `${file} cannot be used (${reason}), so no project is preselected on the New task page. Delete it: the next created task writes it again.`;
}

/**
 * Remembers the project a task was just created in. The task exists by then, so a failure here must not fail the
 * request: it is returned as the warning text the view shows (null when remembered).
 */
export function rememberLastProject(dataDir: string, projectId: string): string | null {
	const file = fileOf(dataDir);
	// Written aside, then renamed: a crash leaves the previous file, never half of a new one.
	const temp = `${file}.${process.pid}.tmp`;
	try {
		fs.mkdirSync(dataDir, { recursive: true });
		fs.writeFileSync(temp, JSON.stringify({ id: projectId }));
		fs.renameSync(temp, file);
		return null;
	} catch (error) {
		return `The project of this task could not be remembered for the New task page (${reasonOf(error)}). Check that ${dataDir} is writable.`;
	}
}
