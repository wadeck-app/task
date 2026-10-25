import * as fs from 'node:fs';
import * as path from 'node:path';
import { addProject, defaultRegistryDir, LabelTakenError, type Project } from '@wadeck-app/project-sdk';
import { ownConfigFile, resolveProject, type TaskStorage } from '@wadeck-app/task-service';

/** A project config with statuses (`done` terminal): fixtures use it so status/terminal assertions hold. */
const TEMPLATE_CONFIG = `# Task configuration for this project

statuses:
  - backlog
  - in-progress
  - name: done
    terminal: true
`;

export interface RegisteredTestProject {
	/** The folder that was registered (as given). */
	dir: string;
	/** The (unique, lowercase) registry name. */
	name: string;
	/** The registry id. */
	id: string;
	/** Where the project's tasks and index live (the registry data dir). */
	storage: TaskStorage;
	/** `<dataDir>/tasks`. */
	tasksDir: string;
}

export interface RegisterTestProjectOptions {
	/** Registry name; default: the lowercased basename of `dir`, made unique when already taken. */
	name?: string;
	/** Write the template config (default true). false: the project has no own config layer. */
	config?: boolean;
}

/**
 * Fixture of a project: creates `dir`, registers it in the (sandbox) shared registry with a unique name and writes the template
 * config into the project's own registry config layer. Tasks then live in the registry data dir (`result.tasksDir`), not in `dir`.
 */
export async function registerTestProject(
	dir: string,
	options: RegisterTestProjectOptions = {}
): Promise<RegisteredTestProject> {
	fs.mkdirSync(dir, { recursive: true });
	const registryDir = defaultRegistryDir(process.env);
	const base = (options.name ?? path.basename(dir)).toLowerCase();
	// The registry persists across the tests of one file: a taken name gets a numeric suffix (unless the name was asked for).
	let name = base;
	let added: Project | undefined;
	for (let attempt = 1; added === undefined; attempt++) {
		try {
			added = await addProject(registryDir, { name, path: dir });
		} catch (error) {
			if (!(error instanceof LabelTakenError) || options.name !== undefined || attempt > 50) throw error;
			name = `${base}-${attempt}`;
		}
	}
	const { storage } = resolveProject({ cwd: dir, projectRef: added.id });
	if (options.config !== false) {
		const file = ownConfigFile(storage);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, TEMPLATE_CONFIG);
	}
	return { dir, name, id: added.id, storage, tasksDir: path.join(storage.dataDir, 'tasks') };
}
