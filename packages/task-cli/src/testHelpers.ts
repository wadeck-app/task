import * as fs from 'node:fs';
import * as path from 'node:path';

/** What `task init` used to write as `.task/config.yml` (statuses with `done` terminal): fixtures of LEGACY projects keep it. */
const LEGACY_CONFIG_TEMPLATE = `# Task configuration for this project

statuses:
  - backlog
  - in-progress
  - name: done
    terminal: true
`;

/**
 * Fixture of a LEGACY project (a folder holding a `.task`, in no shared registry): `task init` no longer exists, so tests create
 * the folder structure by hand. Creates `dir`, `.task/tasks` and the config template. Does NOT touch projects.json.
 */
export function initLegacyProject(dir: string): string {
	fs.mkdirSync(path.join(dir, '.task', 'tasks'), { recursive: true });
	fs.writeFileSync(path.join(dir, '.task', 'config.yml'), LEGACY_CONFIG_TEMPLATE);
	return dir;
}

/**
 * Fixture of the legacy list: appends `dir` to `<task config dir>/projects.json` (the file `task init` used to write and that task
 * now only reads). `configDir` is `ConfigDir.get('task')`, i.e. `$XDG_CONFIG_HOME/task` in tests.
 */
export function addLegacyListEntry(configDir: string, dir: string): void {
	const file = path.join(configDir, 'projects.json');
	const entries: string[] = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as string[]) : [];
	const resolved = path.resolve(dir);
	if (!entries.some(entry => path.resolve(entry).toLowerCase() === resolved.toLowerCase())) entries.push(resolved);
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(file, JSON.stringify(entries, null, 2) + '\n');
}

/** A legacy project that is also in the legacy list, like a project initialised by `task init` before stage 2a. */
export function initListedLegacyProject(dir: string, configDir: string): string {
	initLegacyProject(dir);
	addLegacyListEntry(configDir, dir);
	return dir;
}
