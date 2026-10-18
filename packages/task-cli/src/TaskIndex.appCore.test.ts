import { describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn());
vi.mock('./commands/AppCoreCommand.js', () => ({ runAppCoreCommand: run }));

import { runTaskCommand } from './TaskIndex.js';

describe('task cli register / unregister routing', () => {
	it.each(['register', 'unregister'] as const)(
		'routes "task cli %s" to the app-core command (no project needed)',
		async sub => {
			run.mockResolvedValue({ exitCode: 0, output: 'done' });
			const result = await runTaskCommand(['cli', sub], process.cwd());
			expect(run).toHaveBeenCalledWith(sub, false);
			expect(result).toEqual({ exitCode: 0, output: 'done' });
		}
	);

	it('passes --json through', async () => {
		run.mockResolvedValue({ exitCode: 1, output: '{"error":"x"}' });
		const result = await runTaskCommand(['cli', 'register', '--json'], process.cwd());
		expect(run).toHaveBeenCalledWith('register', true);
		expect(result.exitCode).toBe(1);
	});

	it('lists register and unregister in the cli help and in the unknown-subcommand hint', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		await runTaskCommand(['cli', 'help'], process.cwd());
		const help = write.mock.calls.map(c => String(c[0])).join('');
		expect(help).toContain('register');
		expect(help).toContain('unregister');
		const bad = await runTaskCommand(['cli', 'nope'], process.cwd());
		expect(bad.output).toContain('register');
	});
});
