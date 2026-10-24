import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadRegistry } from '@wadeck-app/project-sdk';
import * as sdk from '@wadeck-app/project-sdk';

import { openTaskContext } from './openContext.js';
import { legacyStorage, ownConfigFile, registryStorage } from './storage.js';
import { addType, removeType } from './taskTypes.js';
import { createSharedRegistrySandbox } from './testHelpers.js';
import type { SharedRegistrySandbox } from './testHelpers.js';

// Spy on the SDK's atomic write while keeping its behaviour: the files must go through it.
vi.mock('@wadeck-app/project-sdk', async importOriginal => {
	const original = await importOriginal<typeof import('@wadeck-app/project-sdk')>();
	return { ...original, writeFileAtomic: vi.fn(original.writeFileAtomic) };
});

let sandbox: SharedRegistrySandbox;

beforeEach(() => {
	sandbox = createSharedRegistrySandbox();
	// mockReset (vitest config) clears the implementation: put the real one back.
	vi.mocked(sdk.writeFileAtomic).mockClear();
});

afterEach(() => {
	sandbox.cleanup();
});

function writtenFiles(): string[] {
	return vi.mocked(sdk.writeFileAtomic).mock.calls.map(call => path.basename(String(call[0])));
}

describe('task data goes through the SDK writeFileAtomic', () => {
	it('a registry project: the task file, task-index.json and config.yml', async () => {
		const project = await sandbox.register('shop', sandbox.dir('shop'));
		const storage = registryStorage(loadRegistry(sandbox.registryDir), sandbox.registryDir, project);
		const ctx = openTaskContext({ storage, project: { id: project.id, name: 'shop' } });

		const task = ctx.store.create('atomic', 'backlog');
		addType(ctx, { name: 'bug' });

		expect(writtenFiles()).toEqual([`${task.id}.json`, 'task-index.json', 'config.yml']);
		expect(fs.readFileSync(path.join(storage.dataDir, 'tasks', `${task.id}.json`), 'utf8')).toContain('"atomic"');
		expect(fs.readFileSync(ownConfigFile(storage), 'utf8')).toContain('bug');
		// No temp file is left behind.
		expect(fs.readdirSync(path.join(storage.dataDir, 'tasks')).every(name => name.endsWith('.json'))).toBe(true);
		removeType(ctx, { name: 'bug' });
		expect(writtenFiles()).toHaveLength(4);
	});

	it('a legacy project too (same writer, same files)', () => {
		const dir = sandbox.dir('legacy', { task: true });
		const ctx = openTaskContext({ storage: legacyStorage(dir), project: { name: 'legacy', path: dir } });

		const task = ctx.store.create('atomic', 'backlog');

		expect(writtenFiles()).toEqual([`${task.id}.json`, 'task-index.json']);
	});
});
