import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	addProject as addSharedProject,
	defaultRegistryDir,
	projectToolDir,
	removeProject,
} from '@wadeck-app/project-sdk';
import type { Project } from '@wadeck-app/project-sdk';
import type { EventSink, TaskEvent } from '@wadeck-app/task-service';

export interface TestWorld {
	root: string;
	/** The task config dir of the module (logs). It holds no project list: the shared registry is the only one. */
	configDir: string;
	/**
	 * Makes `<root>/<name>` (a plain folder, nothing in it), registers it in the shared registry under that name (the registry
	 * lowercases names: give lowercase, unique ones) and returns the registry ID of the project, which is what `?project=` and the page
	 * addresses take. `configYml` becomes the project's own task config in the registry. The folder is `dirOf(id)`.
	 */
	createProject(name: string, options?: { configYml?: string }): Promise<string>;
	/** The main folder of a project made by `createProject`. */
	dirOf(id: string): string;
	/** Where the registry keeps the task files of the project (`tasks/`, `task-index.json`). */
	dataDirOf(id: string): string;
	/**
	 * Makes the plain folder `<root>/<name>` and registers nothing (register it afterwards with `registerShared`). Returns the folder.
	 */
	createFolder(name: string): string;
	/** Makes the project unreadable: its own task config in the registry is invalid YAML (every read of it fails with the file named). */
	breakConfig(id: string): void;
	/** Removes a project from the shared registry with the SDK's own mutation (what `project remove` does). */
	unregister(ref: string): Promise<void>;
	/** The shared project registry of this world (XDG_CONFIG_HOME points at it until cleanup): the module reads it at every request. */
	registryDir: string;
	/** Registers a project in the shared registry with the SDK's own mutation (`dir` omitted: a virtual project). */
	registerShared(name: string, dir?: string, aliases?: string[]): Promise<Project>;
	cleanup(): void;
}

/** Disposable config dir + project dirs on disk: the routes run against the real task-core store. */
export function createTestWorld(): TestWorld {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-module-task-'));
	const configDir = path.join(root, 'config');
	// The module reads the shared registry from $XDG_CONFIG_HOME/project at every call: this world gets its own, restored by cleanup.
	const previousXdg = process.env['XDG_CONFIG_HOME'];
	process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg');
	const registryDir = defaultRegistryDir(process.env);
	const dirs = new Map<string, string>();
	const registerShared: TestWorld['registerShared'] = (name, dir, aliases = []) =>
		addSharedProject(registryDir, { name, aliases, ...(dir === undefined ? {} : { path: dir }) });
	return {
		root,
		configDir,
		registryDir,
		registerShared,
		async createProject(name, options = {}) {
			const dir = path.join(root, name);
			fs.mkdirSync(dir, { recursive: true });
			const project = await registerShared(name, dir);
			dirs.set(project.id, dir);
			if (options.configYml !== undefined) {
				const configFolder = projectToolDir(registryDir, project.id, 'task', 'config');
				fs.mkdirSync(configFolder, { recursive: true });
				fs.writeFileSync(path.join(configFolder, 'config.yml'), options.configYml);
			}
			return project.id;
		},
		dirOf(id) {
			const dir = dirs.get(id);
			if (dir === undefined) throw new Error(`test fixture: no project ${id} was made by createProject`);
			return dir;
		},
		dataDirOf: id => projectToolDir(registryDir, id, 'task', 'data'),
		breakConfig(id) {
			const configFolder = projectToolDir(registryDir, id, 'task', 'config');
			fs.mkdirSync(configFolder, { recursive: true });
			fs.writeFileSync(path.join(configFolder, 'config.yml'), 'statuses: [unclosed');
		},
		async unregister(ref) {
			await removeProject(registryDir, ref, { recursive: false });
		},
		createFolder(name) {
			const dir = path.join(root, name);
			fs.mkdirSync(dir, { recursive: true });
			return dir;
		},
		cleanup: () => {
			if (previousXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
			else process.env['XDG_CONFIG_HOME'] = previousXdg;
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

export interface RecordingSink extends EventSink {
	events: TaskEvent[];
}

/** Fake EventSink: records instead of publishing to the queue. */
export function createRecordingSink(): RecordingSink {
	const events: TaskEvent[] = [];
	return {
		events,
		deliver(event) {
			events.push(event);
			return Promise.resolve({ delivered: true });
		},
	};
}
