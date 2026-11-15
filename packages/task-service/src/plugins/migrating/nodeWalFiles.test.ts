import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { nodeWalFiles } from './nodeWalFiles.js';

describe('nodeWalFiles: the journal on a disk', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('appends after what is there, flushes it, and reads it back; a missing file reads as undefined', () => {
		const written: string[] = [];
		const files = nodeWalFiles(file => written.push(file));
		const file = path.join(root, 'migrating', 'wal.ndjson');

		expect(files.read(file)).toBeUndefined();
		files.ensureDir(path.dirname(file));
		files.append(file, 'one\n');
		files.append(file, 'two\n');

		expect(files.read(file)).toBe('one\ntwo\n');
		expect(written).toEqual([]);
	});

	it('replaces a file through the host atomic writer, never a plain write', () => {
		const calls: Array<[string, string]> = [];
		const files = nodeWalFiles((file, content) => calls.push([file, content]));
		const file = path.join(root, 'wal.ndjson');

		files.replace(file, '');

		expect(calls).toEqual([[file, '']]);
	});

	it('says what it could not read, with the file name', () => {
		const files = nodeWalFiles(() => undefined);

		expect(() => files.read(root)).toThrow(root);
	});
});
