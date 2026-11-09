// Logic of the bin shim (ci/templates/bin-launcher.js.tmpl) with every side effect injected, so the macOS / Linux
// paths run on any host.
//
// Incident (macOS arm64 user report): after "platform package ... missing -- installing..." every `task` command
// exited in ~60 ms with NO output. Cause proven from the published tarball: the platform package ships its launcher
// with mode 0644 (npm only chmods `bin` entries), execFileSync threw EACCES, and the old catch turned any error
// without a numeric `status` into a silent exit 1. These tests pin: no silent failure, node is run directly for every
// command but `start`, the launcher is only needed (and installed) for `start`.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(__dirname, '..', 'ci', 'templates', 'bin-launcher.js.tmpl');

interface Deps {
	platform: string;
	arch: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	nodePath: string;
	bundlePath: string;
	exists: (p: string) => boolean;
	resolve: (spec: string) => string;
	install: (pkg: string) => void;
	execFile: (
		bin: string,
		args: string[],
		opts: { stdio: string; windowsHide: boolean; env: NodeJS.ProcessEnv }
	) => void;
	assertExecutable: (p: string) => void;
	makeExecutable: (p: string) => void;
	stdout: { write: (s: string) => unknown };
	stderr: { write: (s: string) => unknown };
}

/** Renders the template as generate-platform-packages.sh does and loads it WITHOUT running its entry point. */
function loadRun(): (deps: Deps) => number {
	const source = readFileSync(TEMPLATE, 'utf8')
		.replaceAll('{{CLI_NAME}}', 'task')
		.replaceAll('{{PKG_PREFIX}}', 'task-cli')
		.replace(/^#!.*\n/, '');
	const mod: { exports: { run?: (deps: Deps) => number } } = { exports: {} };
	// require.main is undefined here, so `require.main === module` is false: the shim does not run itself.
	new Function('module', 'exports', 'require', '__dirname', source)(mod, mod.exports, () => undefined, '/pkg/bin');
	if (mod.exports.run === undefined) throw new Error('the rendered shim does not export run()');
	return mod.exports.run;
}

interface Call {
	bin: string;
	args: string[];
	opts: { stdio: string; windowsHide: boolean; env: NodeJS.ProcessEnv };
}

function setup(over: Partial<Deps> = {}) {
	const calls: Call[] = [];
	const installs: string[] = [];
	const chmods: string[] = [];
	const out: string[] = [];
	const err: string[] = [];
	const deps: Deps = {
		platform: 'darwin',
		arch: 'arm64',
		args: ['cli', 'version'],
		env: { PATH: '/usr/bin' },
		nodePath: '/usr/local/bin/node',
		bundlePath: '/pkg/task.cjs',
		exists: () => true,
		resolve: spec => `/modules/${spec}`,
		install: pkg => {
			installs.push(pkg);
		},
		execFile: (bin, args, opts) => {
			calls.push({ bin, args, opts });
		},
		assertExecutable: () => undefined,
		makeExecutable: p => {
			chmods.push(p);
		},
		stdout: { write: s => out.push(s) },
		stderr: { write: s => err.push(s) },
		...over,
	};
	return { deps, calls, installs, chmods, out: () => out.join(''), err: () => err.join('') };
}

/** What the old shim's execFileSync raises on a non-executable file (macOS / Linux): no numeric status. */
function errnoError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code, status: null, signal: null });
}

