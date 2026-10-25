import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadTaskConfig } from './projectConfig.js';
import { ownConfigFile } from './storage.js';
import { addType, listTypes, removeType } from './taskTypes.js';
import { createTestContext, type TestContext } from './testHelpers.js';

describe('task types', () => {
	let t: TestContext;
	let configPath: string;
	beforeEach(() => {
		t = createTestContext({ types: ['bug'] });
		configPath = path.join(t.rootDir, 'data', 'config.yml');
		fs.writeFileSync(
			configPath,
			['statuses:', '  - backlog', '  - done', 'types:', '  - bug', ''].join('\n'),
			'utf8'
		);
	});
	afterEach(() => t.cleanup());

	// Re-reads the project config from disk; the global config dir is an empty tmp dir so the user's real one is ignored.
	function reload() {
		return loadTaskConfig(t.ctx.storage, path.join(t.rootDir, 'global'));
	}

	function storedTypes(): string[] {
		return reload().types;
	}

	it('listTypes returns the configured types (empty when none)', () => {
		expect(listTypes(t.ctx)).toEqual(['bug']);
		expect(listTypes(createTestContext().ctx)).toEqual([]);
	});

	it('addType appends to the project config file, once, keeping the other keys', () => {
		addType(t.ctx, { name: 'feature' });
		addType(t.ctx, { name: 'feature' });

		expect(storedTypes()).toEqual(['bug', 'feature']);
		expect(reload().statuses).toEqual(['backlog', 'done']);
	});

	it('removeType removes from the project config file', () => {
		removeType(t.ctx, { name: 'bug' });

		expect(storedTypes()).toEqual([]);
	});
});
