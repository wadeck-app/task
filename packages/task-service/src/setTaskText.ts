import { projectEnv, type TaskServiceContext } from './context.js';
import { InvalidTaskTextError } from './errors.js';
import type { TaskEvent } from './events.js';
import type { TaskChangeResult } from './taskFields.js';
import { taskDescription } from './taskText.js';

export interface SetTaskTextInput {
	/** Task id or unambiguous prefix. */
	id: string;
	/** New headline; must not be blank. */
	title?: string;
	/** New body. Empty clears it: the body is the title again. */
	description?: string;
}

/**
 * Edits the title and/or the description of a task. One `onTaskTextChanged` per field that really changed (title first):
 * for the description, `oldValue` is absent when the task had no description of its own and `newValue` is empty when it was cleared.
 * A title change rewrites the index entry. Setting a description equal to the title is the same as having none.
 */
export function setTaskText(ctx: TaskServiceContext, input: SetTaskTextInput): TaskChangeResult {
	if (input.title === undefined && input.description === undefined) {
		throw new InvalidTaskTextError(
			'nothing to change: give a title and/or a description',
			'Use: task set-title <id> <text> or task set-description <id> <text>'
		);
	}
	if (input.title !== undefined && input.title.trim() === '') {
		throw new InvalidTaskTextError(
			'a title cannot be blank',
			'Give the new title, or use set-description to change the body only.'
		);
	}
	const events: TaskEvent[] = [];
	let task = ctx.store.findByPrefix(input.id);
	if (input.title !== undefined && input.title !== task.title) {
		const oldValue = task.title;
		task = ctx.store.setTitle(task.id, input.title);
		events.push({
			name: 'onTaskTextChanged',
			payload: { taskId: task.id, field: 'title', oldValue, newValue: input.title, ...projectEnv(ctx) },
		});
	}
	if (input.description !== undefined) {
		const newDescription = input.description.trim() === '' ? '' : input.description;
		const newBody = newDescription === '' ? task.title : newDescription;
		if (newBody !== taskDescription(task)) {
			const oldValue = task.description;
			task = ctx.store.setDescription(task.id, newDescription);
			events.push({
				name: 'onTaskTextChanged',
				payload: {
					taskId: task.id,
					field: 'description',
					oldValue,
					newValue: newDescription,
					...projectEnv(ctx),
				},
			});
		}
	}
	return { task, events };
}
