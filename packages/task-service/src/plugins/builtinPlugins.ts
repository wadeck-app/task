// The built-in plugins, registered statically (the published CLI is one bundle: no dynamic import, design R11). The only file
// that imports the plugin folders; both adapters get the same list through task-service.
import { createPluginRegistry } from '../plugin-host/index.js';
import { githubPlugin } from './github/githubPlugin.js';
import type { TaskPluginKinds, TaskPluginRegistry } from './kinds.js';
import { localPlugin } from './local/localPlugin.js';
import { plainHttpPlugin } from './plain-http/plainHttpPlugin.js';
import { remotePlugin } from './remote/remotePlugin.js';

/** A fresh registry holding the built-ins: strategies `local`, `github` and `remote`, transport `plain-http`. Tests and hosts build their own instance. */
export function createBuiltinRegistry(): TaskPluginRegistry {
	return createPluginRegistry<TaskPluginKinds>([
		{ ref: 'plugins.local.default', plugin: localPlugin, aliases: ['local'] },
		{ ref: 'plugins.github.default', plugin: githubPlugin, aliases: ['github'] },
		{ ref: 'plugins.remote.default', plugin: remotePlugin, aliases: ['remote'] },
		{ ref: 'plugins.plain-http.default', plugin: plainHttpPlugin, aliases: ['plain-http'] },
	]);
}
