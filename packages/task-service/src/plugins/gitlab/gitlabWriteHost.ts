// What the writer of the gitlab strategy (gitlabWrites.ts) needs from the backend that owns it (GitLabBackend.ts): the same reads
// the backend does for itself, so a write sees exactly what a read sees. Types only.
import type { VersionedRecord } from '@wadeck-app/task-core';

import type { DeclaredFills } from '../kinds.js';
import type { ClientResponse, GitLabClient } from './gitlabClient.js';
import type { MapContext } from './gitlabMapping.js';
import type { GitLabSettings } from './gitlabOptions.js';
import type { ApiIssue, ApiLinkedIssue } from './gitlabTypes.js';

export interface WriteHost {
	settings: GitLabSettings;
	client: GitLabClient;
	map: MapContext;
	/** The fills the project declared (`strategy.options.fills`): they decide what meta, delete and duplicateOf / causedBy do. */
	fills: DeclaredFills;
	/** `/projects/<apiId>`: the path every call starts with. */
	projectPath: string;
	/** Page of an issue on GitLab, for the hint of a refused write. */
	issueUrl: (iid: number) => string;
	/** The page that creates an issue on GitLab, for a hint. */
	newIssueUrl: string;
	/**
	 * The issue as GitLab holds it (a conditional read: `revalidate` asks GitLab even inside the cache TTL, a write re-reads before it
	 * writes); a missing or tombstoned-and-hidden id is TaskNotFoundError under the id the caller used. A tombstone is still readable.
	 */
	loadIssue: (
		id: string,
		options?: { revalidate?: boolean }
	) => Promise<{ issue: ApiIssue; response: ClientResponse<ApiIssue> }>;
	/** The whole record of an issue (what `get` answers), read again after a write. */
	readRecord: (id: string) => Promise<VersionedRecord>;
	/** The issue links of an issue, this project's only, tombstones left out (the list exists on every tier: Free has relates_to only). */
	linked: (issue: Pick<ApiIssue, 'iid' | 'project_id'>) => Promise<ApiLinkedIssue[]>;
	/** Every issue of the project (tombstones left out). */
	issuesAll: () => Promise<{ issues: ApiIssue[] }>;
}
