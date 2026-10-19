import type { EventSink, TaskServiceContext } from '@wadeck-app/task-service';

import type { CommandResult } from './output.js';

/** What a command that works on a project receives: the project context and where its events go. */
export interface CommandEnv {
	/** The command word as typed (`link` and `unlink` share a handler). */
	command: string;
	jsonMode: boolean;
	ctx: TaskServiceContext;
	eventSink: EventSink;
}

/** A command over an initialized project: its arguments (after the command word) and the environment. */
export type ProjectCommand = (rest: string[], env: CommandEnv) => CommandResult | Promise<CommandResult>;
