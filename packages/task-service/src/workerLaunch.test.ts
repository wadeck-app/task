import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { launchWorker, windowsLaunchScript } from './workerLaunch.js';
import type { LaunchDeps, LaunchSpec, SpawnOptions, SpawnedProcess } from './workerLaunch.js';

const SPEC: LaunchSpec = {
	// violations-suppress: shared/no-out-of-repo-path Windows-form fixture in a string used to build a launch script, never touched on disk
	command: 'C:\\Program Files\\nodejs\\node.exe',
	// violations-suppress: shared/no-out-of-repo-path Windows-form fixture in a string used to build a launch script, never touched on disk
	args: ['C:\\Tools\\task cli\\TaskIndex.js', 'strategy', 'migrate', 'worker', '-p', 'abcd1234'],
	// violations-suppress: shared/no-out-of-repo-path Windows-form fixture in a string used to build a launch script, never touched on disk
	cwd: 'C:\\Work\\shop',
	// violations-suppress: shared/no-out-of-repo-path Windows-form fixture in a string used to build a launch script, never touched on disk
	logFile: 'C:\\Users\\me\\.config\\project\\projects\\abcd\\task\\data\\migrating\\worker.out.log',
	env: { PATH: 'x', TASK_PROJECT: '' },
};

class FakeChild extends EventEmitter implements SpawnedProcess {
	unrefs = 0;
	constructor(
		readonly pid: number | undefined,
		private readonly outcome: 'spawn' | Error
	) {
		super();
		queueMicrotask(() => (this.outcome === 'spawn' ? this.emit('spawn') : this.emit('error', this.outcome)));
	}
	unref(): void {
		this.unrefs++;
	}
}

function deps(platform: NodeJS.Platform, outcome: 'spawn' | Error = 'spawn') {
	const calls: Array<{ command: string; args: string[]; options: SpawnOptions; child: FakeChild }> = [];
	const scripts: Array<{ file: string; text: string }> = [];
	const logs: Array<{ file: string; closed: boolean }> = [];
	const made: LaunchDeps = {
		platform,
		spawn: (command, args, options) => {
			const child = new FakeChild(platform === 'win32' ? 111 : 222, outcome);
			calls.push({ command, args, options, child });
			return child;
		},
		writeScript: (file, text) => void scripts.push({ file, text }),
		// violations-suppress: shared/no-out-of-repo-path Windows-form fixture in a string used to build a launch script, never touched on disk
		scriptDir: 'C:\\Temp',
		openLog: file => {
			const entry = { file, closed: false };
			logs.push(entry);
			return { fd: 9, close: () => void (entry.closed = true) };
		},
		now: () => 1_700_000_000_000,
	};
	return { made, calls, scripts, logs };
}

describe('windowsLaunchScript', () => {
	it('runs the command hidden (window style 0) without waiting, with its output appended to the log', () => {
		const script = windowsLaunchScript(SPEC);

		expect(script).toBe(
			[
				'Dim oShell',
				'Set oShell = CreateObject("WScript.Shell")',
				// violations-suppress: shared/no-out-of-repo-path Windows-form fixture in a string used to build a launch script, never touched on disk
				'oShell.Run "cmd /c ""cd /d ""C:\\Work\\shop"" && ""C:\\Program Files\\nodejs\\node.exe"" ""C:\\Tools\\task cli\\TaskIndex.js"" ""strategy"" ""migrate"" ""worker"" ""-p"" ""abcd1234"" >> ""C:\\Users\\me\\.config\\project\\projects\\abcd\\task\\data\\migrating\\worker.out.log"" 2>&1""", 0, False',
				'',
			].join('\r\n')
		);
	});

	it.each([
		['a double quote', 'a"b'],
		['a percent sign', '50%off'],
		['a line break', 'a\nb'],
	])('refuses an argument with %s, naming it, since cmd would read it as something else', (_name, bad) => {
		expect(() => windowsLaunchScript({ ...SPEC, args: [...SPEC.args, bad] })).toThrow(/cannot be passed/);
		expect(() => windowsLaunchScript({ ...SPEC, logFile: bad })).toThrow(/cannot be passed/);
	});
});

describe('launchWorker', () => {
	it('on Windows writes the hidden-window script, runs it with the script host, and lets go of it', async () => {
		const { made, calls, scripts } = deps('win32');

		const result = await launchWorker(SPEC, made);

		expect(scripts).toHaveLength(1);
		// violations-suppress: shared/no-out-of-repo-path Windows-form fixture in a string used to build a launch script, never touched on disk
		expect(scripts[0]?.file).toBe('C:\\Temp\\task-migrate-worker-1700000000000.vbs');
		expect(scripts[0]?.text).toBe(windowsLaunchScript(SPEC));
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			command: 'wscript.exe',
			args: [scripts[0]?.file],
			options: { windowsHide: true, detached: true, stdio: 'ignore', shell: false, cwd: SPEC.cwd, env: SPEC.env },
		});
		expect(calls[0]?.child.unrefs).toBe(1);
		// the process that started is the script host, which ends at once: the worker's pid is the one it writes in its lock
		expect(result).toEqual({ via: 'script-host' });
	});

	it('elsewhere spawns the command itself, detached, with stdout and stderr in the log file, and closes the log in this process', async () => {
		const { made, calls, scripts, logs } = deps('linux');

		const result = await launchWorker(SPEC, made);

		expect(scripts).toEqual([]);
		expect(calls[0]).toMatchObject({
			command: SPEC.command,
			args: [...SPEC.args],
			options: {
				windowsHide: true,
				detached: true,
				stdio: ['ignore', 9, 9],
				shell: false,
				cwd: SPEC.cwd,
				env: SPEC.env,
			},
		});
		expect(calls[0]?.child.unrefs).toBe(1);
		expect(logs).toEqual([{ file: SPEC.logFile, closed: true }]);
		expect(result).toEqual({ via: 'detached', pid: 222 });
	});

	it('says what could not be started, why, and how to run the worker by hand', async () => {
		const { made, logs } = deps('linux', new Error('spawn node ENOENT'));

		await expect(launchWorker(SPEC, made)).rejects.toThrow(/cannot start the background worker.*ENOENT/s);
		await expect(launchWorker(SPEC, made)).rejects.toThrow(/strategy migrate worker/);
		expect(logs.every(entry => entry.closed)).toBe(true);
	});

	it('closes the log even when the spawn throws at once', async () => {
		const { made, logs } = deps('linux');
		made.spawn = () => {
			throw new Error('EPERM');
		};

		await expect(launchWorker(SPEC, made)).rejects.toThrow(/EPERM/);
		expect(logs[0]?.closed).toBe(true);
	});
});
