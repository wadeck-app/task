import { describe, expect, it } from 'vitest';

import { runPluginsCommand } from './PluginsCommand.js';

describe('task plugins list', () => {
	it('prints table with all four built-in plugins', () => {
		const result = runPluginsCommand(['list'], false);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('none');
		expect(result.output).toContain('worktree');
		expect(result.output).toContain('cli-approval');
		expect(result.output).toContain('file-approval');
		expect(result.output).toContain('plugins.none.default');
		expect(result.output).toContain('workspace');
		expect(result.output).toContain('approval');
	});

	it('outputs valid JSON array with --json', () => {
		const result = runPluginsCommand(['list', '--json'], false);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.output) as Array<{ id: string; extensionPoint: string; typeString: string }>;
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed.length).toBeGreaterThanOrEqual(4);
		for (const entry of parsed) {
			expect(typeof entry.id).toBe('string');
			expect(typeof entry.extensionPoint).toBe('string');
			expect(typeof entry.typeString).toBe('string');
		}
	});

	it('outputs valid JSON when jsonMode is true', () => {
		const result = runPluginsCommand(['list'], true);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.output) as unknown[];
		expect(Array.isArray(parsed)).toBe(true);
	});
});

describe('task plugins config', () => {
	it('returns snippet for none', () => {
		const result = runPluginsCommand(['config', 'none'], false);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('plugins.none.default');
	});

	it('returns snippet for worktree with baseDir', () => {
		const result = runPluginsCommand(['config', 'worktree'], false);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('plugins.worktree.default');
		expect(result.output).toContain('baseDir');
	});

	it('returns snippet for cli-approval with TTY note', () => {
		const result = runPluginsCommand(['config', 'cli-approval'], false);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('plugins.cli-approval.default');
		expect(result.output).toContain('TTY');
	});

	it('returns snippet for file-approval with request/response details', () => {
		const result = runPluginsCommand(['config', 'file-approval'], false);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('plugins.file-approval.default');
		expect(result.output).toContain('request.json');
		expect(result.output).toContain('response.json');
	});

	it('returns JSON with all fields when --json', () => {
		const result = runPluginsCommand(['config', 'file-approval', '--json'], false);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.output) as {
			id: string;
			extensionPoint: string;
			typeString: string;
			snippet: string;
			options: Record<string, string>;
		};
		expect(parsed.id).toBe('file-approval');
		expect(parsed.extensionPoint).toBe('approval');
		expect(parsed.typeString).toBe('plugins.file-approval.default');
		expect(typeof parsed.snippet).toBe('string');
		expect(Object.keys(parsed.options).length).toBeGreaterThan(0);
	});

	it('returns error for unknown plugin', () => {
		const result = runPluginsCommand(['config', 'totally-unknown-xyz'], false);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('unknown plugin');
		expect(result.output).toContain('totally-unknown-xyz');
	});

	it('returns JSON error for unknown plugin when jsonMode', () => {
		const result = runPluginsCommand(['config', 'totally-unknown-xyz'], true);
		expect(result.exitCode).toBe(1);
		const parsed = JSON.parse(result.output) as { error: string };
		expect(typeof parsed.error).toBe('string');
	});
});
