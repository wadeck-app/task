// violations-suppress: ts/no-barrel-index app-core requires lifecycle hooks to be src/backend/<file>.ts with a default export (app-core-cli check)
import type { ModuleTeardownContext } from '@wadeck-app/app-core-sdk';

import type { TaskModuleInstance } from './routes.js';

/**
 * Lifecycle hook declared in manifest.json: runs when the module is updated, unloaded, unregistered or the server shuts down.
 * Lets the queue SDK finish the pushes it has in flight, so a mutation made just before is not lost with the process.
 */
export default async function teardown(ctx: ModuleTeardownContext<TaskModuleInstance | undefined>): Promise<void> {
	await ctx.instance?.flush();
}
