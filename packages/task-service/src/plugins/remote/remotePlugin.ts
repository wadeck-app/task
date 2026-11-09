// The built-in strategy `remote` (plugins.remote.default, alias remote): the tasks of a project live on ANOTHER computer, behind a
// `task serve` there (stage 4 of the storage design). The server is the single writer and raises the queue events; this side speaks
// the protocol of task-core/remote through a transport plugin (`strategy.options.transport`, default plain-http).
import { LOCAL_TRAITS, REMOTE_CAPABILITIES } from '@wadeck-app/task-core';

import type { ReadNotice, StrategyContext, StrategyInstance, StrategyPlugin } from '../kinds.js';
import { RemoteBackend } from './RemoteBackend.js';
import { checkRemote } from './remoteCheck.js';

const KNOWN_OPTIONS = ['project', 'transport'] as const;

function describeFound(value: unknown): string {
	return JSON.stringify(value) ?? String(value);
}

function isMapping(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The address of a server as the identity of its storage: two projects behind the same server share their tasks. */
export function remoteLocation(options: Record<string, unknown>): string | undefined {
	const transport = options['transport'];
	const transportOptions = isMapping(transport) ? transport['options'] : undefined;
	const url = isMapping(transportOptions) ? transportOptions['url'] : undefined;
	if (typeof url !== 'string') return undefined;
	try {
		const parsed = new URL(url);
		return `remote ${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
	} catch {
		return undefined;
	}
}

export const remotePlugin: StrategyPlugin = {
	extensionPoint: 'strategy',
	backendKind: 'remote',
	capabilities: REMOTE_CAPABILITIES,
	// The server stores what the local store stores: nothing is missing, so nothing is filled.
	fillTechniques: {},
	// A remote project keeps what a local one keeps; a write is a network round trip (the estimate of `migrate --dry-run`).
	traitsFor: () => ({ ...LOCAL_TRAITS, cost: { requests: 3, seconds: 0.15, read: { requests: 1, seconds: 0.05 } } }),
	locationOf: remoteLocation,

	validate(options) {
		for (const key of Object.keys(options)) {
			if (!(KNOWN_OPTIONS as readonly string[]).includes(key)) {
				return `${key}: unknown option for strategy "remote" (known: ${KNOWN_OPTIONS.join(', ')})`;
			}
		}
		const { project, transport } = options;
		if (transport === undefined) {
			return 'transport: required (how to reach the server: { type: plain-http, options: { url, tokenEnv } })';
		}
		if (!isMapping(transport)) {
			return `transport: must be a mapping with type and options, found ${describeFound(transport)}`;
		}
		if (project !== undefined && (typeof project !== 'string' || project.trim() === '')) {
			return `project: must be the id or the name of the project the server serves, found ${describeFound(project)}`;
		}
		return undefined;
	},

	describe() {
		return {
			summary:
				'The tasks live on another computer: a task serve there stores them (single writer) and raises the queue events; this machine speaks HTTP/JSON to it (protocol 1, bearer token). Plain HTTP: trusted LAN only.',
			options: {
				project:
					'id (or unique id prefix) or name of the project the server serves; checked at the first call, so a wrong address cannot write to another project (optional)',
				transport:
					'{ type: plain-http, options: { url, tokenEnv | tokenFile, timeoutSeconds } }: how to reach the server (required)',
			},
			snippet: [
				'strategy:',
				'    type: remote',
				'    options:',
				'        project: shop # optional safety check',
				'        transport:',
				'            type: plain-http',
				'            options:',
				'                url: http://nas.lan:7788',
				'                tokenEnv: TASK_REMOTE_TOKEN',
				'                timeoutSeconds: 10',
			].join('\n'),
		};
	},

	async create(rawOptions, context: StrategyContext) {
		if (context.openTransport === undefined) {
			throw new Error(
				`${context.source}: strategy.options.transport is not available to the remote strategy (the host did not open it); this is a bug of the host`
			);
		}
		const transport = await context.openTransport();
		const notices: ReadNotice[] = [];
		const seen = new Set<string>();
		const notice = (next: ReadNotice): void => {
			if (seen.has(next.text)) return;
			seen.add(next.text);
			notices.push(next);
		};
		const expectedProject = typeof rawOptions['project'] === 'string' ? rawOptions['project'].trim() : undefined;
		const backend = new RemoteBackend({
			transport,
			notice,
			...(expectedProject === undefined ? {} : { expectedProject }),
			...(context.suppressEvents === true ? { suppressEvents: true } : {}),
			projectName: context.project.name,
		});
		const instance: StrategyInstance = {
			backend,
			describe: () => [
				`server: ${transport.baseUrl}`,
				`project: ${expectedProject === undefined ? 'whatever the server serves (strategy.options.project is not set)' : expectedProject}`,
				...transport.describe(),
				'events: raised by the server, none by this machine',
				'mode: read and write (the server is the single writer, one write at a time)',
			],
			check: () =>
				checkRemote({
					info: () => backend.info(),
					url: transport.baseUrl,
					expectedProject,
					facts: { statuses: context.statuses, types: context.types },
					now: Date.now,
				}),
			takeNotices: () => notices.splice(0, notices.length),
			dispose: () => transport.dispose(),
		};
		return instance;
	},
};
