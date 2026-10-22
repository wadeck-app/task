import * as fs from 'node:fs';
import * as path from 'node:path';

import { InvalidProjectPathError } from './errors.js';

const ABSOLUTE_HINT = 'Give the full (absolute) path of the directory (for example C:\\work\\app or /home/me/app).';

/** A Windows path must name its drive or share: `\temp` and `C:temp` depend on the process, not on the text. */
function isFullyQualified(raw: string): boolean {
	if (!path.isAbsolute(raw)) return false;
	if (process.platform !== 'win32') return true;
	return /^[A-Za-z]:[\\/]/.test(raw) || /^[\\/]{2}[^\\/]/.test(raw);
}

/**
 * Checks a directory given by a user (UI form, CLI argument) for a project and returns it normalised
 * (`path.resolve`: single separators, no trailing one). Refuses, with the fix, whatever would otherwise be guessed:
 * not a string / empty, surrounding whitespace, a NUL byte, a relative path, `.` or `..` segments.
 * Says nothing about the disk: see {@link assertExistingDirectory}.
 */
export function validateProjectPath(raw: unknown, what = 'project directory'): string {
	if (typeof raw !== 'string' || raw === '') {
		throw new InvalidProjectPathError(`${what} must be a non-empty text`, ABSOLUTE_HINT);
	}
	if (raw.includes('\0')) {
		throw new InvalidProjectPathError(
			`${what} contains a NUL byte`,
			'Retype the path: a directory name cannot hold a NUL character.'
		);
	}
	if (raw !== raw.trim()) {
		throw new InvalidProjectPathError(
			`${what} "${raw}" starts or ends with whitespace`,
			'Remove the leading or trailing spaces (usually left by a copy-paste).'
		);
	}
	if (!isFullyQualified(raw)) {
		throw new InvalidProjectPathError(`${what} "${raw}" is not absolute`, ABSOLUTE_HINT);
	}
	if (raw.split(/[\\/]/).some(segment => segment === '.' || segment === '..')) {
		throw new InvalidProjectPathError(
			`${what} "${raw}" contains a relative segment ("." or "..")`,
			'Write the path without "." or ".." segments (the resolved, full path).'
		);
	}
	return path.resolve(raw);
}

/** Throws when `dir` is not an existing directory (missing, a file, or not readable), saying which. */
export function assertExistingDirectory(dir: string): void {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new InvalidProjectPathError(
				`directory ${dir} does not exist`,
				'Check the spelling of the path, or create the directory first.'
			);
		}
		throw new InvalidProjectPathError(
			`cannot read ${dir}: ${(error as Error).message}`,
			'Check the path and its permissions.'
		);
	}
	if (!stat.isDirectory()) {
		throw new InvalidProjectPathError(`${dir} is not a directory`, 'Give the project directory, not a file.');
	}
}
