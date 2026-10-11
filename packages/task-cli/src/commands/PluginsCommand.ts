import type { CommandResult } from '../TaskIndex.js';

interface PluginEntry {
	id: string;
	extensionPoint: string;
	typeString: string;
}

interface PluginConfig {
	extensionPoint: string;
	snippet: string;
	options: Record<string, string>;
}

// Mirrors the built-in plugins from flow-cli without creating an inter-package dependency.
const PLUGIN_ENTRIES: PluginEntry[] = [
	{ id: 'none', extensionPoint: 'workspace', typeString: 'plugins.none.default' },
	{ id: 'worktree', extensionPoint: 'workspace', typeString: 'plugins.worktree.default' },
	{ id: 'cli-approval', extensionPoint: 'approval', typeString: 'plugins.cli-approval.default' },
	{ id: 'file-approval', extensionPoint: 'approval', typeString: 'plugins.file-approval.default' },
];

const PLUGIN_CONFIGS: Record<string, PluginConfig> = {
	none: {
		extensionPoint: 'workspace',
		snippet: `# Add to .flow/config.yml:

plugins:
  workspace:
    instance:
      type: plugins.none.default`,
		options: {},
	},
	worktree: {
		extensionPoint: 'workspace',
		snippet: `# Add to .flow/config.yml:

plugins:
  workspace:
    instance:
      type: plugins.worktree.default
      options:
        baseDir: /absolute/path/to/worktrees   # required
        prefix: task-                           # optional, branch name prefix`,
		options: {
			baseDir: 'Absolute path where git worktrees are created (required)',
			prefix: 'Prefix prepended to branch names (optional)',
		},
	},
	'cli-approval': {
		extensionPoint: 'approval',
		snippet: `# Add to .flow/config.yml:

plugins:
  approval:
    instance:
      type: plugins.cli-approval.default

# TTY fallback: loaded automatically when no approval plugin is configured
# and flow worker detects a TTY. No config needed for interactive use.`,
		options: {},
	},
	'file-approval': {
		extensionPoint: 'approval',
		snippet: `# Add to .flow/config.yml:

plugins:
  approval:
    instance:
      type: plugins.file-approval.default
      options:
        dir: /absolute/path/to/approvals   # default: $FLOW_APPROVAL_DIR or ~/.config/flow/approvals
        timeoutMs: 1800000                 # default: 30 min
        pollIntervalMs: 500               # default: 500 ms
        settleMs: 2000                    # default: 2 s, grace for half-written response files

# Request file: <dir>/<executionId>_<stepId>.request.json
# Response file: <dir>/<executionId>_<stepId>.response.json  (you create this)
# After answer: both moved to <dir>/answered/`,
		options: {
			dir: 'Absolute path for request/response files (default: $FLOW_APPROVAL_DIR or ~/.config/flow/approvals)',
			timeoutMs: 'How long to wait for a response before failing (default: 1800000 = 30 min)',
			pollIntervalMs: 'How often to check for the response file (default: 500 ms)',
			settleMs: 'Grace period for half-written response files (default: 2000 ms)',
		},
	},
};

export function runPluginsCommand(rest: string[], jsonMode: boolean): CommandResult {
	const subCmd = rest[0];

	if (!subCmd || subCmd === '--help') {
		return {
			exitCode: 0,
			output: `task plugins - list and inspect built-in flow plugins

Usage:
  task plugins list [--json]          List all available built-in plugins
  task plugins config <id> [--json]   Show configuration snippet for a plugin`,
		};
	}

	if (subCmd === 'list') {
		if (jsonMode || rest.includes('--json')) {
			return { exitCode: 0, output: JSON.stringify(PLUGIN_ENTRIES, null, 2) };
		}
		const id = 'ID'.padEnd(18);
		const ext = 'EXTENSION'.padEnd(14);
		const header = `${id}${ext}TYPE STRING`;
		const rows = PLUGIN_ENTRIES.map(e => `${e.id.padEnd(18)}${e.extensionPoint.padEnd(14)}${e.typeString}`);
		return { exitCode: 0, output: [header, ...rows].join('\n') };
	}

	if (subCmd === 'config') {
		const pluginId = rest[1];
		if (!pluginId) {
			return { exitCode: 1, output: 'Error: missing plugin ID\nUsage: task plugins config <id>' };
		}
		const useJson = jsonMode || rest.includes('--json');
		const cfg = PLUGIN_CONFIGS[pluginId];
		if (cfg === undefined) {
			const msg = `Error: unknown plugin '${pluginId}'. Run 'task plugins list' to see available plugins.`;
			if (useJson) {
				return { exitCode: 1, output: JSON.stringify({ error: msg }) };
			}
			return { exitCode: 1, output: msg };
		}
		if (useJson) {
			const entry = PLUGIN_ENTRIES.find(e => e.id === pluginId);
			return {
				exitCode: 0,
				output: JSON.stringify(
					{
						id: pluginId,
						extensionPoint: cfg.extensionPoint,
						typeString: entry?.typeString ?? `plugins.${pluginId}.default`,
						snippet: cfg.snippet,
						options: cfg.options,
					},
					null,
					2
				),
			};
		}
		return { exitCode: 0, output: cfg.snippet };
	}

	return {
		exitCode: 1,
		output: `Error: unknown plugins subcommand: ${subCmd}\nValid subcommands: list, config`,
	};
}
