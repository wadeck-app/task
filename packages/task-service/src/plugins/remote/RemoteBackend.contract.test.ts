import { REMOTE_CAPABILITIES } from '@wadeck-app/task-core';
import { runBackendContract } from '@wadeck-app/task-core/contract';
import type { BackendFixture } from '@wadeck-app/task-core/contract';

import { startRemoteFixture } from './testHelpers.js';

// The shared backend contract (design 1.7) against the remote backend over a REAL task serve on loopback over the LOCAL backend: the
// same cases the local store passes, with the full capability set (writes, priority, assignee and claim included), unchanged. A remote
// project must be indistinguishable from a local one except for who raises the queue events (capabilities.events).
//
// One thing differs on purpose: the SERVER decides the time of a claim (protocol 2), while the claim cases of the contract name the
// instants they are judged at. The fixture therefore gives the server a clock that is set to the `now` of each claim just before it is
// sent: the server still computes `now` and the end of the lease itself, from a clock the test drives.
async function fixture(): Promise<BackendFixture> {
	let serverNow = Date.now();
	// The case "any status name is accepted" uses waiting-for-review: the server accepts the statuses of the served project's config, so it is one.
	const remote = await startRemoteFixture({
		config: { statuses: ['backlog', 'in-progress', 'done', 'waiting-for-review'] },
		now: () => new Date(serverNow),
	});
	const { backend } = remote;
	const claim = backend.claim.bind(backend);
	backend.claim = (id, input) => {
		serverNow = Date.parse(input.now);
		return claim(id, input);
	};
	return { backend, dispose: () => remote.stop() };
}

runBackendContract(
	'RemoteBackend -> task serve (plain-http, loopback) -> LocalFileBackend',
	fixture,
	REMOTE_CAPABILITIES
);
