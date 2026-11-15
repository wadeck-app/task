import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sdk from '@wadeck-app/project-sdk';

import type { TaskBackend } from '@wadeck-app/task-core';

import { runMigration } from './migrateRun.js';
import { localSide, optionsWith, seedSource } from './migrate.testkit.js';
import type { LocalSide } from './migrate.testkit.js';

// Item 8: the id map is written on the throttle of the journal, and always flushed before the switch, on a stop and on a failure.
vi.mock('@wadeck-app/project-sdk', async importOriginal => {
	const original = await importOriginal<typeof import('@wadeck-app/project-sdk')>();
	return { ...original, writeFileAtomic: vi.fn(original.writeFileAtomic) };
});

const sides: LocalSide[] = [];
beforeEach(() => {
	vi.mocked(sdk.writeFileAtomic).mockClear();
});
afterEach(() => {
	for (const made of sides.splice(0)) fs.rmSync(made.root, { recursive: true, force: true });
});

const PROJECT_ID = 'aaaa7777';

const idMapWrites = (): number =>
	vi.mocked(sdk.writeFileAtomic).mock.calls.filter(call => path.basename(String(call[0])).startsWith('migrate-idmap'))
		.length;

function idMapOf(target: LocalSide): Array<{ from: string; to: string }> {
	return JSON.parse(fs.readFileSync(path.join(target.dataDir, 'migrate-idmap-x.json'), 'utf8')) as Array<{
		from: string;
		to: string;
	}>;
}

async function pair(failCreateAt?: number) {
	const source = localSide({ id: PROJECT_ID });
	sides.push(source);
	await seedSource(source.endpoint.backend);
	let creates = 0;
	const target = localSide({
		id: PROJECT_ID,
		wrap: (inner: TaskBackend) =>
			new Proxy(inner, {
				get(real, property, receiver) {
					if (property !== 'create') return Reflect.get(real, property, receiver) as unknown;
					return (...args: Parameters<TaskBackend['create']>) => {
						creates++;
						if (creates === failCreateAt) return Promise.reject(new Error('the target went away'));
						return real.create(...args);
					};
				},
			}),
	});
	sides.push(target);
	return { source, target };
}

function run(made: { source: LocalSide; target: LocalSide }, options = {}, now = () => 1_000) {
	return runMigration({
		source: made.source.endpoint,
		target: made.target.endpoint,
		journalDir: made.target.dataDir,
		options: optionsWith({ allowLoss: ['history'], ...options }),
		resumeCommand: 'resume',
		now,
		inPlace: {
			target: { hash: 'h', parts: {}, location: 'kind:local' },
			source: { kind: 'local', location: 'kind:local' },
			idMapFile: path.join(made.target.dataDir, 'migrate-idmap-x.json'),
			switchConfig: () => undefined,
		},
	});
}

describe('item 8: the id map follows the journal throttle', () => {
	it('creating 6 tasks within one instant rewrites the map a handful of times, not 6', async () => {
		const made = await pair();

		const result = await run(made);

		expect(result.status).toBe('completed');
		expect(idMapWrites()).toBeLessThanOrEqual(3);
		expect(idMapOf(made.target)).toHaveLength(6);
	});

	it('a failure flushes the map: it holds every task created before it, the journal agrees', async () => {
		const made = await pair(4);

		const result = await run(made);

		expect(result.status).toBe('failed');
		const journal = JSON.parse(
			fs.readFileSync(path.join(made.target.dataDir, `migrate-journal-${PROJECT_ID}-inplace.json`), 'utf8')
		) as { tasks: Record<string, { target: string }> };
		expect(idMapOf(made.target)).toEqual(
			Object.entries(journal.tasks).map(([from, entry]) => ({ from, to: entry.target }))
		);
		expect(idMapOf(made.target)).toHaveLength(3);
	});

	it('a resume repairs a map that is behind the journal (a crash between two throttled writes)', async () => {
		const made = await pair(4);
		await run(made);
		const file = path.join(made.target.dataDir, 'migrate-idmap-x.json');
		fs.writeFileSync(file, JSON.stringify(idMapOf(made.target).slice(0, 1)));

		const resumed = await run(made, { resume: true });

		expect(resumed.status).toBe('completed');
		expect(idMapOf(made.target)).toHaveLength(6);
	});

	it('the map is written before the switch', async () => {
		const made = await pair();
		let mapAtSwitch = 0;
		const result = await runMigration({
			source: made.source.endpoint,
			target: made.target.endpoint,
			journalDir: made.target.dataDir,
			options: optionsWith({ allowLoss: ['history'] }),
			resumeCommand: 'resume',
			now: () => 1_000,
			inPlace: {
				target: { hash: 'h', parts: {}, location: 'kind:local' },
				source: { kind: 'local', location: 'kind:local' },
				idMapFile: path.join(made.target.dataDir, 'migrate-idmap-x.json'),
				switchConfig: () => {
					mapAtSwitch = idMapOf(made.target).length;
				},
			},
		});

		expect(result.status).toBe('completed');
		expect(mapAtSwitch).toBe(6);
	});
});
