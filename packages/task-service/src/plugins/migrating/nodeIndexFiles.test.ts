import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProjectWriteLock } from '@wadeck-app/task-core';

import { nodeIndexFiles } from './nodeIndexFiles.js';
import { RoutingIndex } from './routingIndex.js';

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-service-open-'));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('nodeIndexFiles: the index on the real file system', () => {
	it('reads a missing file as absent', () => {
		expect(nodeIndexFiles(() => undefined).read(path.join(root, 'migrating', 'index.json'))).toBeUndefined();
	});

	it('names the file when it cannot be read for another reason', () => {
		const directory = path.join(root, 'index.json');
		fs.mkdirSync(directory);

		expect(() => nodeIndexFiles(() => undefined).read(directory)).toThrow(directory);
	});

	it('creates the folder, then writes through the writer it was given (the host atomic writer)', () => {
		const written: Array<[string, string]> = [];
		const files = nodeIndexFiles((file, content) => {
			written.push([file, content]);
			fs.writeFileSync(file, content);
		});
		const file = path.join(root, 'migrating', 'index.json');

		files.ensureDir(path.dirname(file));
		files.write(file, 'x');

		expect(written).toEqual([[file, 'x']]);
		expect(files.read(file)).toBe('x');
	});

	it('works under a RoutingIndex with the real lock: a change is on disk, and no lock file is left behind', () => {
		const file = path.join(root, 'migrating', 'index.json');
		const index = new RoutingIndex({
			file,
			files: nodeIndexFiles((target, content) => fs.writeFileSync(target, content)),
			lock: new ProjectWriteLock(path.join(root, 'migrating', 'index.lock')),
		});

		index.mutate(() => [{ publicId: 'n1', b: '1', state: 'in-b', since: '2026-11-15T10:00:00.000Z', version: 1 }]);

		expect(JSON.parse(fs.readFileSync(file, 'utf8')).rows).toHaveLength(1);
		expect(index.snapshot().byB('1')?.publicId).toBe('n1');
		expect(fs.existsSync(path.join(root, 'migrating', 'index.lock'))).toBe(false);
	});
});
