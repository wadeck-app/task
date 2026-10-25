import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TaskConfigLoader } from './TaskConfigLoader';
import type { TaskProjectConfig } from './TaskConfigLoader';

describe('TaskConfigLoader', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-config-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe('TaskConfigLoader.expandTilde()', () => {
		it('expands ~ to home dir', () => {
			expect(TaskConfigLoader.expandTilde('~/foo')).toBe(path.join(os.homedir(), 'foo'));
		});

		it('leaves non-tilde paths unchanged', () => {
			expect(TaskConfigLoader.expandTilde('/absolute/path')).toBe('/absolute/path');
		});
	});

	describe('TaskConfigLoader.resolveGlobalConfigDir()', () => {
		it('returns override when provided', () => {
			expect(TaskConfigLoader.resolveGlobalConfigDir('/custom/dir')).toBe('/custom/dir');
		});

		it('expands tilde in override', () => {
			expect(TaskConfigLoader.resolveGlobalConfigDir('~/mydir')).toBe(path.join(os.homedir(), 'mydir'));
		});

		it('falls back to ~/.task when no override', () => {
			const original = process.env['TASK_CONFIG'];
			delete process.env['TASK_CONFIG'];
			try {
				expect(TaskConfigLoader.resolveGlobalConfigDir()).toBe(path.join(os.homedir(), '.task'));
			} finally {
				if (original !== undefined) process.env['TASK_CONFIG'] = original;
			}
		});
	});

	describe('TaskConfigLoader.load()', () => {
		it('is the global config alone: the default statuses, the global defaults and hooks, no project file', () => {
			fs.writeFileSync(
				path.join(tmpDir, 'config.yml'),
				'defaults:\n  priority: high\nhooks:\n  onTaskCreated: echo global\n'
			);

			const config = TaskConfigLoader.load({ configDir: tmpDir });

			expect(config.statuses).toEqual(['backlog', 'in-progress', 'done']);
			expect(config.defaults.priority).toBe('high');
			expect(config.globalHooks['onTaskCreated']).toBe('echo global');
			expect(config.projectHooks).toEqual({});
		});
	});

	const loadWithProject = (configDir: string, projectConfigFile: string) =>
		TaskConfigLoader.resolve({
			global: TaskConfigLoader.loadGlobal(configDir),
			project: TaskConfigLoader.readConfigFile<TaskProjectConfig>(projectConfigFile) ?? {},
			source: projectConfigFile,
		});

	describe('TaskConfigLoader.resolve() over the global config and one project file', () => {
		it('returns defaults when no config files exist', () => {
			const config = loadWithProject(tmpDir, path.join(tmpDir, 'project', 'config.yml'));
			expect(config.statuses).toEqual(['backlog', 'in-progress', 'done']);
			expect(config.defaultStatus).toBe('backlog');
			expect(config.terminalStatuses).toEqual([]);
			expect(config.defaults.priority).toBe('medium');
			expect(config.globalHooks).toEqual({});
			expect(config.projectHooks).toEqual({});
		});

		it('loads global defaults', () => {
			fs.writeFileSync(path.join(tmpDir, 'config.yml'), 'defaults:\n  priority: high\n');
			const config = loadWithProject(tmpDir, path.join(tmpDir, 'project', 'config.yml'));
			expect(config.defaults.priority).toBe('high');
		});

		it('project priority overrides global priority', () => {
			fs.writeFileSync(path.join(tmpDir, 'config.yml'), 'defaults:\n  priority: low\n');
			fs.mkdirSync(path.join(tmpDir, 'project'), { recursive: true });
			fs.writeFileSync(path.join(tmpDir, 'project', 'config.yml'), 'defaults:\n  priority: critical\n');
			const config = loadWithProject(tmpDir, path.join(tmpDir, 'project', 'config.yml'));
			expect(config.defaults.priority).toBe('critical');
		});

		it('project statuses replace defaults', () => {
			fs.mkdirSync(path.join(tmpDir, 'project'), { recursive: true });
			fs.writeFileSync(path.join(tmpDir, 'project', 'config.yml'), 'statuses:\n  - todo\n  - doing\n  - done\n');
			const config = loadWithProject(tmpDir, path.join(tmpDir, 'project', 'config.yml'));
			expect(config.statuses).toEqual(['todo', 'doing', 'done']);
		});

		it('accepts a mix of plain-string and object status entries', () => {
			fs.mkdirSync(path.join(tmpDir, 'project'), { recursive: true });
			fs.writeFileSync(
				path.join(tmpDir, 'project', 'config.yml'),
				'statuses:\n  - backlog\n  - in-progress\n  - name: done\n    terminal: true\n'
			);
			const config = loadWithProject(tmpDir, path.join(tmpDir, 'project', 'config.yml'));
			expect(config.statuses).toEqual(['backlog', 'in-progress', 'done']);
			expect(config.terminalStatuses).toEqual(['done']);
			expect(config.defaultStatus).toBe('backlog');
		});

		it('uses the status explicitly marked default: true, even if not first', () => {
			fs.mkdirSync(path.join(tmpDir, 'project'), { recursive: true });
			fs.writeFileSync(
				path.join(tmpDir, 'project', 'config.yml'),
				'statuses:\n  - backlog\n  - name: in-progress\n    default: true\n  - name: done\n    terminal: true\n'
			);
			const config = loadWithProject(tmpDir, path.join(tmpDir, 'project', 'config.yml'));
			expect(config.defaultStatus).toBe('in-progress');
		});

		it('falls back to the first status when none is marked default', () => {
			fs.mkdirSync(path.join(tmpDir, 'project'), { recursive: true });
			fs.writeFileSync(path.join(tmpDir, 'project', 'config.yml'), 'statuses:\n  - todo\n  - doing\n  - done\n');
			const config = loadWithProject(tmpDir, path.join(tmpDir, 'project', 'config.yml'));
			expect(config.defaultStatus).toBe('todo');
		});

		it('throws when more than one status is marked default: true', () => {
			fs.mkdirSync(path.join(tmpDir, 'project'), { recursive: true });
			fs.writeFileSync(
				path.join(tmpDir, 'project', 'config.yml'),
				'statuses:\n  - name: backlog\n    default: true\n  - name: done\n    default: true\n'
			);
			expect(() => loadWithProject(tmpDir, path.join(tmpDir, 'project', 'config.yml'))).toThrow(
				/Multiple statuses marked "default: true"/
			);
		});

		it('loads global hooks', () => {
			fs.writeFileSync(path.join(tmpDir, 'config.yml'), 'hooks:\n  onTaskCreated: echo created\n');
			const config = loadWithProject(tmpDir, path.join(tmpDir, 'project', 'config.yml'));
			expect(config.globalHooks['onTaskCreated']).toBe('echo created');
		});

		it('keeps global and project hooks separate', () => {
			fs.writeFileSync(path.join(tmpDir, 'config.yml'), 'hooks:\n  onTaskCreated: echo global\n');
			fs.mkdirSync(path.join(tmpDir, 'project'), { recursive: true });
			fs.writeFileSync(path.join(tmpDir, 'project', 'config.yml'), 'hooks:\n  onStatusChange: node notify.js\n');
			const config = loadWithProject(tmpDir, path.join(tmpDir, 'project', 'config.yml'));
			expect(config.globalHooks['onTaskCreated']).toBe('echo global');
			expect(config.projectHooks['onStatusChange']).toBe('node notify.js');
			expect(config.globalHooks['onStatusChange']).toBeUndefined();
		});
	});

	describe('readConfigFile()', () => {
		it('returns undefined for a missing file', () => {
			expect(TaskConfigLoader.readConfigFile(path.join(tmpDir, 'nope.yml'))).toBeUndefined();
		});

		it('returns undefined for an empty file', () => {
			const file = path.join(tmpDir, 'empty.yml');
			fs.writeFileSync(file, '');
			expect(TaskConfigLoader.readConfigFile(file)).toBeUndefined();
		});

		it('names the file when the YAML is invalid', () => {
			const file = path.join(tmpDir, 'broken.yml');
			fs.writeFileSync(file, 'statuses: [a, b');
			expect(() => TaskConfigLoader.readConfigFile(file)).toThrow(file);
		});

		it('names the file when the top level is not a mapping', () => {
			const file = path.join(tmpDir, 'list.yml');
			fs.writeFileSync(file, '- a\n- b\n');
			expect(() => TaskConfigLoader.readConfigFile(file)).toThrow(file);
			expect(() => TaskConfigLoader.readConfigFile(file)).toThrow(/mapping/);
		});
	});

	describe('resolve()', () => {
		it('builds the resolved config from already merged parts, global hooks and project hooks apart', () => {
			const config = TaskConfigLoader.resolve({
				global: { defaults: { priority: 'low' }, hooks: { onTaskCreated: 'echo g' } },
				project: {
					statuses: ['todo', { name: 'done', terminal: true }],
					types: ['bug'],
					hooks: { onStatusChange: 'p' },
				},
				source: '/x/config.yml',
			});
			expect(config.statuses).toEqual(['todo', 'done']);
			expect(config.terminalStatuses).toEqual(['done']);
			expect(config.types).toEqual(['bug']);
			expect(config.defaults.priority).toBe('low');
			expect(config.globalHooks).toEqual({ onTaskCreated: 'echo g' });
			expect(config.projectHooks).toEqual({ onStatusChange: 'p' });
		});

		it('names the source in the status errors', () => {
			expect(() =>
				TaskConfigLoader.resolve({ global: {}, project: { statuses: [] }, source: '/x/config.yml' })
			).toThrow('/x/config.yml');
			expect(() =>
				TaskConfigLoader.resolve({
					global: {},
					project: {
						statuses: [
							{ name: 'a', default: true },
							{ name: 'b', default: true },
						],
					},
					source: '/x/config.yml',
				})
			).toThrow(/\/x\/config\.yml.*Only one status/s);
		});
	});

	describe('loadGlobal()', () => {
		it('reads the global config.yml of the given directory, empty when absent', () => {
			expect(TaskConfigLoader.loadGlobal(tmpDir)).toEqual({});
			fs.writeFileSync(path.join(tmpDir, 'config.yml'), 'defaults:\n  priority: high\n');
			expect(TaskConfigLoader.loadGlobal(tmpDir)).toEqual({ defaults: { priority: 'high' } });
		});
	});

	describe('updateTypes()', () => {
		it('creates the file (and nothing else) when missing, through the injected writer', () => {
			const file = path.join(tmpDir, 'layer', 'config.yml');
			const writes: string[] = [];
			TaskConfigLoader.updateTypes(
				file,
				types => [...types, 'bug'],
				(target, content) => {
					writes.push(target);
					fs.writeFileSync(target, content, 'utf8');
				},
				{ createDirectory: true }
			);
			expect(writes).toEqual([file]);
			expect(TaskConfigLoader.readConfigFile<{ types: string[] }>(file)?.types).toEqual(['bug']);
		});

		it('does not create the directory unless asked: a vanished folder is an error, not a silent recreation', () => {
			const file = path.join(tmpDir, 'vanished', 'config.yml');
			expect(() => TaskConfigLoader.updateTypes(file, types => [...types, 'bug'])).toThrow();
			expect(fs.existsSync(path.dirname(file))).toBe(false);
		});

		it('keeps the other keys of the file', () => {
			const file = path.join(tmpDir, 'config.yml');
			fs.writeFileSync(file, 'statuses:\n  - a\n  - b\ntypes:\n  - bug\n');
			TaskConfigLoader.updateTypes(file, types => types.filter(t => t !== 'bug'));
			expect(TaskConfigLoader.readConfigFile(file)).toEqual({ statuses: ['a', 'b'], types: [] });
		});
	});
});
