import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { getTaskConfigDir } from '@wadeck-app/task-service';

/**
 * task-service restates shared-cli's `ConfigDir.get('task')` convention (it must not depend on a CLI library),
 * while the CLI (logs, updater) uses shared-cli directly. If shared-cli changes the convention, this fails
 * instead of letting the CLI and the app-module look at two different directories (projects.json!).
 */
const savedXdg = process.env['XDG_CONFIG_HOME'];

afterEach(() => {
	if (savedXdg === undefined) {
		delete process.env['XDG_CONFIG_HOME'];
	} else {
		process.env['XDG_CONFIG_HOME'] = savedXdg;
	}
});

describe('task-service getTaskConfigDir stays equal to shared-cli ConfigDir.get("task")', () => {
	it('without XDG_CONFIG_HOME', () => {
		delete process.env['XDG_CONFIG_HOME'];
		expect(getTaskConfigDir()).toBe(ConfigDir.get('task'));
	});

	it('with XDG_CONFIG_HOME', () => {
		process.env['XDG_CONFIG_HOME'] = '/some/xdg';
		expect(getTaskConfigDir()).toBe(ConfigDir.get('task'));
	});

	it('with TASK_CONFIG_DIR set (neither side reads it)', () => {
		delete process.env['XDG_CONFIG_HOME'];
		process.env['TASK_CONFIG_DIR'] = '/ignored';
		try {
			expect(getTaskConfigDir()).toBe(ConfigDir.get('task'));
		} finally {
			delete process.env['TASK_CONFIG_DIR'];
		}
	});
});
