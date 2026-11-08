import type { TaskRecord, VersionedRecord } from '@wadeck-app/task-core';

/**
 * The record as every caller has always seen it: the backend's `revision` (opaque, for optimistic concurrency, never
 * stored) is dropped. A use case that hands a record to a caller, or spreads it into an answer, goes through here, so
 * moving to the async port changes no JSON: `task show --json`, the module routes and the events carry no `revision`
 * (noRevisionLeak.test.ts). Key order is kept.
 */
export function plain(record: VersionedRecord): TaskRecord {
	const { revision: _revision, ...stored } = record;
	return stored;
}
