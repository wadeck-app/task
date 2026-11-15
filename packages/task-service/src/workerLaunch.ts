// Launches the background worker of a migration as a process that outlives the command that started it, with no window.
//
// Windows: `windowsHide` of Node only reaches the direct child, so a console flashes or stays when a shell is in between. The one way
// that holds is the script host: a VBScript run by `wscript.exe` starts the command with window style 0 (SW_HIDE), applied by the
// operating system to the whole tree, not by Node (see docs/windows-hidden-process.md of the owner). The script is tiny and may stay in
// the temp folder. The script host ends at once, so the pid of the worker is the one it writes in its own lock, not the one spawned here.
// Elsewhere: the command itself is spawned detached, with its output appended to the log file.
//
// Everything with a side effect is a dependency (spawn, writing the script, opening the log), so this runs in a test without a process.
import * as path from 'node:path';

export interface LaunchSpec {
	command: string;
	args: readonly string[];
	cwd: string;
	/** The worker's own stdout and stderr (not the migration log): appended, never truncated. */
	logFile: string;
	/** The environment of the worker (the script host passes its own on to it). */
	env: NodeJS.ProcessEnv;
}

export interface SpawnedProcess {
	pid?: number | undefined;
	unref(): void;
	once(event: 'spawn' | 'error', listener: (error?: Error) => void): unknown;
}

export interface SpawnOptions {
	detached: boolean;
	stdio: 'ignore' | ['ignore', number, number];
	windowsHide: boolean;
	cwd: string;
	env: NodeJS.ProcessEnv;
	shell: false;
}

export interface LaunchDeps {
	platform: NodeJS.Platform;
	spawn: (command: string, args: string[], options: SpawnOptions) => SpawnedProcess;
	writeScript: (file: string, text: string) => void;
	/** Where the script is written (the OS temp folder). */
	scriptDir: string;
	/** Opens the log for appending: the descriptor the worker's output goes to, and the way to close it in this process. */
	openLog: (file: string) => { fd: number; close: () => void };
	/** The clock in milliseconds (names the script). */
	now: () => number;
}

// What cmd.exe would read as something else even inside double quotes: a quote ends the argument, % expands a variable.
const UNSAFE = /["%\r\n\0]/;

function quoted(text: string): string {
	if (UNSAFE.test(text)) {
		throw new Error(
			`the argument ${JSON.stringify(text)} cannot be passed to a hidden Windows process (it holds a double quote, a percent sign or a line break, which cmd.exe would read as something else). Rename the folder or file, or run the worker in the foreground: task strategy migrate worker`
		);
	}
	return `"${text}"`;
}

/** The VBScript that starts the worker hidden: `cd` to its folder, the command, its output appended to the log, no wait. */
export function windowsLaunchScript(spec: LaunchSpec): string {
	const command = [spec.command, ...spec.args].map(quoted).join(' ');
	// cmd /c strips the first and the last quote of the line when it starts with one, so the whole line is wrapped in a pair.
	const line = `cmd /c "cd /d ${quoted(spec.cwd)} && ${command} >> ${quoted(spec.logFile)} 2>&1"`;
	return [
		'Dim oShell',
		'Set oShell = CreateObject("WScript.Shell")',
		`oShell.Run "${line.replace(/"/g, '""')}", 0, False`,
		'',
	].join('\r\n');
}

function started(child: SpawnedProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		child.once('spawn', () => resolve());
		child.once('error', error => reject(error ?? new Error('the process could not be started')));
	});
}

function failure(spec: LaunchSpec, cause: unknown): Error {
	const reason = cause instanceof Error ? cause.message : String(cause);
	return new Error(
		`cannot start the background worker: ${reason}. Run it in the foreground instead (it keeps this terminal until it ends, Ctrl+C pauses it): ${[spec.command, ...spec.args].join(' ')}`,
		{ cause }
	);
}

export async function launchWorker(
	spec: LaunchSpec,
	deps: LaunchDeps
): Promise<{ pid?: number; via: 'script-host' | 'detached' }> {
	if (deps.platform === 'win32') {
		const script = path.win32.join(deps.scriptDir, `task-migrate-worker-${deps.now()}.vbs`);
		try {
			deps.writeScript(script, windowsLaunchScript(spec));
			const child = deps.spawn('wscript.exe', [script], {
				detached: true,
				stdio: 'ignore',
				windowsHide: true,
				cwd: spec.cwd,
				env: spec.env,
				shell: false,
			});
			await started(child);
			child.unref();
		} catch (error) {
			throw failure(spec, error);
		}
		return { via: 'script-host' };
	}
	const log = deps.openLog(spec.logFile);
	try {
		const child = deps.spawn(spec.command, [...spec.args], {
			detached: true,
			stdio: ['ignore', log.fd, log.fd],
			windowsHide: true,
			cwd: spec.cwd,
			env: spec.env,
			shell: false,
		});
		await started(child);
		child.unref();
		return { via: 'detached', ...(child.pid === undefined ? {} : { pid: child.pid }) };
	} catch (error) {
		throw failure(spec, error);
	} finally {
		log.close();
	}
}
