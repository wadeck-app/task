import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { findProjectByRef, projectSlug } from './projectRef.js';

const alpha = path.resolve('/work/alpha');
const beta = path.resolve('/work/beta');

describe('projectSlug: how a project is named in a page address (the breadcrumb prints it)', () => {
	it('is the directory name, a tilde and six hex digits of the directory', () => {
		expect(projectSlug(alpha)).toMatch(/^alpha~[0-9a-f]{6}$/);
	});

	it('only holds characters the address needs no encoding for', () => {
		expect(projectSlug(path.resolve('/work/My proj (2)/é.x'))).toMatch(/^[\w-]+~[0-9a-f]{6}$/);
	});

	it('is stable and the same for the spellings of one directory', () => {
		expect(projectSlug(alpha)).toBe(projectSlug(alpha));
		expect(projectSlug(`${alpha}${path.sep}.`)).toBe(projectSlug(alpha));
		expect(projectSlug(`${alpha}${path.sep}..${path.sep}alpha`)).toBe(projectSlug(alpha));
	});

	it('tells two directories with the same name apart', () => {
		expect(projectSlug(path.resolve('/one/task'))).not.toBe(projectSlug(path.resolve('/two/task')));
	});

	it('has a name for a directory without one (a drive root)', () => {
		expect(projectSlug(path.parse(alpha).root)).toMatch(/^project~[0-9a-f]{6}$/);
	});
});

describe('findProjectByRef: the registered project an address or a query names (one resolution for both)', () => {
	const registered = [alpha, beta];

	it('finds a project by its slug', () => {
		expect(findProjectByRef(registered, projectSlug(beta))).toBe(beta);
	});

	it('finds a project by its absolute directory (the API and older links)', () => {
		expect(findProjectByRef(registered, alpha)).toBe(alpha);
		expect(findProjectByRef(registered, `${alpha}${path.sep}.`)).toBe(alpha);
	});

	it('finds nothing for an unregistered directory, a slug nobody has, or an empty reference', () => {
		expect(findProjectByRef(registered, path.resolve('/work/gamma'))).toBeUndefined();
		expect(findProjectByRef(registered, projectSlug(path.resolve('/work/gamma')))).toBeUndefined();
		expect(findProjectByRef(registered, '')).toBeUndefined();
		expect(findProjectByRef(registered, 'alpha')).toBeUndefined();
	});
});
