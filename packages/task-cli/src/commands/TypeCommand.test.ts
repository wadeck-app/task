import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openTaskContext } from '@wadeck-app/task-service';
import type { EventSink } from '@wadeck-app/task-service';

import type { CommandEnv } from '../cli/env.js';
import { runTaskCommand } from '../TaskIndex.js';
import { runType } from './TypeCommand.js';
import { initLegacyProject } from '../testHelpers.js';

describe('task type', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-type-cmd-'));
		initLegacyProject(tmpDir);
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
		// The context was opened over a project whose .task vanished: the loader's write fails with a raw fs error.
		function envWithoutTaskDir(jsonMode: boolean): CommandEnv {
			const ctx = openTaskContext({ projectDir: tmpDir });
			fs.rmSync(path.join(tmpDir, '.task'), { recursive: true });
			return { command: 'type', jsonMode, ctx, eventSink: {} as EventSink };
		}

		for (const sub of ['add', 'remove']) {
			it(`${sub}: prints the standard "Error: <message>" without a doubled prefix`, async () => {
				const result = await runType([sub, 'bug'], envWithoutTaskDir(false));
				expect(result.exitCode).toBe(1);
				expect(result.output.startsWith('Error: ')).toBe(true);
				expect(result.output).not.toContain('Error: Error');
				expect(result.output).toContain('config.yml');
			});

			it(`${sub}: --json prints {"error": ...}`, async () => {
				const result = await runType([sub, 'bug'], envWithoutTaskDir(true));
				expect(result.exitCode).toBe(1);
				const parsed = JSON.parse(result.output) as { error: string };
				expect(parsed.error).toContain('config.yml');
				expect(parsed.error).not.toMatch(/^Error/);
			});
		}
	});
});
