import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expandTilde, isProjectInitialized, loadTaskConfig, resolveGlobalConfigDir } from './TaskConfigLoader';

describe('TaskConfigLoader', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-config-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe('expandTilde()', () => {
		it('expands ~ to home dir', () => {
			expect(expandTilde('~/foo')).toBe(path.join(os.homedir(), 'foo'));
		});

		it('leaves non-tilde paths unchanged', () => {
			expect(expandTilde('/absolute/path')).toBe('/absolute/path');
		});
	});

	describe('resolveGlobalConfigDir()', () => {
		it('returns override when provided', () => {
			expect(resolveGlobalConfigDir('/custom/dir')).toBe('/custom/dir');
		});

		it('expands tilde in override', () => {
			expect(resolveGlobalConfigDir('~/mydir')).toBe(path.join(os.homedir(), 'mydir'));
		});

		it('falls back to ~/.task when no override', () => {
			const original = process.env['TASK_CONFIG'];
			delete process.env['TASK_CONFIG'];
			try {
				expect(resolveGlobalConfigDir()).toBe(path.join(os.homedir(), '.task'));
			} finally {
				if (original !== undefined) process.env['TASK_CONFIG'] = original;
			}
		});
	});

	describe('isProjectInitialized()', () => {
		it('returns false when .task dir is absent', () => {
			expect(isProjectInitialized(tmpDir)).toBe(false);
		});

		it('returns true when .task dir exists', () => {
			fs.mkdirSync(path.join(tmpDir, '.task'));
			expect(isProjectInitialized(tmpDir)).toBe(true);
		});
	});

	describe('loadTaskConfig()', () => {
		it('returns defaults when no config files exist', () => {
			const config = loadTaskConfig({ configDir: tmpDir, projectDir: tmpDir });
			expect(config.statuses).toEqual(['backlog', 'in-progress', 'done']);
			expect(config.defaults.priority).toBe('medium');
			expect(config.globalHooks).toEqual({});
			expect(config.projectHooks).toEqual({});
		});

		it('loads global defaults', () => {
			fs.writeFileSync(path.join(tmpDir, 'config.yml'), 'defaults:\n  priority: high\n');
			const config = loadTaskConfig({ configDir: tmpDir, projectDir: tmpDir });
			expect(config.defaults.priority).toBe('high');
		});

		it('project priority overrides global priority', () => {
			fs.writeFileSync(path.join(tmpDir, 'config.yml'), 'defaults:\n  priority: low\n');
			fs.mkdirSync(path.join(tmpDir, '.task'), { recursive: true });
			fs.writeFileSync(path.join(tmpDir, '.task', 'config.yml'), 'defaults:\n  priority: critical\n');
			const config = loadTaskConfig({ configDir: tmpDir, projectDir: tmpDir });
			expect(config.defaults.priority).toBe('critical');
		});

		it('project statuses replace defaults', () => {
			fs.mkdirSync(path.join(tmpDir, '.task'), { recursive: true });
			fs.writeFileSync(path.join(tmpDir, '.task', 'config.yml'), 'statuses:\n  - todo\n  - doing\n  - done\n');
			const config = loadTaskConfig({ configDir: tmpDir, projectDir: tmpDir });
			expect(config.statuses).toEqual(['todo', 'doing', 'done']);
		});

		it('loads global hooks', () => {
			fs.writeFileSync(path.join(tmpDir, 'config.yml'), 'hooks:\n  onTaskCreated: echo created\n');
			const config = loadTaskConfig({ configDir: tmpDir, projectDir: tmpDir });
			expect(config.globalHooks['onTaskCreated']).toBe('echo created');
		});

		it('keeps global and project hooks separate', () => {
			fs.writeFileSync(path.join(tmpDir, 'config.yml'), 'hooks:\n  onTaskCreated: echo global\n');
			fs.mkdirSync(path.join(tmpDir, '.task'), { recursive: true });
			fs.writeFileSync(path.join(tmpDir, '.task', 'config.yml'), 'hooks:\n  onStatusChange: node notify.js\n');
			const config = loadTaskConfig({ configDir: tmpDir, projectDir: tmpDir });
			expect(config.globalHooks['onTaskCreated']).toBe('echo global');
			expect(config.projectHooks['onStatusChange']).toBe('node notify.js');
			expect(config.globalHooks['onStatusChange']).toBeUndefined();
		});
	});
});
