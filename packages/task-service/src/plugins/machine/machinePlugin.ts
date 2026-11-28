// The built-in transport `machine` (plugins.machine.default, alias machine): how bytes reach a task project that lives on ANOTHER computer
// of the user's private network, through the `machine` CLI (`machine run <peer> -- task serve -p <project> --stdio`). The `remote`
// strategy is unchanged (same protocol, same backend); only the way a request travels differs, so whatever storage the project uses on
// the peer (local files, github, gitlab) is invisible here.
//
// PARTIAL until the installed machine CLI has `run --stdin`: see nodeMachineRunner.ts (it detects this from the local help). Until then
// the real runner refuses with a message saying so; nothing is faked.
import type { TransportPlugin } from '../kinds.js';
import { MACHINE_SHELLS, peerProblem, projectProblem } from './machineCommand.js';
import type { MachineShell } from './machineCommand.js';
import { createMachineTransport } from './machineTransport.js';
import type { MachineSettings } from './machineTransport.js';
import type { MachineRunner } from './machineRunner.js';

const KNOWN_OPTIONS = ['peer', 'project', 'wake', 'shell', 'timeoutSeconds'] as const;
/** One `machine run` is cut at 60 s by the target; the default leaves it that time, plus the wake of a sleeping peer. */
export const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 600;

function describeFound(value: unknown): string {
	return JSON.stringify(value) ?? String(value);
}

/** The settings of valid options, or the first problem as a sentence that starts with the dotted key. */
export function parseMachineOptions(
	options: Record<string, unknown>
): { settings: MachineSettings } | { problem: string } {
	for (const key of Object.keys(options)) {
		if (!(KNOWN_OPTIONS as readonly string[]).includes(key)) {
			return { problem: `${key}: unknown option for transport "machine" (known: ${KNOWN_OPTIONS.join(', ')})` };
		}
	}
	const { peer, project, wake, shell, timeoutSeconds } = options;
	if (peer === undefined) return { problem: `peer: required (the machine that holds the tasks, as machine list names it)` };
	const peerIssue = peerProblem(peer);
	if (peerIssue !== undefined) return { problem: `peer: ${peerIssue}` };
	if (project === undefined) {
		return { problem: 'project: required (the project on that machine, by name or id)' };
	}
	const projectIssue = projectProblem(project);
	if (projectIssue !== undefined) return { problem: `project: ${projectIssue}` };
	if (wake !== undefined && wake !== 'auto' && wake !== 'never') {
		return { problem: `wake: must be "auto" or "never", found ${describeFound(wake)}` };
	}
	if (shell !== undefined && !(MACHINE_SHELLS as readonly unknown[]).includes(shell)) {
		return { problem: `shell: must be one of ${MACHINE_SHELLS.join(', ')}, found ${describeFound(shell)}` };
	}
	if (
		timeoutSeconds !== undefined &&
		(typeof timeoutSeconds !== 'number' || !(timeoutSeconds > 0) || timeoutSeconds > MAX_TIMEOUT_SECONDS)
	) {
		return {
			problem: `timeoutSeconds: must be a number of seconds above 0 and at most ${MAX_TIMEOUT_SECONDS}, found ${describeFound(timeoutSeconds)}`,
		};
	}
	return {
		settings: {
			peer: peer as string,
			project: project as string,
			wake: wake === 'never' ? 'never' : 'auto',
			...(shell === undefined ? {} : { shell: shell as MachineShell }),
			timeoutSeconds: typeof timeoutSeconds === 'number' ? timeoutSeconds : DEFAULT_TIMEOUT_SECONDS,
		},
	};
}

/** The transport plugin over a runner: the built-in one gets the real runner, tests inject a fake. */
export function createMachinePlugin(runner: MachineRunner): TransportPlugin {
	return {
		extensionPoint: 'transport',

		validate(options) {
			const parsed = parseMachineOptions(options);
			return 'problem' in parsed ? parsed.problem : undefined;
		},

		describe() {
			return {
				summary:
					'The tasks live on another computer of your private network, reached through the machine CLI (machine run, the request on stdin): authenticated by machine, allowed by an exact allow-list entry, no token and no open port. The peer is never pinged or polled; only a real operation can wake it.',
				options: {
					peer: 'The machine that holds the tasks: name, alias or id as `machine list` shows it (required)',
					project: 'The project on that machine, by name or id; letters, digits, dots, underscores and hyphens only (required)',
					wake: 'auto (default): machine run wakes a peer with a Wake-on-LAN setting; never: pass --no-wake, a sleeping peer is reported, not woken',
					shell: `The shell of the peer for machine run, when its default is not right: ${MACHINE_SHELLS.join(' | ')} (optional)`,
					timeoutSeconds: `Time limit of one request in seconds, at most ${MAX_TIMEOUT_SECONDS} (default ${DEFAULT_TIMEOUT_SECONDS})`,
				},
				snippet:
					'transport:\n    type: machine\n    options:\n        peer: thinkcentre\n        project: shop\n        wake: auto',
			};
		},

		create(options) {
			const parsed = parseMachineOptions(options);
			if ('problem' in parsed) return Promise.reject(new Error(parsed.problem));
			try {
				return Promise.resolve(createMachineTransport(parsed.settings, runner));
			} catch (error) {
				return Promise.reject(error instanceof Error ? error : new Error(String(error)));
			}
		},
	};
}
