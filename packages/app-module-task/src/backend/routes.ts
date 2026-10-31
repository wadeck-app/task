import type { ModuleContext } from '@wadeck-app/app-core-sdk';
import { createQueueEventSink, getTaskConfigDir, getTaskLogDir } from '@wadeck-app/task-service';
import type { EventSink } from '@wadeck-app/task-service';

import { registerProjectRoutes } from './routes/projectRoutes.js';
import { registerRelatedRoutes } from './routes/relatedRoutes.js';
import { createRouteKit } from './routes/routeKit.js';
import type { TaskRoutesOptions } from './routes/routeKit.js';
import { registerTaskReadRoutes } from './routes/taskReadRoutes.js';
import { registerTaskWriteRoutes } from './routes/taskWriteRoutes.js';
import { registerDeleteRoutes, registerTypeRoutes } from './routes/typeAndDeleteRoutes.js';

export type { TaskRoutesOptions } from './routes/routeKit.js';

/** What the module keeps running between setup and teardown (app-core hands it to the teardown hook). */
export interface TaskModuleInstance {
	/** Waits for the queue pushes still in flight. */
	flush(): Promise<void>;
}

/**
 * Registers the task routes (`/api/modules/task/...`) on the module context. Returns the module instance, whose `flush`
 * the teardown hook calls. The default queue sink holds ONE SDK publisher for the life of the module (created at the first
 * mutation); each event is sent with the directory of its project as cwd.
 */
export function registerTaskRoutes(ctx: ModuleContext, options: TaskRoutesOptions = {}): TaskModuleInstance {
	const configDir = options.configDir ?? getTaskConfigDir();
	const logDir = getTaskLogDir(configDir);
	const writeStderr = options.writeStderr ?? ((text: string) => void process.stderr.write(text));
	const queueSink =
		options.eventSink === undefined
			? createQueueEventSink({
					getLogDir: () => logDir,
					writeStderr,
					...(options.createPublisher === undefined ? {} : { createPublisher: options.createPublisher }),
				})
			: undefined;
	const eventSink: EventSink = options.eventSink ?? queueSink!;
	// Tell the queue which events this module pushes, once per start. Fire and forget: the routes must not wait for a
	// queue that is slow or absent, and the module must load whatever happens (declareEvents never throws and reports
	// its outcome in the task log; the teardown's flush() waits for it).
	void queueSink?.declareEvents();
	const kit = createRouteKit(ctx, { logDir, writeStderr, eventSink });
	registerProjectRoutes(kit);
	registerRelatedRoutes(kit);
	registerTaskReadRoutes(kit);
	registerTaskWriteRoutes(kit);
	registerTypeRoutes(kit);
	registerDeleteRoutes(kit);
	return { flush: () => eventSink.flush?.() ?? Promise.resolve() };
}
