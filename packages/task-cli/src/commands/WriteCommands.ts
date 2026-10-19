// Task commands that change a task: new, set-status, link/unlink, set-type, add-label, remove-label, set-parent, remove-parent, set-meta.
import {
	InvalidStatusError,
	addLabel,
	createTask,
	deliverEvents,
	linkTasks,
	removeLabel,
	removeParent,
	setMeta,
	setParent,
	setStatus,
	setType,
	unlinkTasks,
} from '@wadeck-app/task-service';
import type { CreateTaskResult, LinkTasksResult, SetStatusResult, TaskServiceContext } from '@wadeck-app/task-service';

import type { ProjectCommand } from '../cli/env.js';
import { errorOutput, failure, jsonResult, runJson, taskLine } from '../cli/output.js';

const NEW_USAGE = 'Usage: task new <description> [--parent <id>]';

/** A command taking exactly two positional arguments and printing the task the use case returns. */
function twoArgsCommand(
	usage: string,
	useCase: (ctx: TaskServiceContext, first: string, second: string) => unknown
): ProjectCommand {
	return (rest, { jsonMode, ctx }) => {
		const [first, second] = rest;
		if (!first || !second) {
			return errorOutput(jsonMode, 'missing arguments', usage);
		}
		return runJson(jsonMode, () => useCase(ctx, first, second));
	};
}

export const runNew: ProjectCommand = async (rest, { jsonMode, ctx, eventSink }) => {
	let description: string | undefined;
	let parentArg: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]!;
		if (arg === '--parent') {
			parentArg = rest[i + 1];
			if (!parentArg) {
				return errorOutput(jsonMode, '--parent requires a task id', NEW_USAGE);
			}
			i++;
		} else if (arg.startsWith('--')) {
			return errorOutput(jsonMode, `unknown flag: ${arg}`, NEW_USAGE);
		} else if (description === undefined) {
			description = arg;
		}
	}
	if (!description) {
		return errorOutput(jsonMode, 'missing description', NEW_USAGE);
	}
	let created: CreateTaskResult;
	try {
		created = createTask(ctx, { description, parent: parentArg });
	} catch (error) {
		return failure(jsonMode, error);
	}
	await deliverEvents(eventSink, created.events);
	return jsonResult(created.task);
};

/** The warning for a task closed while still blocked, printed on stderr. */
function openBlockersWarning(result: SetStatusResult): string {
	const lines = result.openBlockers.map(taskLine);
	return `Warning: task ${result.task.id} is now ${result.task.status} but still blocked by ${result.openBlockers.length} open task(s):\n${lines.join('\n')}\n`;
}

export const runSetStatus: ProjectCommand = async (rest, { jsonMode, ctx, eventSink }) => {
	const [id, status] = rest;
	if (!id || !status) {
		return errorOutput(jsonMode, 'missing arguments', 'Usage: task set-status <id> <status>');
	}
	let result: SetStatusResult;
	try {
		result = setStatus(ctx, { id, status });
	} catch (error) {
		// Machine readers get the valid values in the message itself (the hint line is not part of the JSON).
		if (error instanceof InvalidStatusError && jsonMode) {
			return errorOutput(jsonMode, `${error.message}. Valid statuses: ${error.validStatuses.join(', ')}`);
		}
		return failure(jsonMode, error);
	}
	// The status change is delivered before the open-blocker warning, the unblocked events after it.
	const [statusChange, ...unblockedEvents] = result.events;
	await deliverEvents(eventSink, [statusChange!]);
	if (result.openBlockers.length > 0) {
		process.stderr.write(openBlockersWarning(result));
	}
	await deliverEvents(eventSink, unblockedEvents);
	return jsonResult(result.task);
};

export const runLink: ProjectCommand = async (rest, { command, jsonMode, ctx, eventSink }) => {
	const [id, type, target] = rest;
	if (!id || !type || !target) {
		return errorOutput(jsonMode, 'missing arguments', `Usage: task ${command} <id> <type> <target-id>`);
	}
	let result: LinkTasksResult;
	try {
		const input = { id, type, target };
		result = command === 'link' ? linkTasks(ctx, input) : unlinkTasks(ctx, input);
	} catch (error) {
		return failure(jsonMode, error);
	}
	await deliverEvents(eventSink, result.events);
	return jsonResult(result.task);
};

export const runSetType = twoArgsCommand('Usage: task set-type <id> <type>', (ctx, id, type) =>
	setType(ctx, { id, type })
);

export const runAddLabel = twoArgsCommand('Usage: task add-label <id> <label>', (ctx, id, label) =>
	addLabel(ctx, { id, label })
);

export const runRemoveLabel = twoArgsCommand('Usage: task remove-label <id> <label>', (ctx, id, label) =>
	removeLabel(ctx, { id, label })
);

export const runSetParent = twoArgsCommand('Usage: task set-parent <id> <parent-id>', (ctx, id, parent) =>
	setParent(ctx, { id, parent })
);

export const runRemoveParent: ProjectCommand = (rest, { jsonMode, ctx }) => {
	const id = rest[0];
	if (!id) {
		return errorOutput(jsonMode, 'missing id', 'Usage: task remove-parent <id>');
	}
	return runJson(jsonMode, () => removeParent(ctx, { id }));
};

export const runSetMeta: ProjectCommand = (rest, { jsonMode, ctx }) => {
	const [id, key, value] = rest;
	// An empty value is valid (`task set-meta <id> <key> ""`).
	if (!id || !key || value === undefined) {
		return errorOutput(jsonMode, 'missing arguments', 'Usage: task set-meta <id> <key> <value>');
	}
	return runJson(jsonMode, () => setMeta(ctx, { id, key, value }));
};
