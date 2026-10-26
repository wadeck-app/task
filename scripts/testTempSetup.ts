// Per-process vitest setup shared by every package: `import '../../scripts/testTempSetup.ts'` FIRST in vitest.setup.ts
// (before the first mkdtemp). Tracks the own-prefixed temp dirs of the process and removes what the tests left at the
// end of each test file; see testTemp.ts.
import { trackTempDirs } from './testTemp.ts';

const tracker = trackTempDirs();

afterAll(() => {
	tracker.release();
});
