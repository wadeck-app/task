// vitest globalSetup shared by every package (and architecture/): sweeps the stale leftovers of interrupted runs once at
// the start of a run. See testTemp.ts.
import { sweepAndReport } from './testTemp.ts';

export default function setup(): void {
	sweepAndReport();
}
