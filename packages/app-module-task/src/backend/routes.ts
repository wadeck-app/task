import type { ModuleContext } from '@wadeck-app/app-core-sdk';
import { createQueueEventSink, getTaskConfigDir, getTaskLogDir } from '@wadeck-app/task-service';

import { registerProjectManageRoutes } from './routes/projectManageRoutes.js';
import { registerProjectRoutes } from './routes/projectRoutes.js';
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
	const eventSink =
		options.eventSink ??
		createQueueEventSink({
			getLogDir: () => logDir,
			writeStderr,
			...(options.createPublisher === undefined ? {} : { createPublisher: options.createPublisher }),
		});
	const kit = createRouteKit(ctx, { configDir, logDir, writeStderr, eventSink });
	registerProjectRoutes(kit);
	registerProjectManageRoutes(kit);
	registerTaskReadRoutes(kit);
	registerTaskWriteRoutes(kit);
	registerTypeRoutes(kit);
	registerDeleteRoutes(kit);
	return { flush: () => eventSink.flush?.() ?? Promise.resolve() };
}
