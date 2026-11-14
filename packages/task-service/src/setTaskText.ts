import type { TaskRecord } from '@wadeck-app/task-core';

import { projectEnv, type TaskServiceContext } from './context.js';
import { InvalidTaskTextError } from './errors.js';
import type { TaskEvent } from './events.js';
import { plain } from './plainRecord.js';
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
export async function setTaskText(ctx: TaskServiceContext, input: SetTaskTextInput): Promise<TaskChangeResult> {
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
	// The fields are enough to decide what changes; the whole record is read only when nothing is written (it is then the answer).
	const before = await ctx.store.resolve(input.id);
	let task: TaskRecord | undefined;
	if (input.title !== undefined && input.title !== before.title) {
		const oldValue = before.title;
		task = plain(await ctx.store.setTitle(before.id, input.title));
		events.push({
			name: 'onTaskTextChanged',
			payload: { taskId: task.id, field: 'title', oldValue, newValue: input.title, ...projectEnv(ctx) },
		});
	}
	if (input.description !== undefined) {
		const newDescription = input.description.trim() === '' ? '' : input.description;
		// The title as it is now: the written one when the title changed above.
		const current = task ?? before;
		const newBody = newDescription === '' ? current.title : newDescription;
		if (newBody !== taskDescription(current)) {
			const oldValue = current.description;
			task = plain(await ctx.store.setDescription(before.id, newDescription));
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
	return { task: task ?? plain(await ctx.store.get(before.id)), events };
}