describe('bin shim: common path (every command but start)', () => {
	it.each([
		['darwin', 'arm64'],
		['win32', 'x64'],
	])(
		'%s-%s: runs `node <bundle> <args>` directly, never resolves nor installs a platform package',
		(platform, arch) => {
			const run = loadRun();
			const t = setup({
				platform,
				arch,
				args: ['cli', 'update'],
				resolve: () => {
					throw new Error('resolve must not be called');
				},
				install: () => {
					throw new Error('install must not be called');
				},
			});

			expect(run(t.deps)).toBe(0);

			expect(t.calls).toHaveLength(1);
			expect(t.calls[0].bin).toBe('/usr/local/bin/node');
			expect(t.calls[0].args).toEqual(['/pkg/task.cjs', 'cli', 'update']);
			expect(t.calls[0].opts.stdio).toBe('inherit');
			expect(t.calls[0].opts.env).toEqual({ PATH: '/usr/bin' });
			expect(t.err()).toBe('');
			expect(t.out()).toBe('');
		}
	);

	it('--cli-background / --cli-foreground are stripped from the args and select the stdio (last wins)', () => {
		const run = loadRun();
		for (const [args, stdio] of [
			[['list', '--cli-background'], 'ignore'],
			[['list', '--cli-foreground'], 'inherit'],
			[['--cli-background', 'list', '--cli-foreground'], 'inherit'],
			[['--cli-foreground', 'list', '--cli-background'], 'ignore'],
		] as const) {
			const t = setup({ args: [...args] });
			run(t.deps);
			expect(t.calls[0].args, args.join(' ')).toEqual(['/pkg/task.cjs', 'list']);
			expect(t.calls[0].opts.stdio, args.join(' ')).toBe(stdio);
		}
	});

	it.each([[0], [1], [2], [130]])('propagates the exit code %i of the command, without adding any message', code => {
		const run = loadRun();
		const t = setup({
			execFile: () => {
				throw Object.assign(new Error('Command failed'), { status: code, signal: null });
			},
		});
		// A zero status never throws in reality; the others must come back as is.
		expect(run(t.deps)).toBe(code);
		expect(t.err()).toBe('');
	});

	it('the old silent failure is gone: node that cannot be started is reported with code, platform and fix, exit 1', () => {
		const run = loadRun();
		const t = setup({
			execFile: () => {
				throw errnoError('ENOENT', 'spawnSync /usr/local/bin/node ENOENT');
			},
		});

		expect(run(t.deps)).toBe(1);

		expect(t.err()).toContain('task: cannot run node on the CLI bundle /pkg/task.cjs');
		expect(t.err()).toContain('/usr/local/bin/node');
		expect(t.err()).toContain('darwin-arm64');
		expect(t.err()).toContain('ENOENT');
		expect(t.err()).toContain('npm install -g @wadeck-app/task-cli');
	});

	it('a command killed by a signal is reported, exit 1', () => {
		const run = loadRun();
		const t = setup({
			execFile: () => {
				throw Object.assign(new Error('Command failed'), { status: null, signal: 'SIGKILL' });
			},
		});
		expect(run(t.deps)).toBe(1);
		expect(t.err()).toContain('terminated by signal SIGKILL');
	});
});

// Owner decision: Intel Macs (and linux, and every other platform) are not supported at all, so no command runs there,
// not even the ones that only need node.
describe('bin shim: unsupported platforms fail early and loudly', () => {
	const platforms: [string, string][] = [
		['darwin', 'x64'],
		['linux', 'x64'],
		['linux', 'arm64'],
		['win32', 'arm64'],
		['win32', 'ia32'],
		['freebsd', 'x64'],
	];
	const argLists: string[][] = [['cli', 'version'], ['--version'], ['list'], ['start']];
	const cases = platforms.flatMap(([platform, arch]) => argLists.map(args => [platform, arch, args] as const));

	it.each(cases)(
		'%s-%s `task %s`: exact message, exit 1, nothing executed, resolved nor installed',
		(platform, arch, args) => {
			const run = loadRun();
			const t = setup({
				platform,
				arch,
				args: [...args],
				resolve: () => {
					throw new Error('resolve must not be called');
				},
				install: () => {
					throw new Error('install must not be called');
				},
			});

			expect(run(t.deps)).toBe(1);

			expect(t.err()).toBe(
				`task: unsupported platform ${platform}-${arch}. Supported: win32-x64, darwin-arm64 (Apple silicon).\n`
			);
			expect(t.out()).toBe('');
			expect(t.calls).toHaveLength(0);
			expect(t.installs).toHaveLength(0);
			expect(t.chmods).toHaveLength(0);
		}
	);

	it('the platform check comes before the bundle check (an unsupported host is not told to reinstall)', () => {
		const run = loadRun();
		const t = setup({ platform: 'darwin', arch: 'x64', exists: () => false });
		expect(run(t.deps)).toBe(1);
		expect(t.err()).toContain('unsupported platform darwin-x64');
		expect(t.err()).not.toContain('incomplete');
	});

	it('the template has no trace of darwin-x64 outside the unsupported message', () => {
		const source = readFileSync(TEMPLATE, 'utf8');
		expect(source).not.toMatch(/PKG_PREFIX\}\}-darwin-x64/);
		expect(source).not.toContain("'darwin-x64'");
	});
});

