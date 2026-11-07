import type { TaskRecord } from '@wadeck-app/task-core';

import { projectEnv, type TaskServiceContext } from './context.js';
import { InvalidTaskTextError } from './errors.js';
import type { TaskEvent } from './events.js';
import { splitHeadline, taskDescription } from './taskText.js';

export interface CreateTaskInput {
	/** The headline. Alone it is the single text of the task (split when long, see {@link splitHeadline}). */
	title?: string;
	/**
	 * The body. With a `title` it is stored as given (it wins over any split); alone it is the single text, like `title`
	 * alone (the input of callers that only know a description: the module's `POST /tasks {description}`, flows).
	 */
	description?: string;
	/** Parent task id or unambiguous prefix. */
	parent?: string;
}

export interface CreateTaskResult {
	task: TaskRecord;
	events: TaskEvent[];
}

function isBlank(text: string | undefined): boolean {
	return text === undefined || text.trim() === '';
}

/** The title and description to store for the input: an explicit pair as given, a single text split when long. */
function textsToStore(input: CreateTaskInput): { title: string; description?: string } {
	if (isBlank(input.title) && isBlank(input.description)) {
		throw new InvalidTaskTextError(
			'a task needs a title or a description',
			'Give the text of the task: task new "<title>" [--description <text>]'
		);
	}
	if (isBlank(input.title) !== isBlank(input.description)) {
		return splitHeadline((isBlank(input.title) ? input.description : input.title)!);
	}
	return { title: input.title!, description: input.description! };
}

/**
 * Creates a task in the configured default status, optionally under a parent.
 * The description is stored only when it differs from the title. A single long text becomes a headline (title) plus the
 * full text (description); an explicit title and description are never reshaped.
 */
export function createTask(ctx: TaskServiceContext, input: CreateTaskInput): CreateTaskResult {
	const { title, description } = textsToStore(input);
	const parentId = input.parent === undefined ? undefined : ctx.store.findByPrefix(input.parent).id;
	const task = ctx.store.create(title, ctx.config.defaultStatus, parentId, description);
	return {
		task,
		events: [
			{
				name: 'onTaskCreated',
				payload: {
					taskId: task.id,
					status: task.status,
					// The full text, as before the split existed: subscribers reading it keep working.
					description: taskDescription(task),
					parentId: task.parentId,
					type: task.type,
					labels: task.labels ?? [],
					...projectEnv(ctx),
				},
			},
		],
	};
}
