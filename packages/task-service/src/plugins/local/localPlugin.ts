// The built-in strategy `local` (plugins.local.default, alias local): the task files and the index in the project's data folder
// of the shared registry, behind the async port. The default of every project; the reference the other backends are compared to.
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLocalBackend, LOCAL_CAPABILITIES, LOCAL_TRAITS } from '@wadeck-app/task-core';

import type { CheckLine, StrategyContext, StrategyInstance, StrategyPlugin } from '../kinds.js';

/** The nearest folder that exists above (or at) `dir`, and what blocks the way when something that is not a folder is in it. */
function nearestExisting(dir: string): { existing: string } | { blocker: string } {
	let current = dir;
	for (;;) {
		let stat: fs.Stats | undefined;
		try {
			stat = fs.statSync(current);
		} catch {
			stat = undefined;
		}
		if (stat?.isDirectory() === true) return { existing: current };
		if (stat !== undefined) return { blocker: current };
		const parent = path.dirname(current);
		// The root of the volume is reached without finding a folder: nothing can be created.
		if (parent === current) return { blocker: current };
		current = parent;
	}
}

function dataLines(dataDir: string): CheckLine[] {
	const where = nearestExisting(dataDir);
	if ('blocker' in where) {
		return [
			{ name: 'data', status: 'error', text: `${dataDir} cannot exist: ${where.blocker} is not a folder` },
			{
				name: 'writable',
				status: 'error',
				text: `${where.blocker} is in the way of ${dataDir}`,
				fix: `${where.blocker} is not a folder: move it away, or fix the project's data location in the shared registry (project CLI)`,
			},
		];
	}
	const created = where.existing === dataDir;
	const dataLine: CheckLine = {
		name: 'data',
		status: 'ok',
		text: created ? dataDir : `${dataDir} (not created yet: the first write creates it)`,
	};
	try {
		fs.accessSync(where.existing, fs.constants.W_OK);
	} catch (error) {
		return [
			dataLine,
			{
				name: 'writable',
				status: 'error',
				text: `${where.existing} is not writable (${error instanceof Error ? error.message : String(error)})`,
				fix: `Give your user write access to ${where.existing}`,
			},
		];
	}
	return [dataLine, { name: 'writable', status: 'ok', text: `${where.existing} is writable` }];
}

async function countLine(instance: StrategyInstance['backend'], dataDir: string): Promise<CheckLine> {
	try {
		const tasks = await instance.list();
		const byStatus = new Map<string, number>();
		for (const task of tasks) byStatus.set(task.status, (byStatus.get(task.status) ?? 0) + 1);
		const detail = [...byStatus]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([status, count]) => `${status} ${count}`)
			.join(', ');
		return {
			name: 'tasks',
			status: 'ok',
			text: tasks.length === 0 ? '0 tasks' : `${tasks.length} task${tasks.length === 1 ? '' : 's'} (${detail})`,
		};
	} catch (error) {
		return {
			name: 'tasks',
			status: 'error',
			text: `the tasks cannot be read: ${error instanceof Error ? error.message : String(error)}`,
			fix: `Fix or restore ${path.join(dataDir, 'task-index.json')} and the files in ${path.join(dataDir, 'tasks')} named in the message`,
		};
	}
}

export const localPlugin: StrategyPlugin = {
	extensionPoint: 'strategy',
	backendKind: 'local',
	capabilities: LOCAL_CAPABILITIES,
	// Everything is native: no fill applies.
	fillTechniques: {},
	traitsFor: () => LOCAL_TRAITS,

	validate(options) {
		const [first] = Object.keys(options);
		return first === undefined
			? undefined
			: `${first}: unknown option for strategy "local" (it takes no option: the data lives in the shared project registry)`;
	},

	describe() {
		return {
			summary: 'Task files and an index in the project folder of the shared project registry (the default).',
			options: {},
			snippet: 'strategy:\n    type: local',
		};
	},

	create(_options, context: StrategyContext) {
		const backend = createLocalBackend(context.tasksDir, {
			writeFile: context.writeFile,
			...(context.priorities === undefined ? {} : { priorities: context.priorities }),
		});
		const instance: StrategyInstance = {
			backend,
			describe: () => [`data: ${context.dataDir}`],
			check: async () => [...dataLines(context.dataDir), await countLine(backend, context.dataDir)],
			dispose: () => Promise.resolve(),
		};
		return Promise.resolve(instance);
	},
};
