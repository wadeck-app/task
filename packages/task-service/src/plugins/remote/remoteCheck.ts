// `task strategy check` for a remote project: asks the server who it is and compares it with what this machine expects. Every finding is
// a line with its fix; a failure that makes the other lines meaningless (unreachable, refused token, another protocol) stops the list.
import {
	LOCAL_CAPABILITIES,
	PROTOCOL_VERSION,
	RemoteIncompatibleError,
	RemoteTimeoutError,
	RemoteUnauthorizedError,
	RemoteUnreachableError,
} from '@wadeck-app/task-core';
import type { BackendCapabilities, ServerInfo } from '@wadeck-app/task-core';

import type { CheckLine, ProjectFacts } from '../kinds.js';
import { serverServes } from './RemoteBackend.js';

export interface RemoteCheckInput {
	/** `GET /v1/info`. */
	info: () => Promise<ServerInfo>;
	url: string;
	expectedProject: string | undefined;
	/** The statuses and types of THIS machine's config for the project. */
	facts: ProjectFacts;
	now: () => number;
	/** A round trip slower than this is a warning (ms). */
	slowMs?: number;
}

const SLOW_MS = 500;

function failureLine(name: string, error: unknown): CheckLine {
	const hint = (error as { hint?: unknown }).hint;
	return {
		name,
		status: 'error',
		text: error instanceof Error ? error.message : String(error),
		...(typeof hint === 'string' ? { fix: hint } : {}),
	};
}

function differences(served: BackendCapabilities): string[] {
	const found: string[] = [];
	for (const key of Object.keys(LOCAL_CAPABILITIES) as Array<keyof BackendCapabilities>) {
		// The queue events are raised by the server on purpose: that is what a remote project is.
		if (key === 'events') continue;
		if (JSON.stringify(served[key]) !== JSON.stringify(LOCAL_CAPABILITIES[key])) {
			found.push(
				`${key}: ${JSON.stringify(served[key])} (a local project has ${JSON.stringify(LOCAL_CAPABILITIES[key])})`
			);
		}
	}
	return found;
}

function listText(values: readonly string[]): string {
	return values.length === 0 ? 'any' : values.join(', ');
}

/** The lines of `strategy check` the remote plugin owns. Never throws. */
export async function checkRemote(input: RemoteCheckInput): Promise<CheckLine[]> {
	const startedAt = input.now();
	let info: ServerInfo;
	try {
		info = await input.info();
	} catch (error) {
		if (error instanceof RemoteUnauthorizedError) return [failureLine('auth', error)];
		if (error instanceof RemoteIncompatibleError) return [failureLine('protocol', error)];
		if (error instanceof RemoteUnreachableError || error instanceof RemoteTimeoutError) {
			return [failureLine('reachable', error)];
		}
		return [failureLine('reachable', error)];
	}
	const elapsed = input.now() - startedAt;
	const slow = input.slowMs ?? SLOW_MS;
	const lines: CheckLine[] = [
		elapsed > slow
			? {
					name: 'reachable',
					status: 'warn',
					text: `GET /v1/info took ${elapsed} ms`,
					fix: 'Every command makes several requests: a slow link makes each of them slow. Prefer a wired or closer network',
				}
			: { name: 'reachable', status: 'ok', text: `GET /v1/info answered in ${elapsed} ms (${input.url})` },
		{ name: 'auth', status: 'ok', text: 'the server accepted the token' },
	];

	const { min, max } = info.protocol;
	lines.push(
		min <= PROTOCOL_VERSION && PROTOCOL_VERSION <= max
			? {
					name: 'protocol',
					status: 'ok',
					text: `server speaks ${min === max ? String(max) : `${min}..${max}`}, this task speaks ${PROTOCOL_VERSION} (task-serve ${info.server.version})`,
				}
			: failureLine('protocol', new RemoteIncompatibleError(input.url, PROTOCOL_VERSION, { min, max }))
	);

	const served = `"${info.project.name}"${info.project.id === undefined ? '' : ` (${info.project.id})`}`;
	if (input.expectedProject === undefined) {
		lines.push({
			name: 'project',
			status: 'ok',
			text: `the server serves ${served} (strategy.options.project is not set: whatever the server serves is used)`,
		});
	} else if (serverServes(input.expectedProject, info.project)) {
		lines.push({
			name: 'project',
			status: 'ok',
			text: `the server serves ${served}, as strategy.options.project says`,
		});
	} else {
		lines.push({
			name: 'project',
			status: 'error',
			text: `the server serves ${served}, not "${input.expectedProject}" (strategy.options.project)`,
			fix: `Point transport.options.url at the server of "${input.expectedProject}", or change strategy.options.project to "${info.project.name}", or remove it`,
		});
	}

	const capabilityDifferences = differences(info.capabilities);
	lines.push(
		capabilityDifferences.length === 0
			? {
					name: 'capabilities',
					status: 'ok',
					text: 'all native, as a local project; queue events are raised by the server',
				}
			: {
					name: 'capabilities',
					status: 'warn',
					text: `the server differs from a local project: ${capabilityDifferences.join('; ')}`,
					fix: 'Update task on both machines to the same version',
				}
	);

	const mine = input.facts.statuses.map(status => status.name);
	if (JSON.stringify(mine) === JSON.stringify(info.statuses)) {
		const myTerminal = input.facts.statuses.filter(status => status.terminal).map(status => status.name);
		lines.push(
			JSON.stringify(myTerminal) === JSON.stringify(info.terminalStatuses)
				? { name: 'statuses', status: 'ok', text: `same statuses on both machines (${listText(mine)})` }
				: {
						name: 'statuses',
						status: 'warn',
						text: `same statuses, but the terminal ones differ: here ${listText(myTerminal)}, on the server ${listText(info.terminalStatuses)}`,
						fix: 'Make the terminal flag of the statuses equal in the config.yml of both machines (unblocked tasks and done/closed counts follow it)',
					}
		);
	} else {
		lines.push({
			name: 'statuses',
			status: 'error',
			text: `the statuses differ: here ${listText(mine)}, on the server ${listText(info.statuses)}; the server refuses a status it does not know`,
			fix: 'Make the statuses of this project equal to the ones in the config.yml of the project on the machine that runs task serve',
		});
	}

	const unknownHere = input.facts.types.filter(type => info.types.length > 0 && !info.types.includes(type));
	if (unknownHere.length > 0) {
		lines.push({
			name: 'types',
			status: 'error',
			text: `types allowed here but refused by the server: ${unknownHere.join(', ')} (server: ${listText(info.types)})`,
			fix: 'Make the types of this project equal to the ones of the project on the machine that runs task serve',
		});
	} else if (JSON.stringify(input.facts.types) !== JSON.stringify(info.types)) {
		lines.push({
			name: 'types',
			status: 'warn',
			text: `the types differ: here ${listText(input.facts.types)}, on the server ${listText(info.types)}`,
			fix: 'Make them equal so that both machines offer the same types',
		});
	}

	lines.push(
		info.events.enabled
			? { name: 'events', status: 'ok', text: 'queue events are raised by the server; this machine raises none' }
			: {
					name: 'events',
					status: 'warn',
					text: 'the server runs without a queue: no event is raised for changes made through it',
					fix: 'Restart task serve on a machine where the queue CLI is installed if flows or subscribers depend on task events',
				}
	);
	return lines;
}
