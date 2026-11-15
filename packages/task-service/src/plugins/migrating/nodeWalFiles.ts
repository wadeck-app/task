// The file system under the migration journal: the node implementation of WalFiles. Appends are flushed to the disk before they
// return (the write-ahead log is how a crash is recovered); whole-file replacements go through the writer the host gives (its atomic
// writer: temp file, fsync, rename), never a plain write.
import * as fs from 'node:fs';

import type { WalFiles } from './migrationJournal.js';

export function nodeWalFiles(writeAtomic: (file: string, content: string) => void): WalFiles {
	return {
		append(file, text) {
			const handle = fs.openSync(file, 'a');
			try {
				fs.writeSync(handle, text);
				fs.fsyncSync(handle);
			} finally {
				fs.closeSync(handle);
			}
		},
		read(file) {
			try {
				return fs.readFileSync(file, 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
				throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, {
					cause: error,
				});
			}
		},
		ensureDir(dir) {
			fs.mkdirSync(dir, { recursive: true });
		},
		replace: writeAtomic,
	};
}
