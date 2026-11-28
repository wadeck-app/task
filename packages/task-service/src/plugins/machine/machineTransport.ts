// The instance of the `machine` transport: one request = one `machine run <peer> -- task serve -p <project> --stdio`, the request as
// the stdio envelope on its stdin, the answer envelope on its stdout (the pipeline of `task serve --stdio`, stdioServer.ts). It never
// parses protocol payloads beyond the envelope; the remote backend does. There is no token: `machine` authenticates the peer and an
// admin allowed this exact command (threat T19). Nothing probes the peer: no ping, no poll, no keep-alive; a peer asleep is woken only
// by `machine run` itself, for a real operation, and not at all with `wake: never`.
//
// Failures are told with a next step (the allow entry to create, the peer that may be asleep, the page size). The content of a request
// is never put in an error or a log.
import {
	BackendRejectedError,
	MachineUnreachableError,
	PROTOCOL_HEADER,
	PROTOCOL_MIN,
	PROTOCOL_VERSION,
	RemoteIncompatibleError,
	RemoteTimeoutError,
	RemoteUnauthorizedError,
} from '@wadeck-app/task-core';

import type { TransportInstance } from '../kinds.js';
import { ALLOW_FAMILIES_NOTE, MACHINE_INPUT_MAX_BYTES, allowEntryText, serveCommand } from './machineCommand.js';
import type { MachineShell } from './machineCommand.js';
import { classifyMachineFailure, firstLine } from './machineRunner.js';
import type { MachineOutcome, MachineRunner } from './machineRunner.js';

export interface MachineSettings {
	peer: string;
	/** The project on the peer, by name or id. */
	project: string;
	wake: 'auto' | 'never';
	shell?: MachineShell | undefined;
	timeoutSeconds: number;
}

/** What `machine run` keeps of the output: a bigger answer is cut. */
const OUTPUT_LIMIT = '1 MiB';

interface AnswerEnvelope {
	status: number;
	headers: Record<string, string>;
	body: unknown;
}

function isMapping(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The envelope the peer printed, or undefined when it is not one. */
function parseAnswer(stdout: string): AnswerEnvelope | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout) as unknown;
	} catch {
		return undefined;
	}
	if (!isMapping(parsed)) return undefined;
	const { status, headers, body } = parsed;
	if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) return undefined;
	if (!isMapping(headers)) return undefined;
	const texts: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (typeof value !== 'string') return undefined;
		texts[name] = value;
	}
	return { status, headers: texts, body };
}

const NO_BODY_STATUS = new Set([204, 205, 304]);

