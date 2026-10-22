import { TaskNotFoundError } from '@wadeck-app/task-core';
import { DanglingParentError } from '@wadeck-app/task-service';

import { errorOutput, failure, jsonResult, runJson, taskLine } from './output.js';

describe('errorOutput', () => {
	it('prints "Error: <message>" and the hint on the next line', () => {
		expect(errorOutput(false, 'boom', 'Run: fix')).toEqual({ exitCode: 1, output: 'Error: boom\nRun: fix' });
	});

	it('prints only the message without hint', () => {
		expect(errorOutput(false, 'boom')).toEqual({ exitCode: 1, output: 'Error: boom' });
	});

	it('prints {"error": message, "hint": hint} in JSON mode, so machine readers get the fix too', () => {
		expect(errorOutput(true, 'boom', 'Run: fix')).toEqual({
			exitCode: 1,
			output: '{"error":"boom","hint":"Run: fix"}',
		});
	});

	it('prints only {"error": message} in JSON mode without hint (no "hint": null)', () => {
		expect(errorOutput(true, 'boom')).toEqual({ exitCode: 1, output: '{"error":"boom"}' });
	});
});

describe('failure', () => {
	it('uses the message of the error and the hint it carries', () => {
		expect(failure(false, new DanglingParentError('t1', 'p1'))).toEqual({
			exitCode: 1,
			output: 'Error: parent "p1" of task "t1" does not exist\nFix with: task remove-parent t1',
		});
	});

	it('keeps the hint in JSON mode', () => {
		const result = failure(true, new DanglingParentError('t1', 'p1'));
		expect(JSON.parse(result.output)).toEqual({
			error: 'parent "p1" of task "t1" does not exist',
			hint: 'Fix with: task remove-parent t1',
		});
	});

	it('has no hint line for an error without hint', () => {
		expect(failure(false, new TaskNotFoundError('abc'))).toEqual({
			exitCode: 1,
			output: 'Error: Task not found: abc',
		});
	});
});

describe('runJson', () => {
	it('prints the result as indented JSON', () => {
		expect(runJson(false, () => ({ a: 1 }))).toEqual({ exitCode: 0, output: '{\n  "a": 1\n}' });
		expect(jsonResult([])).toEqual({ exitCode: 0, output: '[]' });
	});

	it('turns a thrown error into the failure answer', () => {
		const result = runJson(true, () => {
			throw new TaskNotFoundError('abc');
		});
		expect(result).toEqual({ exitCode: 1, output: '{"error":"Task not found: abc"}' });
	});
});

describe('taskLine', () => {
	it('is "  <id>  <title>  [<status>]"', () => {
		expect(taskLine({ id: 'abc', title: 'Fix', status: 'done' })).toBe('  abc  Fix  [done]');
	});
});
