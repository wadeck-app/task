import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { apiRef, pageRef, retiredRefKind } from './projectRef.js';

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

describe('retiredRefKind: the two spellings that were project references before the registry and are refused now', () => {
	it('recognises an absolute directory, POSIX or Windows, whatever the platform', () => {
		expect(retiredRefKind(path.resolve('/work/alpha'))).toBe('directory');
		expect(retiredRefKind('/work/alpha')).toBe('directory');
		expect(retiredRefKind('C:\\work\\alpha')).toBe('directory');
		expect(retiredRefKind('C:/work/alpha')).toBe('directory');
	});

	it('recognises an old page slug (directory name, a tilde, six hex digits)', () => {
		expect(retiredRefKind('alpha~0a1b2c')).toBe('slug');
		expect(retiredRefKind('my-proj_2~ffffff')).toBe('slug');
	});

	it('leaves ids, names, aliases and id prefixes to the registry', () => {
		for (const ref of [
			'a1b2c3d4',
			'a1b2',
			'alpha',
			'Shop',
			'my-alias',
			'alpha~',
			'alpha~xyz123',
			'alpha~0a1b2c3',
		]) {
			expect(retiredRefKind(ref), ref).toBeNull();
		}
	});
});
