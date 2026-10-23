// violations-suppress: ts/no-barrel-index app-core requires the backend entry of an app-module to be src/backend/index.ts (app-core-cli check)
import type { ModuleContext } from '@wadeck-app/app-core-sdk';

import { registerTaskRoutes, type TaskModuleInstance } from './routes.js';

/**
 * backendEntryPath target declared by app-core-cli: called once at module load with the module context.
 * Routes become /api/modules/task/<subPath> and are removed automatically on unload.
 * Returns the instance that the teardown hook (teardown.ts) receives, to flush the queue pushes in flight.
 */
export default function (ctx: ModuleContext): TaskModuleInstance {
	return registerTaskRoutes(ctx);
}
