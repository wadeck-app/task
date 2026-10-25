import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { apiRef, pageRef } from './projectRef.js';

describe('pageRef / apiRef: a project is named by its registry id, nothing else', () => {
	const project = { id: 'a1b2c3d4', path: path.resolve('/work/alpha') };

	it('names the project by its id in a page address and in an API query', () => {
		expect(pageRef(project)).toBe('a1b2c3d4');
		expect(apiRef(project)).toBe('a1b2c3d4');
	});

	it('never puts the directory in either', () => {
		expect(pageRef(project)).not.toContain('alpha');
		expect(apiRef(project)).not.toContain('alpha');
	});
});
