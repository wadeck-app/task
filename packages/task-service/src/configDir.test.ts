import { homedir } from 'node:os';
import { join } from 'node:path';

import { getTaskConfigDir, getTaskLogDir } from './configDir.js';

const savedXdg = process.env['XDG_CONFIG_HOME'];

afterEach(() => {
	if (savedXdg === undefined) {
		delete process.env['XDG_CONFIG_HOME'];
	} else {
		process.env['XDG_CONFIG_HOME'] = savedXdg;
	}
});

describe('getTaskConfigDir', () => {
	it('uses $XDG_CONFIG_HOME/task when XDG_CONFIG_HOME is set', () => {
		process.env['XDG_CONFIG_HOME'] = '/xdg';
		expect(getTaskConfigDir()).toBe(join('/xdg', 'task'));
	});

	it('falls back to ~/.config/task (also on Windows, same convention as the other CLIs)', () => {
		delete process.env['XDG_CONFIG_HOME'];
		expect(getTaskConfigDir()).toBe(join(homedir(), '.config', 'task'));
	});

	it('ignores TASK_CONFIG_DIR / TASK_CONFIG: shared-cli ConfigDir.get does not read them either', () => {
		delete process.env['XDG_CONFIG_HOME'];
		process.env['TASK_CONFIG_DIR'] = '/ignored';
		try {
			expect(getTaskConfigDir()).toBe(join(homedir(), '.config', 'task'));
		} finally {
			delete process.env['TASK_CONFIG_DIR'];
		}
	});
});

describe('getTaskLogDir', () => {
	it('is the logs folder of the given config dir (CLI invocation log, undelivered events, server errors)', () => {
		expect(getTaskLogDir(join('/cfg', 'task'))).toBe(join('/cfg', 'task', 'logs'));
	});

	it('defaults to the logs folder of the task config dir', () => {
		process.env['XDG_CONFIG_HOME'] = '/xdg';
		expect(getTaskLogDir()).toBe(join('/xdg', 'task', 'logs'));
	});
});