describe('bin shim: incomplete install', () => {
	it('bundle missing: names the file, says incomplete, gives the reinstall command, runs nothing', () => {
		const run = loadRun();
		const t = setup({ exists: () => false });
		expect(run(t.deps)).toBe(1);
		expect(t.err()).toContain('/pkg/task.cjs');
		expect(t.err()).toContain('incomplete');
		expect(t.err()).toContain('npm install -g @wadeck-app/task-cli');
		expect(t.calls).toHaveLength(0);
		expect(t.installs).toHaveLength(0);
	});
});

describe('bin shim: start (the only command that needs the Go launcher)', () => {
	it.each([
		['darwin', 'arm64', '@wadeck-app/task-cli-darwin-arm64/task'],
		['win32', 'x64', '@wadeck-app/task-cli-win32-x64/task.exe'],
	])('%s-%s: runs the launcher with LAUNCHER_BUNDLE_OVERRIDE and the args', (platform, arch, spec) => {
		const run = loadRun();
		const t = setup({ platform, arch, args: ['start', '--x'] });

		expect(run(t.deps)).toBe(0);

		expect(t.calls).toHaveLength(1);
		expect(t.calls[0].bin).toBe(`/modules/${spec}`);
		expect(t.calls[0].args).toEqual(['start', '--x']);
		expect(t.calls[0].opts.env.LAUNCHER_BUNDLE_OVERRIDE).toBe('/pkg/task.cjs');
		expect(t.calls[0].opts.env.PATH).toBe('/usr/bin');
		expect(t.calls[0].opts.stdio).toBe('inherit');
		expect(t.installs).toHaveLength(0);
	});

	it('propagates the launcher exit code', () => {
		const run = loadRun();
		const t = setup({
			args: ['start'],
			execFile: () => {
				throw Object.assign(new Error('x'), { status: 7, signal: null });
			},
		});
		expect(run(t.deps)).toBe(7);
		expect(t.err()).toBe('');
	});

	it('platform package missing: installs it (announced), resolves again, then runs the launcher', () => {
		const run = loadRun();
		let installed = false;
		const t = setup({
			args: ['start'],
			resolve: spec => {
				if (!installed) throw new Error('not found');
				return `/modules/${spec}`;
			},
			install: () => {
				installed = true;
			},
		});
		const installs: string[] = [];
		const original = t.deps.install;
		t.deps.install = pkg => {
			installs.push(pkg);
			original(pkg);
		};

		expect(run(t.deps)).toBe(0);

		expect(installs).toEqual(['@wadeck-app/task-cli-darwin-arm64']);
		expect(t.err()).toContain('platform package @wadeck-app/task-cli-darwin-arm64 missing -- installing...');
		expect(t.calls[0].bin).toBe('/modules/@wadeck-app/task-cli-darwin-arm64/task');
	});

	it('install failing: relays npm output, names the package and the fix, exit 1, launcher not run', () => {
		const run = loadRun();
		const t = setup({
			args: ['start'],
			resolve: () => {
				throw new Error('not found');
			},
			install: () => {
				throw Object.assign(new Error('npm'), { status: 1, stdout: 'npm-out\n', stderr: 'npm ERR! E404\n' });
			},
		});

		expect(run(t.deps)).toBe(1);

		expect(t.out()).toContain('npm-out');
		expect(t.err()).toContain('npm ERR! E404');
		expect(t.err()).toContain('install of @wadeck-app/task-cli-darwin-arm64 failed (exit 1)');
		expect(t.err()).toContain('fix: npm install -g @wadeck-app/task-cli-darwin-arm64');
		expect(t.calls).toHaveLength(0);
	});

	it('installed but still unresolvable: says so with the reinstall command, exit 1', () => {
		const run = loadRun();
		const t = setup({
			args: ['start'],
			resolve: () => {
				throw new Error('not found');
			},
		});
		expect(run(t.deps)).toBe(1);
		expect(t.err()).toContain('installed @wadeck-app/task-cli-darwin-arm64 but cannot resolve');
		expect(t.err()).toContain('npm install -g @wadeck-app/task-cli');
		expect(t.calls).toHaveLength(0);
	});

	it('launcher without the exec bit (the published 0644 file): made executable before it runs', () => {
		const run = loadRun();
		const t = setup({
			args: ['start'],
			assertExecutable: () => {
				throw errnoError('EACCES', 'permission denied');
			},
		});

		expect(run(t.deps)).toBe(0);

		expect(t.chmods).toEqual(['/modules/@wadeck-app/task-cli-darwin-arm64/task']);
		expect(t.calls).toHaveLength(1);
	});

	it('launcher not executable and chmod refused: message with path and `chmod +x` fix, exit 1', () => {
		const run = loadRun();
		const t = setup({
			args: ['start'],
			assertExecutable: () => {
				throw errnoError('EACCES', 'permission denied');
			},
			makeExecutable: () => {
				throw errnoError('EPERM', 'operation not permitted');
			},
		});

		expect(run(t.deps)).toBe(1);

		expect(t.err()).toContain('/modules/@wadeck-app/task-cli-darwin-arm64/task is not executable');
		expect(t.err()).toContain('operation not permitted');
		expect(t.err()).toContain('chmod +x "/modules/@wadeck-app/task-cli-darwin-arm64/task"');
		expect(t.calls).toHaveLength(0);
	});

	it.each([
		['EACCES', 'spawnSync EACCES'],
		['ENOENT', 'spawnSync ENOENT'],
		['ENOEXEC', 'spawnSync ENOEXEC'],
	])(
		'launcher exec failing with %s: message with code, path, platform and fix; exit 1 (never silent)',
		(code, message) => {
			const run = loadRun();
			const t = setup({
				args: ['start'],
				execFile: () => {
					throw errnoError(code, message);
				},
			});

			expect(run(t.deps)).toBe(1);

			expect(t.err()).toContain('cannot run the launcher (/modules/@wadeck-app/task-cli-darwin-arm64/task)');
			expect(t.err()).toContain('darwin-arm64');
			expect(t.err()).toContain(code);
			expect(t.err()).toContain('chmod +x');
			expect(t.err()).toContain('npm install -g @wadeck-app/task-cli');
		}
	);

	it('launcher killed by a signal: reported, exit 1', () => {
		const run = loadRun();
		const t = setup({
			args: ['start'],
			execFile: () => {
				throw Object.assign(new Error('x'), { status: null, signal: 'SIGSEGV' });
			},
		});
		expect(run(t.deps)).toBe(1);
		expect(t.err()).toContain('terminated by signal SIGSEGV');
	});

	it('win32 does not look at the exec bit', () => {
		const run = loadRun();
		const t = setup({
			platform: 'win32',
			arch: 'x64',
			args: ['start'],
			assertExecutable: () => {
				throw new Error('must not be called');
			},
		});
		expect(run(t.deps)).toBe(0);
	});
});
