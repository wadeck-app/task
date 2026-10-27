// Task commands that change a task: new, set-status, link/unlink, set-type, add-label, remove-label, set-parent, remove-parent, set-meta.
import {
	ALL_LINK_NAMES,
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
import type {
	CreateTaskResult,
	EventSink,
	LinkTasksResult,
	SetStatusResult,
	TaskChangeResult,
	TaskServiceContext,
} from '@wadeck-app/task-service';

import type { ProjectCommand } from '../cli/env.js';
import { errorOutput, failure, jsonResult, taskLine } from '../cli/output.js';
import type { CommandResult } from '../cli/output.js';

const NEW_USAGE = 'Usage: task new <description> [--parent <id>]';

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
		return errorOutput(
			jsonMode,
			'missing arguments',
			`Usage: task ${command} <id> <type> <target-id>
Types: ${ALL_LINK_NAMES.join(', ')} (an inverse name such as blocks acts on the other task)`
		);
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

/** Runs a use case that returns events, delivers them once the change is saved, prints the task. */
async function changeOutput(
	jsonMode: boolean,
	eventSink: EventSink,
	useCase: () => TaskChangeResult
): Promise<CommandResult> {
	let result: TaskChangeResult;
	try {
		result = useCase();
	} catch (error) {
		return failure(jsonMode, error);
	}
	await deliverEvents(eventSink, result.events);
	return jsonResult(result.task);
}

/** A command taking exactly two positional arguments, running a use case that returns events and printing the task. */
function twoArgsChangeCommand(
	usage: string,
	useCase: (ctx: TaskServiceContext, first: string, second: string) => TaskChangeResult
): ProjectCommand {
	return (rest, { jsonMode, ctx, eventSink }) => {
		const [first, second] = rest;
		if (!first || !second) {
			return errorOutput(jsonMode, 'missing arguments', usage);
		}
		return changeOutput(jsonMode, eventSink, () => useCase(ctx, first, second));
	};
}

export const runSetType = twoArgsChangeCommand('Usage: task set-type <id> <type>', (ctx, id, type) =>
	setType(ctx, { id, type })
);

export const runAddLabel = twoArgsChangeCommand('Usage: task add-label <id> <label>', (ctx, id, label) =>
	addLabel(ctx, { id, label })
);

export const runRemoveLabel = twoArgsChangeCommand('Usage: task remove-label <id> <label>', (ctx, id, label) =>
	removeLabel(ctx, { id, label })
);

export const runSetParent = twoArgsChangeCommand('Usage: task set-parent <id> <parent-id>', (ctx, id, parent) =>
	setParent(ctx, { id, parent })
);

export const runRemoveParent: ProjectCommand = (rest, { jsonMode, ctx, eventSink }) => {
	const id = rest[0];
	if (!id) {
		return errorOutput(jsonMode, 'missing id', 'Usage: task remove-parent <id>');
	}
	return changeOutput(jsonMode, eventSink, () => removeParent(ctx, { id }));
};

export const runSetMeta: ProjectCommand = async (rest, { jsonMode, ctx, eventSink }) => {
	const [id, key, value] = rest;
	// An empty value is valid (`task set-meta <id> <key> ""`).
	if (!id || !key || value === undefined) {
		return errorOutput(jsonMode, 'missing arguments', 'Usage: task set-meta <id> <key> <value>');
	}
	return changeOutput(jsonMode, eventSink, () => setMeta(ctx, { id, key, value }));
};