export function createMachineTransport(settings: MachineSettings, runner: MachineRunner): TransportInstance {
	const baseUrl = `machine://${settings.peer}/${settings.project}`;
	const timeoutMs = settings.timeoutSeconds * 1000;
	const command = serveCommand(settings.project);
	const allowEntry = allowEntryText(settings.peer, settings.project, settings.shell);
	let closed = false;

	const refused = (text: string): RemoteUnauthorizedError =>
		new RemoteUnauthorizedError(
			'forbidden',
			`${settings.peer} refused to run the command for this project (${firstLine(text)})`,
			`The allow list of ${settings.peer} does not contain this command with its input. On the machine that holds the admin key run: ${allowEntry} (${ALLOW_FAMILIES_NOTE}; then retry; \`machine allowed ${settings.peer}\` shows what is allowed)`
		);

	const unreachable = (text: string): MachineUnreachableError => {
		const reason = firstLine(text) || 'no answer';
		const asleep =
			settings.wake === 'never'
				? `${settings.peer} did not answer and this project has wake: never, so nothing tried to wake it: it may be asleep. Wake it (machine wake ${settings.peer}) and retry, or remove wake: never to let machine run wake it`
				: `${settings.peer} did not answer. machine run wakes a peer that has a Wake-on-LAN setting before giving up; if this one has none, set it once (machine peer connect ${settings.peer} --address <ip>:<port> --wake-mac <mac>, see machine wake-info ${settings.peer}), or check that the machine is on and its daemon runs (machine status there)`;
		return new MachineUnreachableError(settings.peer, reason, `${asleep}. Then run: task strategy check`);
	};

	const failedMachine = (text: string): Error => {
		switch (classifyMachineFailure(text)) {
			case 'refused':
				return refused(text);
			case 'unreachable':
				return unreachable(text);
			default:
				return new MachineUnreachableError(
					settings.peer,
					firstLine(text) || 'machine run failed without a message',
					`machine run failed before the command ran. Run \`machine ping ${settings.peer}\` (it needs no allow-list entry) and \`machine status\`, then: task strategy check`
				);
		}
	};

	const answerOf = (outcome: MachineOutcome, method: string): AnswerEnvelope => {
		const kind = method === 'GET' ? 'read' : 'write';
		if (outcome.kind === 'failed') throw failedMachine(outcome.stderr);
		if (outcome.kind === 'timeout' || outcome.timedOut) {
			throw new RemoteTimeoutError(settings.peer, timeoutMs, kind);
		}
		if (outcome.truncated) {
			throw new BackendRejectedError(
				'remote',
				'machine run',
				`the answer of ${settings.peer} is larger than the ${OUTPUT_LIMIT} that machine run keeps and was cut`,
				kind === 'read'
					? 'Ask for less at once (a smaller page: task list --limit), then retry'
					: `The change may have been applied: check with task show (or task list) before repeating it. Nothing can be read back from an answer that was cut`
			);
		}
		if (outcome.exitCode !== 0) {
			throw new MachineUnreachableError(
				settings.peer,
				`task serve --stdio exited ${outcome.exitCode === null ? 'killed' : outcome.exitCode} on ${settings.peer}: ${firstLine(outcome.stderr) || 'no message'}`,
				`On ${settings.peer} check that task is installed and recent (task -v), that the project ${settings.project} exists there (project list), and run task strategy check here. ${kind === 'write' ? 'The change may have been applied: check with task show before repeating it.' : 'The read can be repeated.'}`
			);
		}
		const answer = parseAnswer(outcome.stdout);
		if (answer === undefined) {
			throw new RemoteIncompatibleError(baseUrl, PROTOCOL_VERSION, undefined);
		}
		return answer;
	};

	return {
		baseUrl,
		headers: () => ({ [PROTOCOL_HEADER]: String(PROTOCOL_MIN) }),

		async fetch(path, init = {}) {
			if (closed) throw new Error(`the connection to ${settings.peer} was closed; open the project again`);
			const method = init.method ?? 'GET';
			let body: unknown;
			if (init.body !== undefined) {
				try {
					body = JSON.parse(init.body) as unknown;
				} catch {
					throw new BackendRejectedError(
						'remote',
						'machine run',
						'the request body is not JSON, and the stdio protocol carries JSON only',
						'This is a bug of the caller: report it with task cli logs'
					);
				}
			}
			const envelope = {
				method,
				path,
				headers: { [PROTOCOL_HEADER]: String(PROTOCOL_MIN), ...init.headers },
				...(body === undefined ? {} : { body }),
			};
			const stdin = JSON.stringify(envelope);
			// The size is of the UTF-8 bytes (an accent is two), the unit of `--stdin-max`. Nothing is run for a request over the cap.
			const bytes = Buffer.byteLength(stdin, 'utf8');
			if (bytes > MACHINE_INPUT_MAX_BYTES) {
				throw new BackendRejectedError(
					'remote',
					'machine run',
					`the request is ${bytes} bytes and machine run carries at most ${MACHINE_INPUT_MAX_BYTES} bytes (64 KiB) of input to ${settings.peer}`,
					'Send less at once: a shorter text (a comment or a description is cut into several, or kept shorter). A larger limit needs `--stdin-max` raised in the allow entry of the peer and the limit of this transport raised, once machine supports more than 64k'
				);
			}
			const outcome = await runner.run({
				peer: settings.peer,
				shell: settings.shell,
				wake: settings.wake,
				command,
				stdin,
				timeoutMs,
			});
			const answer = answerOf(outcome, method);
			const noBody = NO_BODY_STATUS.has(answer.status) || answer.body === undefined;
			return new Response(noBody ? null : JSON.stringify(answer.body), {
				status: answer.status,
				headers: answer.headers,
			});
		},

		describe: () => [
			`peer: ${settings.peer}${settings.shell === undefined ? '' : ` (shell ${settings.shell})`}`,
			`project on the peer: ${settings.project}`,
			`command: ${command} (one process per request, the request on stdin, run by machine run)`,
			`wake: ${settings.wake === 'never' ? 'never (--no-wake: a sleeping peer is not woken)' : 'auto (machine run wakes a peer with a Wake-on-LAN setting; nothing pings or polls)'}`,
			`timeout: ${settings.timeoutSeconds} s per request`,
			`allow entry needed on the admin machine: ${allowEntry}`,
		],

		dispose() {
			closed = true;
			return Promise.resolve();
		},
	};
}
