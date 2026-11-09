import { REMOTE_CAPABILITIES } from '@wadeck-app/task-core';
import { runBackendContract } from '@wadeck-app/task-core/contract';
import type { BackendFixture } from '@wadeck-app/task-core/contract';

import { startRemoteFixture } from './testHelpers.js';

// The shared backend contract (design 1.7) against the remote backend over a REAL task serve on loopback over the LOCAL backend: the
// same cases the local store passes, with the full capability set (writes included), unchanged. A remote project must be
// indistinguishable from a local one except for who raises the queue events (capabilities.events).
async function fixture(): Promise<BackendFixture> {
	// The case "any status name is accepted" uses waiting-for-review: the server accepts the statuses of the served project's config, so it is one.
	const remote = await startRemoteFixture({
		config: { statuses: ['backlog', 'in-progress', 'done', 'waiting-for-review'] },
	});
	return { backend: remote.backend, dispose: () => remote.stop() };
}

runBackendContract(
	'RemoteBackend -> task serve (plain-http, loopback) -> LocalFileBackend',
	fixture,
	REMOTE_CAPABILITIES
);
