import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InvalidProjectPathError } from './errors.js';
import { assertExistingDirectory, validateProjectPath } from './projectPaths.js';

describe('validateProjectPath', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-paths-'));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('returns an absolute path as the normalised path (no trailing separator, no doubled separator)', () => {
		expect(validateProjectPath(root + path.sep)).toBe(root);
		expect(validateProjectPath(path.join(root, 'a') + path.sep + path.sep)).toBe(path.join(root, 'a'));
	});

	it.each([undefined, null, 42, {}, ''])('refuses %j: a directory is required', value => {
		expect(() => validateProjectPath(value)).toThrow(InvalidProjectPathError);
	});

	it('refuses a relative path and says it must be absolute', () => {
		expect(() => validateProjectPath('some/where')).toThrow(/not absolute/);
		try {
			validateProjectPath('some/where');
		} catch (error) {
			expect((error as InvalidProjectPathError).hint).toMatch(/absolute/);
		}
	});

	it('refuses a NUL byte', () => {
		expect(() => validateProjectPath(path.join(root, 'a\0b'))).toThrow(/NUL/);
	});

	it('refuses relative segments (. and ..) instead of resolving them silently', () => {
		expect(() => validateProjectPath(path.join(root, 'a') + path.sep + '..' + path.sep + 'b')).toThrow(
			/relative segment/
		);
		expect(() => validateProjectPath(root + path.sep + '.' + path.sep + 'b')).toThrow(/relative segment/);
		expect(() => validateProjectPath(root + '/../b')).toThrow(/relative segment/);
	});

	it('refuses leading or trailing whitespace (a pasted path), naming it', () => {
		expect(() => validateProjectPath(` ${root}`)).toThrow(/whitespace/);
		expect(() => validateProjectPath(`${root} `)).toThrow(/whitespace/);
	});

	it.runIf(process.platform === 'win32')(
		'refuses a rooted path without drive and a drive-relative one on Windows',
		() => {
			expect(() => validateProjectPath('\\temp\\x')).toThrow(InvalidProjectPathError);
			expect(() => validateProjectPath('C:temp')).toThrow(InvalidProjectPathError);
		}
	);
});

describe('assertExistingDirectory', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-paths-'));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('accepts an existing directory', () => {
		expect(() => assertExistingDirectory(root)).not.toThrow();
	});

	it('refuses a missing directory with an actionable hint', () => {
		const missing = path.join(root, 'nope');
		expect(() => assertExistingDirectory(missing)).toThrow(`directory ${missing} does not exist`);
		try {
			assertExistingDirectory(missing);
		} catch (error) {
			expect(error).toBeInstanceOf(InvalidProjectPathError);
			expect((error as InvalidProjectPathError).hint).toMatch(/Check the spelling/);
		}
	});

	it('refuses a file', () => {
		const file = path.join(root, 'f.txt');
		fs.writeFileSync(file, 'x');
		expect(() => assertExistingDirectory(file)).toThrow(`${file} is not a directory`);
	});
});
