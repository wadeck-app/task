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
import { remoteRequirementFor } from './remoteRequirements.js';
import type { RemoteRequirement } from './remoteRequirements.js';

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

function rangeText(range: { min: number; max: number }): string {
	return range.min === range.max ? String(range.max) : `${range.min}..${range.max}`;
}

/** A row that is enabled: the title, then what was seen. */
function enabled(row: RemoteRequirement, seen = ''): CheckLine {
	return { name: row.key, status: 'ok', text: `enabled: ${row.title}${seen}` };
}

/** A row the client cannot test: only the other machine knows. */
function notTested(row: RemoteRequirement): CheckLine {
	return { name: row.key, status: 'ok', text: `not tested (${row.probe.request}); needs ${row.needs}: ${row.title}` };
}

/** A row that failed: `disabled (<why>): <title>: <what the error said>`, with the fix of the error, else the one of the row. */
function disabled(row: RemoteRequirement, why: string, error: unknown): CheckLine {
	const hint = (error as { hint?: unknown }).hint;
	const message = error instanceof Error ? error.message : String(error);
	return {
		name: row.key,
		status: row.required ? 'error' : 'warn',
		text: `disabled (${why}): ${row.title}: ${message}`,
		fix: typeof hint === 'string' ? hint : row.fix,
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
		if (error instanceof RemoteUnauthorizedError) {
			return [disabled(remoteRequirementFor('auth'), 'refused by the server', error)];
		}
		if (error instanceof RemoteIncompatibleError) {
			return [
				disabled(
					remoteRequirementFor('protocol'),
					error.serverProtocol === undefined
						? 'the server does not know this request'
						: `server speaks ${rangeText(error.serverProtocol)}, this task speaks ${PROTOCOL_VERSION}`,
					error
				),
			];
		}
		const why = error instanceof RemoteTimeoutError ? 'no answer in time' : 'no answer';
		if (error instanceof RemoteUnreachableError || error instanceof RemoteTimeoutError) {
			return [disabled(remoteRequirementFor('reachable'), why, error)];
		}
		return [disabled(remoteRequirementFor('reachable'), 'unexpected failure', error)];
	}
	const elapsed = input.now() - startedAt;
	const slow = input.slowMs ?? SLOW_MS;
	const reachable = remoteRequirementFor('reachable');
	const lines: CheckLine[] = [
		elapsed > slow
			? {
					name: 'reachable',
					status: 'warn',
					text: `${reachable.title}, but slowly: GET /v1/info took ${elapsed} ms`,
					fix: 'Every command makes several requests: a slow link makes each of them slow. Prefer a wired or closer network',
				}
			: enabled(reachable, ` (GET /v1/info, ${elapsed} ms, ${input.url})`),
		enabled(remoteRequirementFor('auth')),
	];

	const { min, max } = info.protocol;
	const protocol = remoteRequirementFor('protocol');
	lines.push(
		min <= PROTOCOL_VERSION && PROTOCOL_VERSION <= max
			? enabled(
					protocol,
					` (server speaks ${rangeText(info.protocol)}, this task speaks ${PROTOCOL_VERSION}; task-serve ${info.server.version})`
				)
			: disabled(
					protocol,
					`server speaks ${rangeText(info.protocol)}, this task speaks ${PROTOCOL_VERSION}`,
					new RemoteIncompatibleError(input.url, PROTOCOL_VERSION, { min, max })
				)
	);

	const served = `"${info.project.name}"${info.project.id === undefined ? '' : ` (${info.project.id})`}`;
	const project = remoteRequirementFor('project');
	if (input.expectedProject === undefined) {
		lines.push(
			enabled(
				project,
				`: the server serves ${served} (strategy.options.project is not set: whatever the server serves is used)`
			)
		);
	} else if (serverServes(input.expectedProject, info.project)) {
		lines.push(enabled(project, `: the server serves ${served}, as strategy.options.project says`));
	} else {
		lines.push({
			name: 'project',
			status: 'error',
			text: `disabled (the server serves ${served}, not "${input.expectedProject}"): ${project.title}`,
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
	lines.push(notTested(remoteRequirementFor('server-token')));
	return lines;
}
