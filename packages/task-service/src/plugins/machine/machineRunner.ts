// The seam between the machine transport and the `machine` CLI: ONE call = one `machine run` of the allow-listed command with the request
// on its stdin. The transport knows no process; the real implementation (nodeMachineRunner.ts) spawns the `machine` binary, tests inject a
// fake. Nothing here ever carries the content of a request outside the `stdin` field: it is not logged, not put in an error.
import type { MachineShell } from './machineCommand.js';

/** One call of `machine run`. Every text but `stdin` has been validated by machineCommand.ts. */
export interface MachineCall {
	peer: string;
	shell?: MachineShell | undefined;
	/** `never`: `--no-wake`, the peer is not woken. `auto`: what `machine` does by itself (it wakes a peer configured for Wake-on-LAN that is unreachable). */
	wake: 'auto' | 'never';
	/** The command string for the peer (one argument). */
	command: string;
	/** The request, as JSON text, for the stdin of the command. */
	stdin: string;
	timeoutMs: number;
}

/** What came back. A failure of `machine` itself (exit 255) is `failed` with its plain text; the CLI prints no JSON for it. */
export type MachineOutcome =
	| {
			kind: 'ran';
			/** The exit code of the command on the peer; null when it was killed there. */
			exitCode: number | null;
			stdout: string;
			stderr: string;
			timedOut: boolean;
			/** The output went over the 1 MiB `machine run` keeps. */
			truncated: boolean;
	  }
	| { kind: 'failed'; stderr: string }
	| { kind: 'timeout' };

export interface MachineRunner {
	run(call: MachineCall): Promise<MachineOutcome>;
}

/** What a `failed` text of `machine run` says, read from its words (the CLI has no code for it: refusals and unreachable peers are both 255). */
export type MachineFailureKind = 'refused' | 'unreachable' | 'other';

export function classifyMachineFailure(stderr: string): MachineFailureKind {
	if (/\brefused by\b/i.test(stderr)) return 'refused';
	if (/could not connect|no answer|did not answer|unreachable/i.test(stderr)) return 'unreachable';
	return 'other';
}

/** The first non-empty line of a text, at most `max` characters: what an error message quotes of the stderr of another program. */
export function firstLine(text: string, max = 300): string {
	const line = text
		.split(/\r?\n/)
		.map(part => part.trim())
		.find(part => part !== '');
	if (line === undefined) return '';
	return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}
