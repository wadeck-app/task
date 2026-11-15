import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { TaskNotFoundError } from '@wadeck-app/task-core';
import type { ReadNotice } from '../plugins/kinds.js';
import type { ResolvedTask, TaskBackend } from '@wadeck-app/task-core';

import { localSide, optionsWith } from './migrate.testkit.js';
import type { LocalSide } from './migrate.testkit.js';
import { runMigration } from './migrateRun.js';

// The final check reads a task with `resolve` when the target says that is cheaper (GitHub): a task that cannot be read is a difference
// of its own, never an abort of the whole check, and a notice raised while reading is collected like any other.
const sides: LocalSide[] = [];
afterEach(() => {
	for (const made of sides.splice(0)) fs.rmSync(made.root, { recursive: true, force: true });
});

const CHEAP = {
	cost: { requests: 4, seconds: 3, read: { requests: 2, seconds: 1 }, resolve: { requests: 1, seconds: 0.5 } },
};

function overriding(
	resolve: (id: string, real: TaskBackend) => Promise<ResolvedTask>
): (backend: TaskBackend) => TaskBackend {
	return backend =>
		new Proxy(backend, {
			get(target, property) {
				if (property === 'resolve') return (id: string) => resolve(id, target);
				const value = Reflect.get(target, property, target) as unknown;
				return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
			},
		});
}

async function run(resolve: (id: string, real: TaskBackend) => Promise<ResolvedTask>, notices: ReadNotice[] = []) {
	const source = localSide({ id: 'aaaa1111' });
	const target = localSide({ id: 'bbbb2222', traits: CHEAP, wrap: overriding(resolve) });
	sides.push(source, target);
	target.endpoint.takeNotices = () => notices.splice(0);
	for (const title of ['One', 'Two', 'Three']) await source.endpoint.backend.create({ title, status: 'backlog' });
	return runMigration({
		source: source.endpoint,
		target: target.endpoint,
		journalDir: target.dataDir,
		options: optionsWith({ allowLoss: ['all'] }),
		resumeCommand: 'task migrate --resume',
	});
}

describe('the fields-only read of the final check', () => {
	it('a task that vanished is a difference naming the cause, and the others are still compared', async () => {
		let calls = 0;
		const result = await run((id, real) => {
			calls++;
			if (calls === 2) return Promise.reject(new TaskNotFoundError(id));
			return real.resolve(id);
		});

		expect(calls).toBe(3);
		expect(result.status).toBe('failed');
		expect(result.failure!.step).toBe('verify');
		expect(result.verification!.mismatches).toHaveLength(1);
		expect(result.verification!.mismatches[0]).toMatchObject({ field: 'read-back' });
		expect(result.verification!.mismatches[0]!.actual).toMatch(/could not be read.*not found/i);
	});

	it('any other read failure is the same kind of difference, with its message', async () => {
		const result = await run((id, real) =>
			id === '' ? real.resolve(id) : Promise.reject(new Error('socket hang up'))
		);

		expect(result.verification!.mismatches).toHaveLength(3);
		expect(result.verification!.mismatches[0]!.actual).toContain('socket hang up');
		expect(result.status).toBe('failed');
	});

	it('a notice raised by the read is collected: it reaches the warnings of the run', async () => {
		const notices: ReadNotice[] = [];
		const result = await run((id, real) => {
			notices.push({ kind: 'ignored', text: 'a related issue was ignored' });
			return real.resolve(id);
		}, notices);

		expect(result.warnings.join('\n')).toContain('target: a related issue was ignored');
	});
});
