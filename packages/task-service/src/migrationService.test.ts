import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BackendRejectedError } from '@wadeck-app/task-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openMigration, openMigrationControl } from './migrationService.js';
import { openTaskContext } from './openContext.js';

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const open = (strategy: string) => {
	const configFile = path.join(root, 'config', 'config.yml');
	fs.mkdirSync(path.dirname(configFile), { recursive: true });
	fs.writeFileSync(configFile, strategy, 'utf8');
	return openTaskContext({
		storage: { dataDir: path.join(root, 'data'), configFiles: [configFile] },
		globalConfigDir: path.join(root, 'global'),
		project: { name: 'shop', path: root },
	});
};

describe('openMigration', () => {
	it('gives the migration of a project whose strategy is migrating', async () => {
		const ctx = open(
			'strategy:\n    type: migrating\n    options:\n        current: { type: local }\n        new: { type: local }\n'
		);

		const migration = await openMigration(ctx);

		expect(migration.dir).toBe(path.join(root, 'data', 'migrating'));
		await ctx.dispose?.();
	});

	it('refuses a project with another strategy, naming it and the section to write', async () => {
		const ctx = open('');

		let caught: unknown;
		try {
			await openMigration(ctx);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(BackendRejectedError);
		expect((caught as BackendRejectedError).message).toContain('"local"');
		expect((caught as BackendRejectedError).message).toContain('not "migrating"');
		expect((caught as BackendRejectedError).hint).toContain('type: migrating');
		expect((caught as BackendRejectedError).hint).toContain('current');
		await ctx.dispose?.();
	});

	it('refuses a context that cannot open its strategy instance, saying it is a bug of the caller', async () => {
		const ctx = open('');
		const { openStrategyInstance: _omitted, ...handBuilt } = ctx;
		void _omitted;

		await expect(openMigration(handBuilt)).rejects.toThrow(/bug of the caller/);
		await ctx.dispose?.();
	});
});

describe('openMigrationControl', () => {
	it('points at the migrating folder of the data folder, on this machine', () => {
		const { input, control } = openMigrationControl({ dataDir: path.join(root, 'data'), configFiles: [] });

		expect(control.status(input)).toMatchObject({ started: false });
		expect(input.dir).toBe(path.join(root, 'data', 'migrating'));
		expect(input.host).toBe(os.hostname());
		expect(input.isAlive(process.pid)).toBe(true);
	});
});
