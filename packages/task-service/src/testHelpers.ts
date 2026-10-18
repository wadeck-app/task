import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TaskStore } from '@wadeck-app/task-core';
import type { TaskResolvedConfig } from '@wadeck-app/task-core';

import type { TaskServiceContext } from './context.js';

export interface TestContext {
	ctx: TaskServiceContext;
	rootDir: string;
	cleanup: () => void;
}

const DEFAULT_TEST_CONFIG: TaskResolvedConfig = {
	statuses: ['backlog', 'in-progress', 'done'],
	defaultStatus: 'backlog',
	terminalStatuses: ['done'],
	types: [],
	defaults: { priority: 'medium' },
	globalHooks: {},
	projectHooks: {},
};

/** Builds a context over a disposable `<tmp>/.task/tasks` store (index lives next to it, inside the tmp root). */
export function createTestContext(configOverrides: Partial<TaskResolvedConfig> = {}): TestContext {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-'));
	const tasksDir = path.join(rootDir, '.task', 'tasks');
	fs.mkdirSync(tasksDir, { recursive: true });
	return {
		ctx: {
			store: new TaskStore(tasksDir),
			config: { ...DEFAULT_TEST_CONFIG, ...configOverrides },
			project: { name: 'proj', path: rootDir },
		},
		rootDir,
		cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }),
	};
}
