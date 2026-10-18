import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { registerProject } from '@wadeck-app/task-service';
import type { EventSink, TaskEvent } from '@wadeck-app/task-service';

export interface TestWorld {
	root: string;
	/** The task config dir holding projects.json. */
	configDir: string;
	/** Creates `<root>/<name>/.task/{tasks,config.yml}` and registers it unless `register` is false. */
	createProject(name: string, options?: { register?: boolean; configYml?: string }): string;
	cleanup(): void;
}

/** Disposable config dir + project dirs on disk: the routes run against the real task-core store. */
export function createTestWorld(): TestWorld {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-module-task-'));
	const configDir = path.join(root, 'config');
	return {
		root,
		configDir,
		createProject(name, options = {}) {
			const dir = path.join(root, name);
			fs.mkdirSync(path.join(dir, '.task', 'tasks'), { recursive: true });
			if (options.configYml !== undefined) {
				fs.writeFileSync(path.join(dir, '.task', 'config.yml'), options.configYml);
			}
			if (options.register !== false) registerProject(configDir, dir);
			return dir;
		},
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

export interface RecordingSink extends EventSink {
	events: TaskEvent[];
}

/** Fake EventSink: records instead of spawning `queue push`. */
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
