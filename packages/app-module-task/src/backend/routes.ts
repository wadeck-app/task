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

/** Registers the task routes (`/api/modules/task/...`) on the module context. */
export function registerTaskRoutes(ctx: ModuleContext, options: TaskRoutesOptions = {}): void {
	const configDir = options.configDir ?? getTaskConfigDir();
	const logDir = getTaskLogDir(configDir);
	const kit = createRouteKit(ctx, {
		configDir,
		logDir,
		writeStderr: options.writeStderr ?? ((text: string) => void process.stderr.write(text)),
		eventSink: options.eventSink ?? createQueueEventSink({ getLogDir: () => logDir }),
	});
	registerProjectRoutes(kit);
	registerProjectManageRoutes(kit);
	registerTaskReadRoutes(kit);
	registerTaskWriteRoutes(kit);
	registerTypeRoutes(kit);
	registerDeleteRoutes(kit);
}
