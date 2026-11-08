import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTaskCommand } from './TaskIndex.js';
import { registerTestProject } from './testHelpers.js';
import type { RegisteredTestProject } from './testHelpers.js';

// The context of a command holds its backend: the command releases it once, whatever the outcome (design 3A.3, lifecycle).
const probe = vi.hoisted(() => ({
	disposers: [] as Array<ReturnType<typeof vi.fn>>,
	failWith: undefined as string | undefined,
}));

vi.mock('@wadeck-app/task-service', async importOriginal => {
	const actual = await importOriginal<typeof import('@wadeck-app/task-service')>();
	return {
		...actual,
		openResolvedProject: (...args: Parameters<typeof actual.openResolvedProject>) => {
			const ctx = actual.openResolvedProject(...args);
			const dispose = vi.fn(async () => {
				await ctx.dispose?.();
				if (probe.failWith !== undefined) throw new Error(probe.failWith);
			});
			probe.disposers.push(dispose);
			return { ...ctx, dispose };
		},
	};
});

let tmpDir: string;
let project: RegisteredTestProject;
let stderr: string[];

beforeEach(async () => {
	probe.disposers.length = 0;
	probe.failWith = undefined;
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-index-test-'));
	project = await registerTestProject(path.join(tmpDir, 'shop'));
	stderr = [];
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the context of a command is disposed', () => {
	it('once after a command that succeeds', async () => {
		const result = await runTaskCommand(['new', 'first'], project.dir);

		expect(result.exitCode).toBe(0);
		expect(probe.disposers).toHaveLength(1);
		expect(probe.disposers[0]).toHaveBeenCalledTimes(1);
	});

	it('once after a command that fails', async () => {
		const result = await runTaskCommand(['show', 'nope'], project.dir);

		expect(result.exitCode).toBe(1);
		expect(probe.disposers).toHaveLength(1);
		expect(probe.disposers[0]).toHaveBeenCalledTimes(1);
	});

	it('a dispose that fails does not change the result, and is reported on stderr with where to look', async () => {
		const plain = await runTaskCommand(['list', '--json'], project.dir);
		stderr.length = 0;
		probe.failWith = 'release failed';

		const result = await runTaskCommand(['list', '--json'], project.dir);

		expect(result).toEqual(plain);
		expect(stderr.join('')).toBe(
			`warning: could not release the storage of project ${project.name}: release failed (task cli logs has the details)\n`
		);
	});
});
