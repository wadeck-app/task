// The command line this transport asks `machine run` to execute on the peer, and everything that is checked BEFORE one is built.
//
// `machine run <peer> -- <command>` carries ONE string of printable ASCII (0x20-0x7e, at most 2048 characters) that the peer hands,
// unescaped, to a shell (`sh -c`, `cmd /d /s /c`, `powershell -EncodedCommand`). So the two names that end up in the command line (the
// peer, the project on the peer) are checked against a strict alphabet here, in the config validation AND again when the command is
// built: a name that could add a word, a quote, a redirect or a second command is refused before any process starts. The request
// itself (a task title, a comment) never goes through the command line: it travels on stdin.
import { BackendRejectedError } from '@wadeck-app/task-core';

/** A machine reference as `machine` accepts it (name, alias, uuid or prefix): starts with a letter or digit, so it can never read as a flag. */
export const PEER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The project on the peer, by name or id. No space: the peer's shell would split it into several words. */
export const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MACHINE_SHELLS = ['cmd', 'ps', 'bash', 'sh'] as const;
export type MachineShell = (typeof MACHINE_SHELLS)[number];
/** The longest command `machine run` accepts. */
export const COMMAND_MAX_LENGTH = 2048;
/**
 * The most bytes (UTF-8) of input the FIRST release of machine carries to a command: the entry of the allow list declares
 * `--stdin-max 64k` and the signed request carries the size. machine-owner plans 512 KiB later (spec
 * .claude/specs/2026-11-13_machine-network/stdin-input.md in the machine repo, decision 114); raise this and the entry then.
 */
export const MACHINE_INPUT_MAX_BYTES = 64 * 1024;

/** The problem with a peer name as a sentence (starting with what is wrong), or undefined. */
export function peerProblem(value: unknown): string | undefined {
	if (typeof value !== 'string' || value === '') {
		return 'must be the name, alias or id of a machine known to the machine CLI (machine list shows them)';
	}
	if (!PEER_PATTERN.test(value)) {
		return `${JSON.stringify(value)} is not a machine reference: letters, digits, dots, underscores and hyphens only (up to 64), starting with a letter or a digit`;
	}
	return undefined;
}

/** The problem with a project reference as a sentence, or undefined. */
export function projectProblem(value: unknown): string | undefined {
	if (typeof value !== 'string' || value === '') {
		return 'must be the name or the id of the project on the peer (project list there shows them)';
	}
	if (!PROJECT_PATTERN.test(value)) {
		return `${JSON.stringify(value)} cannot be put in a command line: letters, digits, dots, underscores and hyphens only (up to 64), starting with a letter or a digit; a project whose name has other characters is reached by its id`;
	}
	return undefined;
}

/**
 * The command the peer runs: one process answers one request. Throws a BackendRejectedError when the project name is not safe or the
 * line is not printable ASCII of at most {@link COMMAND_MAX_LENGTH} characters (nothing is sent in that case).
 */
export function serveCommand(project: string): string {
	const problem = projectProblem(project);
	if (problem !== undefined) {
		throw new BackendRejectedError(
			'remote',
			'machine run',
			`the project name ${problem}`,
			'Fix transport.options.project in the config.yml of this project (the project as the peer knows it), then run: task strategy check'
		);
	}
	const command = `task serve -p ${project} --stdio`;
	if (command.length > COMMAND_MAX_LENGTH || !/^[\x20-\x7e]+$/.test(command)) {
		throw new BackendRejectedError(
			'remote',
			'machine run',
			'the command line for the peer is not printable ASCII of at most 2048 characters',
			'Use a shorter project name or its id in transport.options.project'
		);
	}
	return command;
}

/**
 * What the admin of the peer allows once, so that this transport can run: the exact command (and the shell, when the project names one)
 * with the input it declares: JSON, at most 64k (`--stdin-max`), and the character families of the text (`--stdin-chars`: machine
 * requires them to be named, `machine admin allow --help` lists them, they are NOT guessed here). Printed in the hint of a refusal;
 * `<peer>` is the reference the user wrote.
 */
export function allowEntryText(peer: string, project: string, shell: MachineShell | undefined): string {
	return `machine admin allow ${peer}${shell === undefined ? '' : ` --shell ${shell}`} --stdin json --stdin-max 64k --stdin-chars <families> -- "${serveCommand(project)}"`;
}

/** The sentence that goes with {@link allowEntryText}: where the character families are listed. */
export const ALLOW_FAMILIES_NOTE =
	'replace <families> with the character families that `machine admin allow --help` lists (a task text with accents needs the family that covers them)';
