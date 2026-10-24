import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { addProject as addSharedProject, defaultRegistryDir } from '@wadeck-app/project-sdk';
import type { Project } from '@wadeck-app/project-sdk';
import { registerProject } from '@wadeck-app/task-service';
import type { EventSink, TaskEvent } from '@wadeck-app/task-service';

export interface TestWorld {
	root: string;
	/** The task config dir holding projects.json. */
	configDir: string;
	/** Creates `<root>/<name>/.task/{tasks,config.yml}` and registers it unless `register` is false. */
	createProject(name: string, options?: { register?: boolean; configYml?: string }): string;
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
	return {
		root,
		configDir,
		registryDir,
		registerShared: (name, dir, aliases = []) =>
			addSharedProject(registryDir, { name, aliases, ...(dir === undefined ? {} : { path: dir }) }),
		createProject(name, options = {}) {
			const dir = path.join(root, name);
			fs.mkdirSync(path.join(dir, '.task', 'tasks'), { recursive: true });
			if (options.configYml !== undefined) {
				fs.writeFileSync(path.join(dir, '.task', 'config.yml'), options.configYml);
			}
			if (options.register !== false) registerProject(configDir, dir);
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
