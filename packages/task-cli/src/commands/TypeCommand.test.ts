import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openTaskContext, ownConfigFile } from '@wadeck-app/task-service';
import type { EventSink } from '@wadeck-app/task-service';

import type { CommandEnv } from '../cli/env.js';
import { runTaskCommand } from '../TaskIndex.js';
import { runType } from './TypeCommand.js';
import { type RegisteredTestProject, registerTestProject } from '../testHelpers.js';

describe('task type', () => {
	let tmpDir: string;
	let project: RegisteredTestProject;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-type-cmd-'));
		project = await registerTestProject(tmpDir);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('adds, lists and removes a type', async () => {
		expect(await runTaskCommand(['type', 'add', 'bug'], tmpDir)).toEqual({
			exitCode: 0,
			output: 'Added type: bug',
		});
		expect((await runTaskCommand(['type', 'list'], tmpDir)).output).toBe('bug');
		expect(await runTaskCommand(['type', 'remove', 'bug'], tmpDir)).toEqual({
			exitCode: 0,
			output: 'Removed type: bug',
		});
	});

	describe('when the config cannot be written', () => {
		// The context was opened over a project whose config folder then became a plain file: creating the folder for the write fails with a raw fs error naming it (same on every platform, unlike a read-only file).
		function envWithUnwritableConfig(jsonMode: boolean): CommandEnv {
			const ctx = openTaskContext({ storage: project.storage, project: { id: project.id, name: project.name } });
			const configDir = path.dirname(ownConfigFile(project.storage));
			fs.rmSync(configDir, { recursive: true, force: true });
			fs.writeFileSync(configDir, 'in the way');
			return { command: 'type', jsonMode, ctx, eventSink: {} as EventSink };
		}

		for (const sub of ['add', 'remove']) {
			it(`${sub}: prints the standard "Error: <message>" without a doubled prefix`, async () => {
				const result = await runType([sub, 'bug'], envWithUnwritableConfig(false));
				expect(result.exitCode).toBe(1);
				expect(result.output.startsWith('Error: ')).toBe(true);
				expect(result.output).not.toContain('Error: Error');
				expect(result.output).toContain(path.dirname(ownConfigFile(project.storage)));
			});

			it(`${sub}: --json prints {"error": ...}`, async () => {
				const result = await runType([sub, 'bug'], envWithUnwritableConfig(true));
				expect(result.exitCode).toBe(1);
				const parsed = JSON.parse(result.output) as { error: string };
				expect(parsed.error).toContain(path.dirname(ownConfigFile(project.storage)));
				expect(parsed.error).not.toMatch(/^Error/);
			});
		}
	});
});
