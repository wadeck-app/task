// The file system under the routing index: the node implementation of IndexFiles. Writes go through the writer the host gives (its
// atomic writer: temp file, fsync, rename), never a plain write.
import * as fs from 'node:fs';

import type { IndexFiles } from './routingIndex.js';

export function nodeIndexFiles(writeAtomic: (file: string, content: string) => void): IndexFiles {
	return {
		read(file) {
			try {
				return fs.readFileSync(file, 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
				throw new Error(
					`cannot read the routing index ${file}: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error }
				);
			}
		},
		write: writeAtomic,
		ensureDir(dir) {
			fs.mkdirSync(dir, { recursive: true });
		},
	};
}
